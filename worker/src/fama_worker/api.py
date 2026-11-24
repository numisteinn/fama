"""HTTP client for the worker endpoints in docs/api.md."""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path

import httpx

from fama_worker.model import Cover, Document, TextSource, UrlSource, VoiceRef

MAX_UPLOAD_BYTES = 100 * 1024 * 1024
RETRIES = 5


class LeaseLost(Exception):
    """409: the lease token is not the job's current one, or the job is no longer Running. Drop it."""


class ApiError(Exception):
    pass


@dataclass(frozen=True)
class FileRef:
    file_name: str
    content_type: str


@dataclass(frozen=True)
class ClaimedJob:
    episode_id: str
    lease_token: str  # every job route needs it
    source: UrlSource | TextSource | FileRef
    source_path: str | None
    document_path: str | None  # set when the API has a stored Document: narrate from it, do not extract
    cover_path: str | None
    voice: VoiceRef | None
    speed: float
    chapters: dict[int, str]

    @staticmethod
    def parse(data: dict) -> ClaimedJob:
        raw = data["source"]
        match raw["_tag"]:
            case "Url":
                source = UrlSource(raw["url"])
            case "Text":
                source = TextSource(raw["title"], raw["text"])
            case "File":
                source = FileRef(raw["fileName"], raw["contentType"])
            case tag:
                raise ApiError(f"Unknown source tag {tag!r}")
        return ClaimedJob(
            episode_id=data["episodeId"],
            lease_token=data["leaseToken"],
            source=source,
            source_path=data["sourcePath"],
            document_path=data["documentPath"],
            cover_path=data["coverPath"],
            voice=VoiceRef.parse(data["voice"]) if data["voice"] else None,
            speed=float(data["speed"]),
            chapters={entry["index"]: entry["inputHash"] for entry in data["chapters"]},
        )


@dataclass(frozen=True)
class ClaimedSample:
    episode_id: str
    lease_token: str
    document_path: str
    voice: VoiceRef
    speed: float

    @property
    def params(self) -> dict[str, str]:
        return {"voice": str(self.voice), "leaseToken": self.lease_token}


Work = ClaimedJob | ClaimedSample


def parse_work(data: dict) -> Work:
    match data["_tag"]:
        case "Narrate":
            return ClaimedJob.parse(data)
        case "Sample":
            return ClaimedSample(data["episodeId"], data["leaseToken"], data["documentPath"],
                                 VoiceRef.parse(data["voice"]), float(data["speed"]))
        case tag:
            raise ApiError(f"Unknown work tag {tag!r}")


