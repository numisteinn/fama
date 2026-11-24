"""`fama work`: the pull loop from docs/api.md.

Claim a job, extract the source to a stored Document, then narrate the stored Document:
synthesize, upload each chapter as it finishes, then the book, then complete. A job whose
Document the API already has is not extracted again. A heartbeat thread sends progress
every 30 seconds. Any 409 drops the job.
"""

from __future__ import annotations

import shutil
import sys
import tempfile
import threading
import time
from dataclasses import dataclass, replace
from pathlib import Path

from fama_worker import audio
from fama_worker.api import MAX_UPLOAD_BYTES, Api, ApiError, ClaimedJob, FileRef, LeaseLost
from fama_worker.engines import all_voices, default_voice
from fama_worker.eta import Eta
from fama_worker.extract import extract
from fama_worker.model import Document, FileSource, Source
from fama_worker.pipeline import Book, ChapterFile, narrate

HEARTBEAT_S = 30
PROGRESS_THROTTLE_S = 5
IDLE_MIN_S = 2
IDLE_MAX_S = 10  # a new episode waits at most this long in Queued


def log(message: str) -> None:
    print(f"[fama work] {message}", file=sys.stderr, flush=True)


@dataclass(frozen=True)
class Progress:
    stage: str = "extracting"
    done: int = 0
    total: int = 1
    title: str | None = None
    author: str | None = None
    language: str | None = None
    voice: str | None = None


class Heartbeat:
    """Holds the latest progress and sends it on change (throttled) and every HEARTBEAT_S, with the time left."""

    def __init__(self, api: Api, job: ClaimedJob, interval: float = HEARTBEAT_S) -> None:
        self.api, self.job, self.interval = api, job, interval
        self.progress = Progress()
        self.eta = Eta()
        self.lost = threading.Event()
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._sent_at = 0.0
        self._sent_stage: str | None = None
        self._thread = threading.Thread(target=self._loop, daemon=True)

    def __enter__(self) -> Heartbeat:
        self.send()
        self._thread.start()
        return self

    def __exit__(self, *exc) -> None:
        self._stop.set()
        self._thread.join()

    def update(self, **changes) -> None:
        if self.lost.is_set():
            raise LeaseLost("lease lost")
        self.progress = replace(self.progress, **changes)
        self.eta.observe(self.progress.stage, self.progress.done, self.progress.total, time.monotonic())
        if self.progress.stage != self._sent_stage or time.monotonic() - self._sent_at >= PROGRESS_THROTTLE_S:
            self.send()

    def send(self) -> None:
        if self.lost.is_set():
            raise LeaseLost("lease lost")
        p = self.progress
        with self._lock:
            try:
                self.api.progress(self.job, p.stage, p.done, p.total, title=p.title, author=p.author,
                                  language=p.language, voice=p.voice,
                                  remaining_ms=self.eta.remaining_ms(time.monotonic()))
            except LeaseLost:
                self.lost.set()
                raise
            except ApiError as error:
                log(f"progress failed, will retry: {error}")
            self._sent_at, self._sent_stage = time.monotonic(), p.stage

    def _loop(self) -> None:
        while not self._stop.wait(self.interval):
            try:
                self.send()
            except LeaseLost:
                return


class JobReporter:
    """Pipeline reporter: progress goes to the heartbeat, finished chapters go up at once."""

    def __init__(self, api: Api, job: ClaimedJob, heartbeat: Heartbeat) -> None:
        self.api, self.job, self.heartbeat = api, job, heartbeat

    def stage(self, stage: str, done: int, total: int) -> None:
        self.heartbeat.update(stage=stage, done=done, total=total)

    def chapter_ready(self, chapter: ChapterFile) -> None:
        self.api.put_chapter(self.job, chapter.index, chapter.title, chapter.duration_ms, chapter.path)
        log(f"{self.job.episode_id}: uploaded chapter {chapter.index} ({chapter.duration_ms / 1000:.0f}s)")


def _source(api: Api, job: ClaimedJob, directory: Path) -> Source:
    if not isinstance(job.source, FileRef):
        return job.source
    path = directory / Path(job.source.file_name).name
    path.write_bytes(api.source(job))
    return FileSource(path, job.source.content_type)


def _upload_book(api: Api, job: ClaimedJob, book: Path) -> None:
    if book.stat().st_size > MAX_UPLOAD_BYTES:
        smaller = book.with_name("book-upload.m4b")
        if not audio.shrink_book(book, smaller, MAX_UPLOAD_BYTES):
            log(f"{job.episode_id}: book file is too long to fit {MAX_UPLOAD_BYTES} bytes; chapters only")
            return
        book = smaller
    api.put_book(job, book)


