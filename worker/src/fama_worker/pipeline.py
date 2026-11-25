"""Document -> chapter audio files -> book file.

Stages are plain functions: plan (split into Segments and normalize each), synthesize
(through the chunk cache), encode each chapter, assemble the book. Each chapter also gets
a timing file: when each Segment starts and ends in the chapter audio. A reporter hears
about progress and about each chapter as soon as its files exist, so `fama work` can
upload them right away.
"""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from collections.abc import Callable, Collection, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Protocol

import numpy as np

from fama_worker import audio
from fama_worker.cache import ChunkCache, chunk_key
from fama_worker.chunk import Segment, segments
from fama_worker.engines import Engine, get_engine
from fama_worker.model import Audio, Document, VoiceRef
from fama_worker.normalize import normalize

# Silence after a Segment, on top of the silence the engine ends each call with.
SEGMENT_GAP_S = 0.2
PARAGRAPH_GAP_S = 0.45
TITLE_GAP_S = 0.9
SILENCE_RMS = 0.001  # -60 dB

Stage = Literal["extracting", "synthesizing", "encoding", "uploading"]


@dataclass(frozen=True)
class ChapterPlan:
    index: int
    title: str
    intro: tuple[Segment, ...]  # spoken titles, followed by a longer pause
    body: tuple[Segment, ...]


@dataclass(frozen=True)
class Plan:
    document: Document
    voice: VoiceRef
    speed: float
    chapters: tuple[ChapterPlan, ...]

    @property
    def total_segments(self) -> int:
        return sum(len(c.intro) + len(c.body) for c in self.chapters)


@dataclass(frozen=True)
class Timed:
    """A Segment on the timeline of its chapter: where its voice starts, and where its audio ends."""

    segment: Segment
    start_ms: int
    end_ms: int


@dataclass(frozen=True)
class ChapterFile:
    index: int
    title: str
    path: Path
    duration_ms: int
    timing: Path | None  # reused chapters only need their audio for the book
    input_hash: str


@dataclass(frozen=True)
class Book:
    directory: Path
    chapters: tuple[ChapterFile, ...]
    path: Path
    cover: Path | None
    duration_ms: int


class Reporter(Protocol):
    def stage(self, stage: Stage, done: int, total: int) -> None: ...

    def chapter_ready(self, chapter: ChapterFile) -> None: ...


class SilentReporter:
    def stage(self, stage: Stage, done: int, total: int) -> None:
        pass

    def chapter_ready(self, chapter: ChapterFile) -> None:
        pass


def slug(title: str) -> str:
    title = title.lower().replace("ð", "d").replace("þ", "th").replace("æ", "ae").replace("ö", "o")
    ascii_title = unicodedata.normalize("NFKD", title)
    ascii_title = ascii_title.encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", ascii_title.lower()).strip("-")[:60] or "episode"


def _key(text: str) -> str:
    return re.sub(r"\W+", "", text.lower())


def _sentence(text: str) -> str:
    text = text.strip()
    return text if re.search(r"[.!?]$", text) else f"{text}."


def plan(document: Document, voice: VoiceRef, speed: float, engine: Engine, *,
         skip: Collection[int] = ()) -> Plan:
    def speak(text: str) -> str:
        return normalize(text, document.language)

    chapters = []
    for index, chapter in enumerate(document.chapters):
        if index in skip:
            continue
        body = tuple(segments(chapter.text, engine.max_chars, speak))
        start = _key(" ".join(s.spoken for s in body))
        lines: list[str] = []
        if index == 0 and not start.startswith(_key(document.title)):
            lines.append(document.title)
            if document.author:
                lines.append(document.author)
        if _key(chapter.title) != _key(document.title) and not start.startswith(_key(chapter.title)):
            lines.append(chapter.title)
        intro = tuple(
            Segment(s.text, _sentence(s.spoken), ends_paragraph=True)
            for line in lines
            for s in segments(line, engine.max_chars, speak)
        )
        chapters.append(ChapterPlan(index, chapter.title, intro, body))
    return Plan(document, voice, speed, tuple(chapters))


def _synthesize(segment: Segment, plan: Plan, engine: Engine, cache: ChunkCache) -> Audio:
    key = chunk_key(segment.spoken, plan.voice, engine.model_version, plan.speed)
    cached = cache.get(key)
    if cached is not None:
        return cached
    result = engine.synthesize(segment.spoken, plan.voice.voice_id, plan.speed)
    cache.put(key, result)
    return result


