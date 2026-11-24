# Fama worker

The worker turns a source (link, file or pasted text) into narrated audio: one AAC `.m4a` per chapter and one `.m4b` book file with chapter marks, title, author and cover. It runs on a Mac (Apple GPU through MPS), in Docker, and on Modal (CUDA). Terms follow `../CONTEXT.md`. The HTTP contract is `../docs/api.md`.

## Install

You need [uv](https://docs.astral.sh/uv/) and ffmpeg (`brew install ffmpeg`).

```bash
cd worker
uv sync
```

The first run of each voice downloads its model from Hugging Face: Kokoro is about 330 MB, a Piper voice about 63 MB.

## Commands

```bash
uv run fama make https://is.wikipedia.org/wiki/Reykjav%C3%ADk      # language detected, default voice
uv run fama make book.epub --voice kokoro:bm_george --speed 1.1 --out out
uv run fama make paper.pdf
pbpaste | uv run fama make -                                        # pasted text
uv run fama voices                                                  # all voices, defaults marked
uv run fama work --api http://localhost:8787 --token dev-worker-token  # pull jobs (FAMA_WORKER_TOKEN)
uv run fama work --api http://localhost:8787 --token dev-worker-token --drain  # until the queue is empty
```

`fama make` writes:

```
out/<slug>/chapters/000.m4a ...
out/<slug>/chapters/000.json ... (timing file: when the voice reads each Segment)
out/<slug>/book.m4b
out/<slug>/cover.jpg        (when the source has one)
out/<slug>/episode.json     (title, language, voice, chapter durations)
```

`fama work` loops: claim a job (with the worker token, `FAMA_WORKER_TOKEN` on the API), send its lease token on every job call, send progress at least every 30 seconds, upload each chapter as soon as it is encoded, then the book, then complete. A `409` drops the job. Chapters listed in `completedChapters` are not uploaded again. The first attempt extracts the source and uploads the Document. A claim with `documentPath` has a stored Document: the worker reads it (and the cover at `coverPath`) and does not extract again. `--once` stops after one job or an empty queue. `--drain` takes jobs until `claim` returns nothing, then stops. The cloud worker runs `--drain`.

Settings:

| Variable | Default | Meaning |
|---|---|---|
| `FAMA_DEVICE` | `auto` | `cuda`, `mps` or `cpu`. `auto` picks the first one present in that order. |
| `FAMA_CACHE_DIR` | `~/.cache/fama/chunks` | Synthesized chunks, as 16-bit FLAC. |

## How it works

`extract` (Source to Document) → `chunk` (one Segment for each sentence, never across a paragraph) → `normalize` each Segment (numbers, abbreviations, URLs, footnotes) → `synthesize` (one call for each Segment, through the chunk cache) → `encode` (one `.m4a` and one timing file per chapter) → `assemble` (one `.m4b`, no re-encode).

- A Segment has two texts: the Document text, which goes to the timing file, and the normalized text, which the engine reads. A sentence under 20 characters joins the next one. `BAKEOFF.md` has the cost of one call for each sentence.
- The chunk cache key is `sha256(text, engine, voice, model version, speed)`, with the text the engine reads. A re-run or a retried job only synthesizes Segments it has not made before.
- `engines/__init__.py` holds the two tables: `ENGINES` (name to engine) and `DEFAULT_VOICE` (language to voice). To add an engine, write a class with `name`, `model_version`, `max_chars`, `voices()` and `synthesize(text, voice_id, speed)`, and add one line to `ENGINES`.
- Defaults come from the bakeoff in `BAKEOFF.md`: `kokoro:af_heart` for English, `piper:is_IS-steinn-medium` for Icelandic.

## Docker

For a server you run yourself. Build from the repo root:

```bash
docker build -t fama-worker worker
docker run -d --restart unless-stopped -v fama-cache:/cache fama-worker \
  --api https://fama.example.com --token "$FAMA_WORKER_TOKEN"
```

Add `--gpus all` on a Linux host with an NVIDIA GPU. Without a GPU the worker runs on the CPU, which is slow for long books. On a Mac, run the worker natively (MPS) instead. Model weights download on the first job of each voice and stay in the `fama-cache` volume.

## Cloud worker on Modal

`modal_app.py` runs the worker on a Modal GPU. Nothing runs while the queue is empty.

- `wake`: a POST web endpoint. The API calls it after a create, upload or retry. The call must carry `Authorization: Bearer <WORKER_WAKE_SECRET>`, else `401`. It returns `202 {"dispatch": "start" | "idle" | "follow-up" | "skip"}`.
- `sweep`: a cron every 5 minutes. It does the same as a wake.
- `drain`: the GPU function (`GPU = "L4"`). It runs `fama work --drain` and exits when the queue is empty. Modal stops the container 30 seconds later.

Both `wake` and `sweep` call one dispatcher. It reads the stats of `drain` and does one of four things:

| Result | When | Action |
|---|---|---|
| `start` | no drain runs or waits | Claim one job on the CPU (`voices: []`), then spawn `drain` with that job and worker id. |
| `idle` | as `start`, but claim returns `204` | Nothing. No GPU starts. |
| `follow-up` | a drain runs, none waits | Spawn one `drain` that waits behind it. It covers an episode that lands just after the running drain saw an empty queue. |
| `skip` | a drain waits | Nothing. The waiting drain will claim the work. |

Modal runs at most `MAX_DRAINS` (1) drains at once. The CPU claim keeps the sweep cheap: a sweep of an empty queue costs one small CPU call, not a GPU cold start.

The sweep covers a missed wake and an expired lease. The API offers a `Running` job again when its heartbeat is older than `LEASE_MS` (10 minutes): see `claim` in `apps/api/src/job.ts` and the candidate query in `EpisodeRepo.claim` (`apps/api/src/episode-repo.ts`). So a drain that crashes, times out (6 hours) or is preempted leaves a lease that expires. A sweep at most 5 minutes later starts a new drain. That drain claims the job and skips the chapters in `completedChapters`.

The image installs the worker with uv and ffmpeg. It bakes all Kokoro voices and the four Icelandic Piper voices, so a cold start downloads nothing. At build time it makes two short episodes on the CPU (English with Kokoro, Icelandic with Piper). A broken image fails the deploy. Piper runs on the CPU: `onnxruntime` from PyPI has no CUDA provider, so Piper falls back to it. Kokoro runs on the GPU.

### Deploy

You need a Modal account. Run from `worker/`:

```bash
uv run --group modal modal setup        # once: sign in, stores a Modal token
export WORKER_WAKE_SECRET=$(openssl rand -hex 32)
uv run --group modal modal secret create fama \
  FAMA_API_URL=https://fama.example.com \
  FAMA_WORKER_TOKEN=<the worker token of the API> \
  WORKER_WAKE_SECRET="$WORKER_WAKE_SECRET"
uv run --group modal modal deploy modal_app.py
```

`modal deploy` prints the wake URL: `https://<workspace>--fama-worker-wake.modal.run`. Give the API two values:

| API variable | Value |
|---|---|
| `WORKER_WAKE_URL` | the wake URL from `modal deploy` |
| `WORKER_WAKE_SECRET` | the same `WORKER_WAKE_SECRET` as in the Modal Secret |

Modal does not show a secret value again, so set `WORKER_WAKE_SECRET` on the API from the same shell. Test the wake:

```bash
curl -i -X POST -H "Authorization: Bearer $WORKER_WAKE_SECRET" https://<workspace>--fama-worker-wake.modal.run
```

To change a value, run `modal secret create fama ... --force` with all three values, then `modal deploy modal_app.py` again.

### Measure GPU seconds per hour of audio

Pricing needs this number. The worker logs two lines for it:

```
[fama work] <episode>: ready, 3612s audio in 14 chapters, 118s wall
[fama work] drained 3 jobs, 7410s audio in 251s wall
```

Modal bills the whole container life: cold start, the drain, and the 30 idle seconds before it stops. So use Modal's numbers for the cost, and the log for the audio.

1. Start with an empty queue. Submit a known set: short English articles, one Icelandic article, one long EPUB.
2. Wait until the queue is empty and the `drain` container has stopped.
3. Audio: `uv run --group modal modal app logs fama-worker | grep drained`. Add the audio seconds of every `drained` line in the window.
4. GPU time: in the Modal dashboard, open the `fama-worker` app, then the `drain` function. Read the container seconds (GPU time) for the window from its usage view.
5. GPU seconds per hour of audio = GPU seconds / (audio seconds / 3600).

The `wall` figures show the cost of a warm container alone. The gap between them and Modal's number is cold start plus idle time. Do one run with Kokoro and one with Piper, because Piper runs on the CPU. Change `GPU` in `modal_app.py` (for example `"T4"`) and measure again to compare price per hour of audio.

## Tests

```bash
uv run pytest
```

The tests cover extraction (built EPUB and PDF fixtures, article markdown, Gutenberg text), normalization, Segments, timing files, cache keys, re-run idempotency, the `.m4b` layout (ffprobe), `fama work` against a fake API server (the full run, a `409` drop, a resume with `completedChapters`, a failed job, a retry from the stored Document, `--drain`), the drain loop, and the pure parts of `modal_app.py` (dispatch plan, wake secret, baked weights) without Modal installed.

## Bakeoff

```bash
uv run --group bakeoff python bakeoff/run.py           # all candidates, Apple Silicon only
uv run --group bakeoff python bakeoff/run.py --only is
```

Samples go to `~/Developer/fama-samples/<lang>/<engine>-<voice>.m4a`. Results go to `bakeoff/results.json`. See `BAKEOFF.md`.

## Licenses

See `NOTICE.md`. The worker code is MIT. `piper-tts` (GPL-3.0) and `PyMuPDF` (AGPL-3.0) are copyleft dependencies.
