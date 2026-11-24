"""Render a short clip from the first body paragraph of a Document."""

from __future__ import annotations

import re
import time
from pathlib import Path

from fama_worker import audio
from fama_worker.cache import ChunkCache
from fama_worker.chunk import segments, sentences
from fama_worker.engines import get_engine
from fama_worker.model import Document, VoiceRef
from fama_worker.normalize import normalize
from fama_worker.pipeline import ChapterPlan, Plan, render_chapter

TARGET_CHARS = 300


def sample_text(document: Document) -> str:
    for chapter in document.chapters:
        for raw in re.split(r"\n\s*\n", chapter.text):
            paragraph = " ".join(raw.split())
            if not re.search(r"\w", paragraph):
                continue
            if len(paragraph) <= TARGET_CHARS:
                return paragraph

            parts = sentences(paragraph, lambda text: normalize(text, document.language))
            text = ""
            for part in parts:
                candidate = f"{text} {part}".strip()
                if len(candidate) > TARGET_CHARS:
                    break
                text = candidate
            if text:
                return text
            # The first sentence can have no usable stop near 300 characters.
            if len(parts[0]) <= 360:
                return parts[0]
            prefix = paragraph[:TARGET_CHARS + 1]
            stop = prefix.rfind(" ")
            return prefix[:stop] if stop > 0 else paragraph[:TARGET_CHARS]

    raise ValueError("The Document has no body text to read.")


def make_sample(document: Document, voice: VoiceRef, speed: float, path: Path) -> tuple[float, float]:
    started = time.monotonic()
    engine = get_engine(voice.engine)
    text = sample_text(document)
    body = tuple(segments(text, engine.max_chars, lambda part: normalize(part, document.language)))
    chapter = ChapterPlan(0, document.title, (), body)
    rendered, _ = render_chapter(chapter, Plan(document, voice, speed, (chapter,)), engine, ChunkCache())
    encoding = time.monotonic()
    audio.encode_chapter(rendered, path, title=document.title, album=document.title, artist=document.author, track=1)
    return encoding - started, time.monotonic() - encoding
