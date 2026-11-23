"""Fama cloud worker on Modal: makes episodes on a GPU, woken by the API, scales to zero.

    uv run --group modal modal deploy modal_app.py

Three functions share one dispatcher:

- `wake`: POST web endpoint. The API calls it after a create, upload or retry.
- `sweep`: a 5-minute cron. It covers a missed wake and a job whose lease expired
  (the API offers a `Running` job again on claim when its heartbeat is 10 minutes old).
- `drain`: the GPU function. It runs `fama work --drain`: take jobs until claim returns
  nothing, then exit. Modal then stops the container, so an idle queue costs nothing.

The dispatcher starts `drain` only when no drain is waiting to start, and Modal runs at
most `MAX_DRAINS` at once. See `plan_drain`. Before it starts a GPU, it claims one job on
the CPU and hands it to the drain, so a sweep of an empty queue starts no GPU.

Settings come from the Modal Secret `fama`: `FAMA_API_URL`, `FAMA_WORKER_TOKEN` and
`WORKER_WAKE_SECRET`. See README.md, "Cloud worker on Modal".
"""

from __future__ import annotations

import hmac
import os
import shlex
import uuid
from collections.abc import Callable
from pathlib import Path

import modal

APP_NAME = "fama-worker"
SECRET_NAME = "fama"
MAX_DRAINS = 1  # concurrent GPU drains; each one takes jobs one after the other
GPU = "L4"
DRAIN_TIMEOUT_S = 6 * 60 * 60  # a drain cut off mid-job leaves an expired lease; the next drain resumes it
SCALEDOWN_S = 30  # idle seconds before Modal stops a drain container
SWEEP_SCHEDULE = "*/5 * * * *"
UV_VERSION = "0.12.11"  # same as mise.toml

# Model weights baked into the image, so a cold start does not download them.
# tests/test_modal_app.py checks these against the engines.
KOKORO_REPO = "hexgrad/Kokoro-82M"
KOKORO_FILES = ["config.json", "kokoro-v1_0.pth", "voices/*.pt"]
PIPER_REPO = "rhasspy/piper-voices"
PIPER_REVISION = "04ca88f5685ca5253c701af3687e155b113bd512"
PIPER_VOICES = [
    "is/is_IS/salka/medium/is_IS-salka-medium",
    "is/is_IS/ugla/medium/is_IS-ugla-medium",
    "is/is_IS/bui/medium/is_IS-bui-medium",
    "is/is_IS/steinn/medium/is_IS-steinn-medium",
]


def plan_drain(queued: int, running: int, cap: int = MAX_DRAINS) -> str:
    """What one wake or sweep does, from the drain function's current stats.

    - `skip`: a drain is already waiting to start. It will claim the new work.
    - `start`: a slot is free. Start a drain now.
    - `follow-up`: every slot is busy. Queue one drain behind them. A busy drain can see an
      empty queue a moment before a new episode lands; without the follow-up, that episode
      waits for the next sweep. Modal starts the follow-up when a slot frees up.
    """
    if queued > 0:
        return "skip"
    return "start" if running < cap else "follow-up"


def authorized(header: str | None, secret: str) -> bool:
    """The wake call carries `Authorization: Bearer <WORKER_WAKE_SECRET>`."""
    return bool(secret) and hmac.compare_digest((header or "").encode(), f"Bearer {secret}".encode())


def claim_on_cpu(api_url: str, token: str, worker_id: str, transport=None) -> dict | None:
    """Claim one job without a GPU: the raw `ClaimedJob`, or None when the queue is empty.

    An empty voice list leaves the voice registry as it is; the drain registers the voices.
    """
    import httpx

    with httpx.Client(base_url=api_url.rstrip("/"), transport=transport, timeout=30,
                      headers={"Authorization": f"Bearer {token}"}) as client:
        response = client.post("/api/worker/claim", json={"workerId": worker_id, "voices": []})
    response.raise_for_status()
    return None if response.status_code == 204 else response.json()["job"]


def dispatch(drain_function, claim: Callable[[str], dict | None]) -> str:
    """Run the plan. Returns it, or `idle` when a start found the queue empty."""
    stats = drain_function.get_current_stats()
    plan = plan_drain(stats.backlog, stats.num_running_inputs)
    if plan == "follow-up":
        drain_function.spawn()
    elif plan == "start":
        worker_id = f"modal-{uuid.uuid4().hex[:12]}"
        job = claim(worker_id)
        if job is None:
            plan = "idle"
        else:
            drain_function.spawn(job, worker_id)
    print(f"[fama dispatch] {plan} (queued {stats.backlog}, running {stats.num_running_inputs})", flush=True)
    return plan


