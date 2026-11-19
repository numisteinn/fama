import json
import subprocess

from fama_worker.cache import chunk_key
from fama_worker.model import Chapter, Document, VoiceRef
from fama_worker.pipeline import narrate

VOICE = VoiceRef("tone", "a")


def _document(*texts: str) -> Document:
    chapters = tuple(Chapter(f"Part {i + 1}", t) for i, t in enumerate(texts))
    return Document("A Title", "An Author", "en", chapters)


def test_cache_key_changes_with_every_input():
    base = chunk_key("Hello.", VOICE, "v1", 1.0)
    assert base == chunk_key("Hello.", VOICE, "v1", 1.0)
    variants = [chunk_key("Hello!", VOICE, "v1", 1.0), chunk_key("Hello.", VoiceRef("tone", "b"), "v1", 1.0),
                chunk_key("Hello.", VoiceRef("other", "a"), "v1", 1.0), chunk_key("Hello.", VOICE, "v2", 1.0),
                chunk_key("Hello.", VOICE, "v1", 1.25)]
    assert len({base, *variants}) == 6


def test_rerun_only_synthesizes_missing_chunks(tone, tmp_path):
    document = _document("One sentence here. Another one there.", "Second chapter text.")
    narrate(document, VOICE, 1.0, tmp_path / "out")
    first = len(tone.calls)
    assert first > 0
    narrate(document, VOICE, 1.0, tmp_path / "out")
    assert len(tone.calls) == first
    narrate(_document("One sentence here. Another one there.", "A changed chapter."), VOICE, 1.0, tmp_path / "out")
    assert tone.calls[first:] == ["A changed chapter."]


def test_book_has_chapters_tags_and_aac(tone, tmp_path):
    book = narrate(_document("Alpha beta gamma.", "Delta epsilon."), VOICE, 1.0, tmp_path)
    assert [p.name for p in sorted((book.directory / "chapters").iterdir())] == ["000.m4a", "001.m4a"]
    probe = json.loads(subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_chapters", "-show_format", "-show_streams",
         str(book.path)], capture_output=True, text=True, check=True).stdout)
    assert [c["tags"]["title"] for c in probe["chapters"]] == ["Part 1", "Part 2"]
    assert probe["streams"][0]["codec_name"] == "aac"
    assert probe["format"]["tags"]["title"] == "A Title"
    assert probe["format"]["tags"]["artist"] == "An Author"
    assert abs(float(probe["format"]["duration"]) * 1000 - book.duration_ms) < 100
    assert tone.calls[0] == "A Title."  # the book opens with its title