class Api:
    def __init__(self, base_url: str, token: str, worker_id: str, transport: httpx.BaseTransport | None = None):
        self.worker_id = worker_id
        self.client = httpx.Client(base_url=base_url.rstrip("/"), transport=transport, timeout=120,
                                   headers={"Authorization": f"Bearer {token}"})

    def _send(self, method: str, path: str, **kwargs) -> httpx.Response:
        """Retry network errors, 429 and 5xx. 409 means the lease is gone."""
        for attempt in range(RETRIES):
            try:
                response = self.client.request(method, path, **kwargs)
            except httpx.TransportError as error:
                failure: str = str(error)
            else:
                if response.status_code == 409:
                    raise LeaseLost(f"{method} {path}: {response.text[:200]}")
                if response.status_code < 400:
                    return response
                failure = f"{method} {path} -> {response.status_code}: {response.text[:300]}"
                if response.status_code != 429 and response.status_code < 500:
                    raise ApiError(failure)
            if attempt < RETRIES - 1:
                time.sleep(2**attempt)
        raise ApiError(failure)

    def claim(self, voices: list[dict]) -> Work | None:
        response = self._send("POST", "/api/worker/claim", json={"workerId": self.worker_id, "voices": voices})
        return None if response.status_code == 204 else parse_work(response.json()["work"])

    def source(self, job: ClaimedJob) -> bytes:
        if not job.source_path:
            raise ApiError("File job has no sourcePath")
        return self._send("GET", job.source_path, params={"leaseToken": job.lease_token}).content

    def document(self, job: ClaimedJob) -> Document:
        """The stored Document, with the stored cover when the episode has one."""
        if not job.document_path:
            raise ApiError("Job has no documentPath")
        lease = {"leaseToken": job.lease_token}
        cover = None
        if job.cover_path:
            response = self._send("GET", job.cover_path, params=lease)
            is_png = response.headers.get("content-type", "").startswith("image/png")
            cover = Cover(response.content, "png" if is_png else "jpg")
        return Document.from_json(self._send("GET", job.document_path, params=lease).json(), cover)

    def put_document(self, job: ClaimedJob, document: Document, voice: VoiceRef) -> bool:
        """Store the Document and return whether the job has stopped in Review."""
        response = self._send("PUT", f"/api/worker/jobs/{job.episode_id}/document", json=document.to_json(),
                              params={"workerId": self.worker_id, "leaseToken": job.lease_token,
                                      "voice": str(voice)})
        if response.status_code == 204:  # Servers before Review always continue.
            return False
        next_step = response.json().get("next")
        if next_step not in ("Review", "Narrate"):
            raise ApiError(f"Invalid Document upload response: {next_step!r}")
        return next_step == "Review"

    def progress(self, job: ClaimedJob, stage: str, done: int, total: int, *, title: str | None,
                 author: str | None, language: str | None, voice: str | None, remaining_ms: int | None) -> None:
        self._send("POST", f"/api/worker/jobs/{job.episode_id}/progress", json={
            "workerId": self.worker_id, "leaseToken": job.lease_token, "stage": stage, "done": done, "total": total,
            "title": title, "author": author, "language": language, "voice": voice, "remainingMs": remaining_ms,
        })

    def _put(self, job: ClaimedJob, path: str, file: Path, content_type: str, params: dict) -> None:
        data = file.read_bytes()
        if len(data) > MAX_UPLOAD_BYTES:
            raise ApiError(f"{file.name} is {len(data)} bytes; uploads are at most {MAX_UPLOAD_BYTES}")
        self._send("PUT", f"/api/worker/jobs/{job.episode_id}/{path}", content=data,
                   params={"workerId": self.worker_id, "leaseToken": job.lease_token, **params},
                   headers={"Content-Type": content_type})

    def chapter(self, job: ClaimedJob, index: int, path: Path) -> None:
        response = self._send("GET", f"/api/worker/jobs/{job.episode_id}/chapters/{index}",
                              params={"leaseToken": job.lease_token})
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(response.content)

    def put_chapter(self, job: ClaimedJob, index: int, title: str, duration_ms: int, input_hash: str,
                    file: Path) -> None:
        self._put(job, f"chapters/{index}", file, "audio/mp4",
                  {"title": title, "durationMs": str(duration_ms), "inputHash": input_hash})

    def put_timing(self, job: ClaimedJob, index: int, input_hash: str, file: Path) -> None:
        self._put(job, f"chapters/{index}/timing", file, "application/json", {"inputHash": input_hash})

    def put_book(self, job: ClaimedJob, file: Path) -> None:
        self._put(job, "book", file, "audio/mp4", {})

    def put_cover(self, job: ClaimedJob, file: Path) -> None:
        kind = "image/png" if file.suffix == ".png" else "image/jpeg"
        self._put(job, "cover", file, kind, {})

    def complete(self, job: ClaimedJob, duration_ms: int) -> None:
        self._send("POST", f"/api/worker/jobs/{job.episode_id}/complete",
                   json={"workerId": self.worker_id, "leaseToken": job.lease_token, "durationMs": duration_ms})

    def fail(self, job: ClaimedJob, reason: str) -> None:
        self._send("POST", f"/api/worker/jobs/{job.episode_id}/fail",
                   json={"workerId": self.worker_id, "leaseToken": job.lease_token, "reason": reason[:1000]})

    def sample_document(self, sample: ClaimedSample) -> Document:
        return Document.from_json(self._send("GET", sample.document_path, params=sample.params).json())

    def put_sample(self, sample: ClaimedSample, file: Path) -> None:
        self._send("PUT", f"/api/worker/samples/{sample.episode_id}/clip", content=file.read_bytes(),
                   params=sample.params, headers={"Content-Type": "audio/mp4"})

    def fail_sample(self, sample: ClaimedSample, reason: str) -> None:
        self._send("POST", f"/api/worker/samples/{sample.episode_id}/fail",
                   json={**sample.params, "reason": reason[:1000]})