def _dispatch() -> str:
    api_url, token = os.environ["FAMA_API_URL"], os.environ["FAMA_WORKER_TOKEN"]
    return dispatch(drain, lambda worker_id: claim_on_cpu(api_url, token, worker_id))


def _bake_command() -> str:
    script = (
        "from huggingface_hub import snapshot_download\n"
        f"snapshot_download({KOKORO_REPO!r}, allow_patterns={KOKORO_FILES!r})\n"
        f"snapshot_download({PIPER_REPO!r}, revision={PIPER_REVISION!r}, "
        f"allow_patterns={[f'{voice}.onnx*' for voice in PIPER_VOICES]!r})\n"
    )
    return f"python -c {shlex.quote(script)}"


HERE = Path(__file__).parent

worker_image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("ffmpeg")  # chapter encoding and book assembly; espeak-ng ships inside piper-tts and espeakng-loader
    .pip_install(f"uv=={UV_VERSION}")
    .env({
        # The image's own Python, which Modal runs. `--inexact` keeps what uv did not install (uv itself).
        "UV_PROJECT_ENVIRONMENT": "/usr/local",
        "UV_PYTHON_DOWNLOADS": "never",
        "UV_COMPILE_BYTECODE": "1",
        "UV_LINK_MODE": "copy",
        "PYTHONUTF8": "1",
        "HF_HOME": "/models/hf",
        "FTLANG_CACHE": "/models/fasttext",
        "FAMA_CACHE_DIR": "/tmp/fama/chunks",
    })
    # Dependencies and weights first: a code change rebuilds only the last layers.
    .add_local_file(HERE / "pyproject.toml", "/app/pyproject.toml", copy=True)
    .add_local_file(HERE / "uv.lock", "/app/uv.lock", copy=True)
    .run_commands("cd /app && uv sync --frozen --inexact --no-dev --no-install-project")
    .run_commands(_bake_command())
    .add_local_file(HERE / "README.md", "/app/README.md", copy=True)
    .add_local_dir(HERE / "src", "/app/src", copy=True)
    .run_commands(
        "cd /app && uv sync --frozen --inexact --no-dev --no-editable",
        # Smoke test on CPU: fails the deploy if the image cannot make audio. It also caches
        # the language model (English is detected) and anything else the engines fetch.
        "printf 'Fama is ready to read to you.' | fama make - --out /tmp/smoke",
        "printf 'Fama er tilbúin að lesa fyrir þig.' | fama make - --language is"
        " --voice piper:is_IS-steinn-medium --out /tmp/smoke",
        "rm -rf /tmp/smoke /tmp/fama",
    )
)

dispatch_image = modal.Image.debian_slim(python_version="3.12").pip_install("fastapi[standard]>=0.115", "httpx>=0.27")

with dispatch_image.imports():
    from fastapi import Request
    from fastapi.responses import JSONResponse

app = modal.App(APP_NAME)
secret = modal.Secret.from_name(SECRET_NAME)


@app.function(image=worker_image, gpu=GPU, secrets=[secret], timeout=DRAIN_TIMEOUT_S,
              max_containers=MAX_DRAINS, scaledown_window=SCALEDOWN_S)
def drain(job: dict | None = None, worker_id: str | None = None) -> None:
    """`fama work --drain` on the GPU. `job` is one the dispatcher claimed as `worker_id`."""
    from fama_worker.api import ClaimedJob
    from fama_worker.work import run

    worker_id = worker_id or f"modal-{os.environ.get('MODAL_TASK_ID', 'drain')}"
    run(os.environ["FAMA_API_URL"], os.environ["FAMA_WORKER_TOKEN"], worker_id,
        out_dir=Path("/tmp/fama/work"), drain=True, first_job=ClaimedJob.parse(job) if job else None)


@app.function(image=dispatch_image, secrets=[secret])
@modal.fastapi_endpoint(method="POST")
def wake(request: Request):
    if not authorized(request.headers.get("authorization"), os.environ.get("WORKER_WAKE_SECRET", "")):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    return JSONResponse({"dispatch": _dispatch()}, status_code=202)


@app.function(image=dispatch_image, secrets=[secret], schedule=modal.Cron(SWEEP_SCHEDULE))
def sweep() -> None:
    _dispatch()
