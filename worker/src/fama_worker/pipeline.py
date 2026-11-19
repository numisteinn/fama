"""Document -> chapter audio files -> book file.

Stages are plain functions: plan (normalize and chunk), synthesize (through the chunk
cache), encode each chapter, assemble the book. A reporter hears about progress and
about each chapter as soon as its file exists, so `fama work` can upload it right away.
"""

from __future__ import annotations

import json
import re
import unicodedata
from collections.abc import Collection
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Protocol

import numpy as np

from fama_worker import audio
from fama_worker.cache import ChunkCache, chunk_key
from fama_worker.chunk import Chunk, chunk_text
from fama_worker.engines import Engine, get_engine
from fama_worker.model import Audio, Document, VoiceRef
from fama_worker.normalize import normalize

CHUNK_GAP_S = 0.12
PARAGRAPH_GAP_S = 0.45
TITLE_GAP_S = 0.9

Stage = Literal["extracting", "synthesizing", "encoding", "uploading"]


@dataclass(frozen=True)
class ChapterPlan:
    index: int
    title: str
    intro: tuple[Chunk, ...]  # spoken titles, followed by a longer pause
    chunks: tuple[Chunk, ...]


@dataclass(frozen=True)
class Plan:
    document: Document
    voice: VoiceRef
    speed: float
    chapters: tuple[ChapterPlan, ...]

    @property
    def total_chunks(self) -> int:
        return sum(len(c.intro) + len(c.chunks) for c in self.chapters)


@dataclass(frozen=True)
class ChapterFile:
    index: int
    title: str
    path: Path
    duration_ms: int


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


def plan(document: Document, voice: VoiceRef, speed: float, engine: Engine) -> Plan:
    language = document.language
    chapters = []
    for index, chapter in enumerate(document.chapters):
        text = normalize(chapter.text, language)
        spoken: list[str] = []
        if index == 0 and not _key(text).startswith(_key(document.title)):
            spoken.append(document.title)
            if document.author:
                spoken.append(document.author)
        if _key(chapter.title) != _key(document.title) and not _key(text).startswith(_key(chapter.title)):
            spoken.append(chapter.title)
        intro = tuple(
            Chunk(c.text, ends_paragraph=True)
            for line in spoken
            for c in chunk_text(_sentence(normalize(line, language)), engine.max_chars)
        )
        chapters.append(ChapterPlan(index, chapter.title, intro, tuple(chunk_text(text, engine.max_chars))))
    return Plan(document, voice, speed, tuple(chapters))


def _synthesize(chunk: Chunk, plan: Plan, engine: Engine, cache: ChunkCache) -> Audio:
    key = chunk_key(chunk.text, plan.voice, engine.model_version, plan.speed)
    cached = cache.get(key)
    if cached is not None:
        return cached
    result = engine.synthesize(chunk.text, plan.voice.voice_id, plan.speed)
    cache.put(key, result)
    return result


def render_chapter(chapter: ChapterPlan, plan: Plan, engine: Engine, cache: ChunkCache,
                   on_chunk=lambda: None) -> Audio:
    parts: list[np.ndarray] = []
    rate: int | None = None
    pieces = [(c, TITLE_GAP_S if i == len(chapter.intro) - 1 else PARAGRAPH_GAP_S) for i, c in enumerate(chapter.intro)]
    pieces += [(c, PARAGRAPH_GAP_S if c.ends_paragraph else CHUNK_GAP_S) for c in chapter.chunks]
    for chunk, gap in pieces:
        result = _synthesize(chunk, plan, engine, cache)
        if rate is not None and result.sample_rate != rate:
            raise RuntimeError("Engine changed its sample rate inside one chapter.")
        rate = result.sample_rate
        parts += [result.samples, np.zeros(int(gap * rate), dtype=np.float32)]
        on_chunk()
    if rate is None:
        raise ValueError(f"Chapter {chapter.index} has no text.")
    return Audio(audio.level(np.concatenate(parts[:-1])), rate)


def narrate(document: Document, voice: VoiceRef, speed: float, out_dir: Path, *,
            reporter: Reporter | None = None, cache: ChunkCache | None = None,
            skip: Collection[int] = ()) -> Book:
    """Make every chapter file, then the book file. Chapters in `skip` are not reported again."""
    reporter = reporter or SilentReporter()
    cache = cache or ChunkCache()
    engine = get_engine(voice.engine)
    the_plan = plan(document, voice, speed, engine)
    directory = out_dir / slug(document.title)
    directory.mkdir(parents=True, exist_ok=True)
    cover = audio.write_cover(document.cover, directory) if document.cover else None

    done = 0
    total = the_plan.total_chunks

    def tick() -> None:
        nonlocal done
        done += 1
        reporter.stage("synthesizing", done, total)

    reporter.stage("synthesizing", 0, total)
    files = []
    for chapter in the_plan.chapters:
        rendered = render_chapter(chapter, the_plan, engine, cache, tick)
        path = directory / "chapters" / f"{chapter.index:03d}.m4a"
        audio.encode_chapter(rendered, path, title=chapter.title, album=document.title, artist=document.author,
                             track=chapter.index + 1)
        file = ChapterFile(chapter.index, chapter.title, path, audio.duration_ms(path))
        files.append(file)
        if chapter.index not in skip:
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