def extract_document(api: Api, job: ClaimedJob, workdir: Path) -> Document:
    """Source to stored Document. The cover goes up first, so a stored Document means extraction is complete."""
    with tempfile.TemporaryDirectory() as tmp:
        document = extract(_source(api, job, Path(tmp)))
    if document.cover:
        api.put_cover(job, audio.write_cover(document.cover, workdir))
    api.put_document(job, document)
    log(f"{job.episode_id}: extracted the source, stored the Document ({len(document.chapters)} chapters)")
    return document


def stored_document(api: Api, job: ClaimedJob) -> Document:
    document = api.document(job)
    log(f"{job.episode_id}: read the stored Document ({len(document.chapters)} chapters), no extraction")
    return document


def narrate_document(api: Api, job: ClaimedJob, document: Document, heartbeat: Heartbeat, workdir: Path) -> Book:
    """Stored Document to audio. Audio chapter i narrates Document chapter i."""
    voice = job.voice or default_voice(document.language)
    heartbeat.update(stage="extracting", done=1, total=1, title=document.title, author=document.author,
                     language=document.language, voice=str(voice))
    book = narrate(document, voice, job.speed, workdir, reporter=JobReporter(api, job, heartbeat),
                   skip=job.completed_chapters)
    heartbeat.update(stage="uploading", done=0, total=1)
    _upload_book(api, job, book.path)
    heartbeat.update(stage="uploading", done=1, total=1)
    api.complete(job, book.duration_ms)
    return book


def process(api: Api, job: ClaimedJob, out_dir: Path) -> int | None:
    """Make one episode. Returns its audio length in ms when it is ready, else None."""
    episode = job.episode_id
    started = time.monotonic()
    workdir = out_dir / episode
    workdir.mkdir(parents=True, exist_ok=True)
    log(f"{episode}: claimed, skipping chapters {sorted(job.completed_chapters)}")
    try:
        with Heartbeat(api, job) as heartbeat:
            document = stored_document(api, job) if job.document_path else extract_document(api, job, workdir)
            book = narrate_document(api, job, document, heartbeat, workdir)
        log(f"{episode}: ready, {book.duration_ms / 1000:.0f}s audio in {len(book.chapters)} chapters, "
            f"{time.monotonic() - started:.0f}s wall")
        shutil.rmtree(workdir, ignore_errors=True)
        return book.duration_ms
    except LeaseLost as error:
        log(f"{episode}: dropped, lease lost ({error})")
    except Exception as error:  # the job fails; the loop goes on
        # Extractors raise ValueError with a message meant for the user; anything else is a bug worth naming.
        reason = str(error) if isinstance(error, ValueError) else f"{type(error).__name__}: {error}"
        log(f"{episode}: failed: {reason}")
        try:
            api.fail(job, reason)
        except (LeaseLost, ApiError) as fail_error:
            log(f"{episode}: could not report failure: {fail_error}")
    return None


def run(api_url: str, token: str, worker_id: str, *, out_dir: Path, once: bool = False, drain: bool = False,
        first_job: ClaimedJob | None = None, stop: threading.Event | None = None, api: Api | None = None) -> None:
    """Pull jobs until stopped. `once` stops after one job or an empty queue.
    `drain` takes jobs until the queue is empty, then stops (the cloud worker runs this).
    `first_job` is a job this worker id already claimed; it is made before the first claim."""
    api = api or Api(api_url, token, worker_id)
    stop = stop or threading.Event()
    voices = [v.to_json() for v in all_voices()]
    delay = IDLE_MIN_S
    started, jobs, audio_ms = time.monotonic(), 0, 0
    log(f"worker {worker_id} polling {api_url} with {len(voices)} voices")
    while not stop.is_set():
        if first_job is not None:
            job, first_job = first_job, None
        else:
            try:
                job = api.claim(voices)
            except ApiError as error:
                log(f"claim failed: {error}")
                job = None
        if job is None:
            if once or drain:
                break
            stop.wait(delay)
            delay = min(delay * 2, IDLE_MAX_S)
            continue
        delay = IDLE_MIN_S
        jobs += 1
        audio_ms += process(api, job, out_dir) or 0
        if once:
            break
    if drain:
        log(f"drained {jobs} jobs, {audio_ms / 1000:.0f}s audio in {time.monotonic() - started:.0f}s wall")
