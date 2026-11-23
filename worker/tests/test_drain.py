"""`fama work --drain`: take jobs until claim returns nothing, then stop."""

import threading

import pytest

from fama_worker import cli, work
from fama_worker.api import ApiError


class QueueApi:
    """Stands in for the API client: claim pops jobs off a list, then returns None."""

    def __init__(self, *jobs, fail_claim: bool = False):
        self.jobs = list(jobs)
        self.claims = 0
        self.fail_claim = fail_claim

    def claim(self, voices):
        self.claims += 1
        if self.fail_claim:
            raise ApiError("POST /api/worker/claim -> 503")
        return self.jobs.pop(0) if self.jobs else None


def _run(api, tmp_path, timeout=5.0, **mode):
    """Run the loop in a thread, so a loop that never ends fails the test instead of hanging it."""
    stop = threading.Event()
    thread = threading.Thread(target=work.run, args=("http://api", "token", "w"),
                              kwargs={"out_dir": tmp_path, "stop": stop, "api": api, **mode})
    thread.start()
    thread.join(timeout=timeout)
    ended = not thread.is_alive()
    stop.set()
    thread.join()
    return ended


@pytest.fixture
def made(tone, monkeypatch):
    jobs = []
    monkeypatch.setattr(work, "process", lambda api, job, out_dir: jobs.append(job) or 60_000)
    return jobs


def test_drain_takes_every_job_then_stops(made, tmp_path):
    api = QueueApi("a", "b", "c")
    assert _run(api, tmp_path, drain=True)
    assert made == ["a", "b", "c"]
    assert api.claims == 4


def test_drain_on_an_empty_queue_stops_after_one_claim(made, tmp_path):
    api = QueueApi()
    assert _run(api, tmp_path, drain=True)
    assert made == [] and api.claims == 1


def test_drain_stops_when_claim_fails(made, tmp_path):
    api = QueueApi("a", fail_claim=True)
    assert _run(api, tmp_path, drain=True)
    assert made == [] and api.claims == 1


def test_once_still_stops_after_one_job(made, tmp_path):
    api = QueueApi("a", "b")
    assert _run(api, tmp_path, once=True)
    assert made == ["a"] and api.claims == 1


def test_without_a_mode_the_loop_keeps_polling(made, tmp_path):
    assert not _run(QueueApi("a"), tmp_path, timeout=0.5)
    assert made == ["a"]


def test_cli_passes_drain(monkeypatch, tmp_path):
    seen = {}
    monkeypatch.setattr(work, "run", lambda *args, **kwargs: seen.update(kwargs))
    cli.main(["work", "--api", "http://api", "--token", "t", "--out", str(tmp_path), "--drain"])
    assert seen["drain"] is True and seen["once"] is False


def test_cli_rejects_once_with_drain(capsys):
    with pytest.raises(SystemExit):
        cli.main(["work", "--api", "http://api", "--token", "t", "--once", "--drain"])
    assert "not allowed with" in capsys.readouterr().err


def test_drain_makes_the_first_job_before_it_claims(made, tmp_path):
    api = QueueApi("b")
    assert _run(api, tmp_path, drain=True, first_job="a")
    assert made == ["a", "b"] and api.claims == 2
