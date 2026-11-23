"""The pure parts of modal_app.py, loaded with a stand-in `modal` module (no Modal install, no account)."""

import contextlib
import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from fama_worker.engines import kokoro, piper


class _AnyModal:
    """Every attribute and call returns itself; used as a decorator, it returns the function."""

    def __getattr__(self, name):
        return self

    def __call__(self, *args, **kwargs):
        if len(args) == 1 and not kwargs and callable(args[0]) and not isinstance(args[0], _AnyModal):
            return args[0]
        return self

    def imports(self):
        return contextlib.suppress(ImportError)


@pytest.fixture(scope="module")
def modal_app():
    stub = _AnyModal()
    saved = sys.modules.get("modal")
    sys.modules["modal"] = stub  # type: ignore[assignment]
    try:
        path = Path(__file__).parents[1] / "modal_app.py"
        spec = importlib.util.spec_from_file_location("fama_modal_app", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    finally:
        if saved is None:
            sys.modules.pop("modal", None)
        else:
            sys.modules["modal"] = saved
    return module


@pytest.mark.parametrize(("queued", "running", "plan"), [
    (0, 0, "start"),       # idle: start a drain
    (0, 1, "follow-up"),   # a drain runs: queue one behind it for work it may have just missed
    (1, 1, "skip"),        # one already waits behind it
    (1, 0, "skip"),        # just spawned, not started yet
])
def test_plan_drain_with_one_slot(modal_app, queued, running, plan):
    assert modal_app.plan_drain(queued, running, cap=1) == plan


def test_plan_drain_fills_a_free_slot(modal_app):
    assert modal_app.plan_drain(0, 1, cap=2) == "start"


def test_concurrency_cap_is_one(modal_app):
    assert modal_app.MAX_DRAINS == 1


class FakeDrain:
    def __init__(self, backlog, running):
        self.stats = SimpleNamespace(backlog=backlog, num_running_inputs=running, num_total_runners=running)
        self.spawned = 0

    def get_current_stats(self):
        return self.stats

    def spawn(self):
        self.spawned += 1


@pytest.mark.parametrize(("backlog", "running", "spawned"), [(0, 0, 1), (0, 1, 1), (1, 1, 0)])
def test_dispatch_spawns_by_plan(modal_app, backlog, running, spawned):
    drain = FakeDrain(backlog, running)
    modal_app.dispatch(drain)
    assert drain.spawned == spawned


def test_wake_needs_the_bearer_secret(modal_app):
    assert modal_app.authorized("Bearer s3cret", "s3cret")
    assert not modal_app.authorized("Bearer wrong", "s3cret")
    assert not modal_app.authorized("s3cret", "s3cret")
    assert not modal_app.authorized(None, "s3cret")
    assert not modal_app.authorized("Bearer ", "")  # no secret set: refuse every call


def test_baked_weights_match_the_engines(modal_app):
    assert modal_app.KOKORO_REPO == kokoro.REPO
    assert modal_app.PIPER_REPO == piper.REPO
    assert modal_app.PIPER_REVISION == piper.REVISION
    assert modal_app.PIPER_VOICES == [piper._hub_path(voice) for voice in piper._LISTED]


def test_uv_version_matches_mise(modal_app):
    mise = (Path(__file__).parents[2] / "mise.toml").read_text()
    assert f'uv = "{modal_app.UV_VERSION}"' in mise
