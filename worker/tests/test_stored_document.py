"""The stored Document: the worker extracts once, stores the Document, and narrates every later attempt from it."""

import struct
import subprocess
import zlib
from pathlib import Path

from fama_worker import audio
from test_work import _job, _run, server  # noqa: F401  (`server` is a fixture)

STORED = {"title": "Stored Title", "author": "Stored Author", "language": "en", "chapters": [
    {"title": "Stored One", "text": "Words that only the stored Document has. " * 10},
    {"title": "Stored Two", "text": "More words that the source never had. " * 10},
]}


def _png(size: int = 16) -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    rows = b"".join(b"\x00" + b"\x40\x80\xc0" * size for _ in range(size))
    header = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")


def _calls(fake, method: str, name: str) -> int:
    return sum(1 for m, path in fake.calls if m == method and path.endswith(f"/{name}"))


def test_the_first_attempt_stores_the_document_it_narrates(tone, server, tmp_path):
    fake, url = server(_job())
    _run(url, tmp_path)
    assert fake.state == "Ready"
    assert fake.document is not None and set(fake.document) == {"title", "author", "language", "chapters"}
    assert fake.document["language"] == "en"
    assert [c["title"] for c in fake.document["chapters"]] == [fake.chapters[i]["title"] for i in sorted(fake.chapters)]
    paths = [path for _, path in fake.calls]
    assert paths.index("/api/worker/jobs/ep1/document") < paths.index("/api/worker/jobs/ep1/chapters/0")


def test_a_job_with_a_stored_document_is_narrated_from_it_without_extraction(tone, server, tmp_path):
    fake, url = server(_job())
    fake.document = STORED
    _run(url, tmp_path)
    assert fake.state == "Ready"
    assert _calls(fake, "GET", "source") == 0 and _calls(fake, "PUT", "document") == 0
    assert [fake.chapters[i]["title"] for i in sorted(fake.chapters)] == ["Stored One", "Stored Two"]
    assert (fake.progress[-1]["title"], fake.progress[-1]["author"]) == ("Stored Title", "Stored Author")
    assert any("only the stored Document has" in text for text in tone.calls)


def test_a_retry_after_a_failed_narration_does_not_extract_again(tone, server, tmp_path, monkeypatch):
    fake, url = server(_job())

    def broken(text, voice_id, speed):
        raise RuntimeError("engine fell over")

    with monkeypatch.context() as patch:
        patch.setattr(tone, "synthesize", broken)
        _run(url, tmp_path)
    assert fake.state == "Failed" and fake.reason == "RuntimeError: engine fell over"
    assert fake.document is not None and fake.chapters == {}
    stored = fake.document

    fake.state = "Queued"  # the user chose Retry
    _run(url, tmp_path)
    assert fake.state == "Ready"
    assert _calls(fake, "GET", "source") == 1 and _calls(fake, "PUT", "document") == 1
    assert _calls(fake, "GET", "document") == 1
    assert fake.document == stored
    assert [c["title"] for c in stored["chapters"]] == [fake.chapters[i]["title"] for i in sorted(fake.chapters)]


def test_a_retry_puts_the_stored_cover_in_the_book_file(tone, server, tmp_path):
    fake, url = server(_job())
    fake.document, fake.cover = STORED, _png()
    _run(url, tmp_path)
    assert fake.state == "Ready" and _calls(fake, "PUT", "cover") == 0
    book = tmp_path / "book.m4b"
    book.write_bytes(fake.book)
    ffprobe = str(Path(audio.ffmpeg()).with_name("ffprobe"))
    streams = subprocess.run([ffprobe, "-v", "error", "-show_entries", "stream=codec_name", "-of", "csv=p=0", str(book)],
                             capture_output=True, text=True, check=True).stdout.split()
    assert "png" in streams