def _lead(samples: np.ndarray, rate: int) -> int:
    """The number of samples before the voice starts. An engine opens each call with silence: Kokoro with 0.3 s."""
    window = rate // 200
    frames = samples[: len(samples) // window * window].reshape(-1, window)
    voiced = np.flatnonzero(np.sqrt(np.mean(np.square(frames), axis=1)) > SILENCE_RMS)
    return int(voiced[0]) * window if voiced.size else 0


def render_chapter(chapter: ChapterPlan, plan: Plan, engine: Engine, cache: ChunkCache,
                   on_segment=lambda: None) -> tuple[Audio, tuple[Timed, ...]]:
    """The chapter audio, and where each Segment is in it.

    A Segment that continues a paragraph loses the silence its call opens with. So the pause between two sentences
    is the same as when one call read both: the closing silence of the first, and SEGMENT_GAP_S."""
    parts: list[np.ndarray] = []
    spans: list[tuple[Segment, int, int]] = []  # in samples
    rate: int | None = None
    position = 0
    starts_paragraph = True
    pieces = [(s, TITLE_GAP_S if i == len(chapter.intro) - 1 else PARAGRAPH_GAP_S) for i, s in enumerate(chapter.intro)]
    pieces += [(s, PARAGRAPH_GAP_S if s.ends_paragraph else SEGMENT_GAP_S) for s in chapter.body]
    for segment, gap in pieces:
        result = _synthesize(segment, plan, engine, cache)
        if rate is not None and result.sample_rate != rate:
            raise RuntimeError("Engine changed its sample rate inside one chapter.")
        rate = result.sample_rate
        lead = _lead(result.samples, rate)
        samples = result.samples if starts_paragraph else result.samples[lead:]
        silence = np.zeros(int(gap * rate), dtype=np.float32)
        spans.append((segment, position + (lead if starts_paragraph else 0), position + len(samples)))
        position += len(samples) + len(silence)
        parts += [samples, silence]
        starts_paragraph = segment.ends_paragraph
        on_segment()
    if rate is None:
        raise ValueError(f"Chapter {chapter.index} has no text.")
    timed = tuple(Timed(s, round(start * 1000 / rate), round(end * 1000 / rate)) for s, start, end in spans)
    return Audio(audio.level(np.concatenate(parts[:-1])), rate), timed


def write_timing(timed: tuple[Timed, ...], path: Path) -> None:
    """The timing file of one chapter, in the shape of `Timing` in packages/contracts."""
    path.write_text(json.dumps({"segments": [
        {"text": t.segment.text, "startMs": t.start_ms, "endMs": t.end_ms, "endsParagraph": t.segment.ends_paragraph}
        for t in timed
    ]}, ensure_ascii=False) + "\n", encoding="utf-8")


def chapter_input_hash(document: Document, index: int, voice: VoiceRef, speed: float, model_version: str) -> str:
    chapter = document.chapters[index]
    payload = json.dumps([
        "chapter-v1", index, chapter.title, chapter.text, document.title, document.author, document.language,
        str(voice), float(speed), model_version,
    ])
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def narrate(document: Document, voice: VoiceRef, speed: float, out_dir: Path, *,
            reporter: Reporter | None = None, cache: ChunkCache | None = None,
            stored_hashes: Mapping[int, str] | None = None,
            fetch_chapter: Callable[[int, Path], None] | None = None) -> Book:
    """Narrate stale or missing chapters and assemble a book from new and reused audio."""
    reporter = reporter or SilentReporter()
    cache = cache or ChunkCache()
    engine = get_engine(voice.engine)
    hashes = [chapter_input_hash(document, i, voice, speed, engine.model_version)
              for i in range(len(document.chapters))]
    reused = {i for i, digest in enumerate(hashes) if stored_hashes and stored_hashes.get(i) == digest}
    the_plan = plan(document, voice, speed, engine, skip=reused)
    to_render = iter(the_plan.chapters)
    directory = out_dir / slug(document.title)
    directory.mkdir(parents=True, exist_ok=True)
    cover = audio.write_cover(document.cover, directory) if document.cover else None

    done = 0
    total = the_plan.total_segments

    def tick() -> None:
        nonlocal done
        done += 1
        reporter.stage("synthesizing", done, total)

    reporter.stage("synthesizing", 0, total)
    files = []
    for index, chapter in enumerate(document.chapters):
        path = directory / "chapters" / f"{index:03d}.m4a"
        timing = None
        if index in reused:
            assert fetch_chapter is not None
            fetch_chapter(index, path)
        else:
            rendered, timed = render_chapter(next(to_render), the_plan, engine, cache, tick)
            audio.encode_chapter(rendered, path, title=chapter.title, album=document.title, artist=document.author,
                                 track=index + 1)
            timing = path.with_suffix(".json")
            write_timing(timed, timing)
        file = ChapterFile(index, chapter.title, path, audio.duration_ms(path), timing, hashes[index])
        files.append(file)
        if timing is not None:
            reporter.chapter_ready(file)

    reporter.stage("encoding", 0, 1)
    book_path = directory / "book.m4b"
    audio.assemble_book([audio.BookChapter(f.path, f.title, f.duration_ms) for f in files], book_path,
                        title=document.title, author=document.author, cover=cover)
    reporter.stage("encoding", 1, 1)
    duration = sum(f.duration_ms for f in files)
    (directory / "episode.json").write_text(json.dumps({
        "title": document.title, "author": document.author, "language": document.language, "voice": str(voice),
        "speed": speed, "durationMs": duration,
        "chapters": [{"index": f.index, "title": f.title, "durationMs": f.duration_ms} for f in files],
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return Book(directory, tuple(files), book_path, cover, duration)
