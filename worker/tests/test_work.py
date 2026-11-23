"""`fama work` against a fake API that follows docs/api.md."""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest

from fama_worker import work

TOKEN = "secret"
TEXT = "\n\n".join(f"CHAPTER {i}\n\n" + "Words in this part of the story. " * 20 for i in range(1, 4))


class FakeApi:
    def __init__(self, job: dict):
        self.job = job
        self.lease: str | None = None  # the lease token of the current claim
        self.claims = 0
        self.leases: list[tuple[str, str | None]] = []  # (path, lease token sent) of every job call
        self.calls: list[tuple[str, str]] = []
        self.chapters: dict[int, dict] = {}
        self.book: bytes | None = None
        self.state = "Queued"
        self.steal_after_chapter: int | None = None
        self.progress: list[dict] = []

    def handle(self, request: BaseHTTPRequestHandler) -> tuple[int, bytes]:
        url = urlparse(request.path)
        query = {k: v[0] for k, v in parse_qs(url.query).items()}
        length = request.headers.get("Content-Length")
        body = request.rfile.read(int(length)) if length else b""
        self.calls.append((request.command, url.path))
        if request.headers.get("Authorization") != f"Bearer {TOKEN}":
            return 401, b""
        parts = url.path.strip("/").split("/")
        if url.path == "/api/worker/claim":
            if self.state != "Queued":
                return 204, b""
            self.claims += 1
            self.lease, self.state = f"lease-{self.claims}", "Running"
            return 200, json.dumps({"job": {**self.job, "leaseToken": self.lease}}).encode()
        lease = query.get("leaseToken") if request.command in ("GET", "PUT") else json.loads(body).get("leaseToken")
        self.leases.append((url.path, lease))
        if lease != self.lease or self.state != "Running":
            return 409, b""
        if request.command == "GET" and parts[-1] == "source":
            return 200, TEXT.encode()
        if request.command == "PUT":
            assert length is not None and int(length) == len(body) > 0
        kind = parts[4]
        if kind == "progress":
            self.progress.append(json.loads(body))
        elif kind == "chapters":
            index = int(parts[5])
            self.chapters[index] = {"title": query["title"], "durationMs": int(query["durationMs"]), "bytes": len(body)}
            if self.steal_after_chapter == index:
                self.lease = "another-workers-lease"
        elif kind == "book":
            self.book = body
        elif kind == "complete":
            self.state = "Ready"
        elif kind == "fail":
            self.state, self.reason = "Failed", json.loads(body)["reason"]
        return 204, b""


@pytest.fixture
def server():
    servers = []

    def start(job: dict) -> tuple[FakeApi, str]:
        fake = FakeApi(job)

        class Handler(BaseHTTPRequestHandler):
            def _respond(self):
                status, payload = fake.handle(self)
                self.send_response(status)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            do_GET = do_POST = do_PUT = _respond

            def log_message(self, *args):
                pass

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        servers.append(httpd)
        return fake, f"http://127.0.0.1:{httpd.server_port}"

    yield start
    for httpd in servers:
        httpd.shutdown()


def _job(completed=()):
    return {"episodeId": "ep1", "source": {"_tag": "File", "fileName": "story.txt", "contentType": "text/plain"},
            "sourcePath": "/api/worker/jobs/ep1/source", "voice": "tone:a", "speed": 1.0,
            "completedChapters": list(completed)}


def _run(url: str, tmp_path: Path):
    work.run(url, TOKEN, "mac", out_dir=tmp_path / "work", once=True)


def test_claim_progress_chapters_book_complete(tone, server, tmp_path):
    fake, url = server(_job())
    _run(url, tmp_path)
    assert fake.state == "Ready"
    assert sorted(fake.chapters) == [0, 1, 2]
    assert [c["title"] for c in fake.chapters.values()] == ["Chapter 1", "Chapter 2", "Chapter 3"]
    assert all(c["durationMs"] > 0 and c["bytes"] > 0 for c in fake.chapters.values())
    assert fake.book and fake.book[4:8] == b"ftyp"
    stages = [p["stage"] for p in fake.progress]
    assert stages[0] == "extracting" and "synthesizing" in stages and "uploading" in stages
    assert fake.progress[-1]["voice"] == "tone:a" and fake.progress[-1]["language"] == "en"
    order = [path.rsplit("/", 2)[-2] if "chapters" in path else path.rsplit("/", 1)[-1] for _, path in fake.calls]
    assert order.index("chapters") < order.index("book") < order.index("complete")
    assert not (tmp_path / "work" / "ep1").exists()
    assert ("/api/worker/jobs/ep1/source", "lease-1") in fake.leases
    assert {lease for _, lease in fake.leases} == {"lease-1"}


def test_409_drops_the_job_without_failing_it(tone, server, tmp_path):
    fake, url = server(_job())
    fake.steal_after_chapter = 0
    _run(url, tmp_path)
    assert sorted(fake.chapters) == [0]
    assert fake.book is None
    assert ("POST", "/api/worker/jobs/ep1/complete") not in fake.calls
    assert ("POST", "/api/worker/jobs/ep1/fail") not in fake.calls


def test_resume_skips_completed_chapters(tone, server, tmp_path):
    fake, url = server(_job(completed=[0, 1]))
    _run(url, tmp_path)
    assert sorted(fake.chapters) == [2]
    assert fake.book is not None and fake.state == "Ready"


def test_extraction_error_fails_the_job(tone, server, tmp_path):
    job = _job()
    job["source"] = {"_tag": "File", "fileName": "story.docx", "contentType": "application/msword"}
    fake, url = server(job)
    _run(url, tmp_path)
    assert fake.state == "Failed"
    assert fake.reason == "Unsupported file type '.docx'. Use PDF, EPUB, TXT, MD or HTML."


def test_heartbeat_sends_progress_while_idle(tone, server, tmp_path):
    from fama_worker.api import Api

    fake, url = server(_job())
    api = Api(url, TOKEN, "mac")
    job = api.claim([])
    with work.Heartbeat(api, job, interval=0.05):
        threading.Event().wait(0.3)
    assert len(fake.progress) >= 3


def test_drain_makes_the_job_then_exits_on_an_empty_queue(tone, server, tmp_path):
    fake, url = server(_job())
    work.run(url, TOKEN, "modal", out_dir=tmp_path / "work", drain=True)
    assert fake.state == "Ready"
    claims = [path for _, path in fake.calls if path == "/api/worker/claim"]
    assert len(claims) == 2  # the job, then 204


def test_drain_makes_a_job_claimed_elsewhere_under_the_same_worker_id(tone, server, tmp_path):
    import httpx

    from fama_worker.api import ClaimedJob

    fake, url = server(_job())
    # As the Modal dispatcher does: claim on the CPU, hand the raw job to the GPU drain.
    raw = httpx.post(f"{url}/api/worker/claim", json={"workerId": "modal-1", "voices": []},
                     headers={"Authorization": f"Bearer {TOKEN}"}).json()["job"]
    work.run(url, TOKEN, "modal-1", out_dir=tmp_path / "work", drain=True, first_job=ClaimedJob.parse(raw))
    assert fake.state == "Ready" and sorted(fake.chapters) == [0, 1, 2]
