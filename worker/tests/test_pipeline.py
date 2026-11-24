import json
import subprocess

import numpy as np
from conftest import LEAD_S

from fama_worker.cache import chunk_key
from fama_worker.model import Chapter, Document, VoiceRef
from fama_worker.pipeline import PARAGRAPH_GAP_S, SEGMENT_GAP_S, TITLE_GAP_S, narrate

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
    assert [p.name for p in sorted((book.directory / "chapters").iterdir())] == [
        "000.json", "000.m4a", "001.json", "001.m4a"]
    probe = json.loads(subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_chapters", "-show_format", "-show_streams",
         str(book.path)], capture_output=True, text=True, check=True).stdout)
    assert [c["tags"]["title"] for c in probe["chapters"]] == ["Part 1", "Part 2"]
    assert probe["streams"][0]["codec_name"] == "aac"
    assert probe["format"]["tags"]["title"] == "A Title"
    assert probe["format"]["tags"]["artist"] == "An Author"
    assert abs(float(probe["format"]["duration"]) * 1000 - book.duration_ms) < 100
    assert tone.calls[0] == "A Title."  # the book opens with its title


STORY = ("It took 41 years to build the church on the hill. The tower is 74 metres tall and made of concrete. "
         "Nobody in the whole town liked it at first.\n\nNow the whole town comes to hear the organ on Sundays.")


def _timing(chapter) -> list[dict]:
    return json.loads(chapter.timing.read_text())["segments"]


def test_timing_file_has_the_document_text_of_each_segment_in_order(tone, tmp_path):
    book = narrate(_document(STORY, "A short second part of the story is here."), VOICE, 1.0, tmp_path)
    assert [c.timing.name for c in book.chapters] == ["000.json", "001.json"]
    first = _timing(book.chapters[0])
    assert [s["text"] for s in first] == [
        "A Title", "An Author", "Part 1",
        "It took 41 years to build the church on the hill.", "The tower is 74 metres tall and made of concrete.",
        "Nobody in the whole town liked it at first.", "Now the whole town comes to hear the organ on Sundays."]
    assert [s["endsParagraph"] for s in first] == [True, True, True, False, False, True, True]
    assert tone.calls[3] == "It took forty-one years to build the church on the hill."
    assert [s["text"] for s in _timing(book.chapters[1])] == ["Part 2", "A short second part of the story is here."]


def test_timing_covers_the_chapter_to_its_end(tone, tmp_path):
    book = narrate(_document(STORY, "A short second part of the story is here."), VOICE, 1.0, tmp_path)
    for chapter in book.chapters:
        timing = _timing(chapter)
        assert all(s["startMs"] < s["endMs"] for s in timing)
        assert all(a["endMs"] <= b["startMs"] for a, b in zip(timing, timing[1:]))
        assert abs(timing[-1]["endMs"] - chapter.duration_ms) <= 50


def test_a_sentence_that_continues_a_paragraph_starts_without_the_silence_of_its_call(tone, tmp_path):
    book = narrate(_document(STORY), VOICE, 1.0, tmp_path)
    timing = _timing(book.chapters[0])
    assert timing[0]["startMs"] == LEAD_S * 1000
    silence = [round((b["startMs"] - a["endMs"]) / 1000, 2) for a, b in zip(timing, timing[1:])]
    assert silence == [PARAGRAPH_GAP_S + LEAD_S, PARAGRAPH_GAP_S + LEAD_S, TITLE_GAP_S + LEAD_S,
                       SEGMENT_GAP_S, SEGMENT_GAP_S, PARAGRAPH_GAP_S + LEAD_S]


def test_each_start_is_where_the_voice_starts_in_the_encoded_audio(tone, tmp_path):
    book = narrate(_document(STORY), VOICE, 1.0, tmp_path)
    chapter = book.chapters[0]
    rate = 16000
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(chapter.path), "-f", "f32le", "-ac", "1", "-ar", str(rate),
                          "-"], capture_output=True, check=True).stdout
    samples = np.frombuffer(raw, dtype=np.float32)

    def loudness(from_ms: int, to_ms: int) -> float:
        return float(np.sqrt(np.mean(np.square(samples[from_ms * rate // 1000:to_ms * rate // 1000]))))

    for segment in _timing(chapter):
        start = segment["startMs"]
        assert loudness(start - 60, start - 20) < 0.01 < loudness(start + 20, start + 60)
