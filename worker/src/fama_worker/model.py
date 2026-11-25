"""Typed model shared by every stage. Terms follow CONTEXT.md."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import numpy as np


@dataclass(frozen=True)
class UrlSource:
    url: str


@dataclass(frozen=True)
class TextSource:
    title: str | None
    text: str


@dataclass(frozen=True)
class FileSource:
    path: Path
    content_type: str | None = None
    base_url: str | None = None


Source = UrlSource | TextSource | FileSource


@dataclass(frozen=True)
class Cover:
    data: bytes
    ext: Literal["jpg", "png"]


@dataclass(frozen=True)
class Chapter:
    title: str
    text: str


@dataclass(frozen=True)
class Document:
    title: str
    author: str | None
    language: str
    chapters: tuple[Chapter, ...]
    cover: Cover | None = None

    def to_json(self) -> dict:
        """The stored shape, `Document` in docs/api.md. The cover is a file of its own."""
        return {
            "title": self.title,
            "author": self.author,
            "language": self.language,
            "chapters": [{"title": c.title, "text": c.text} for c in self.chapters],
        }

    @staticmethod
    def from_json(data: dict, cover: Cover | None = None) -> Document:
        chapters = tuple(Chapter(c["title"], c["text"]) for c in data["chapters"])
        return Document(data["title"], data["author"], data["language"], chapters, cover)


@dataclass(frozen=True)
class VoiceRef:
    """`engine:voiceId`, for example `kokoro:af_heart`."""

    engine: str
    voice_id: str

    @staticmethod
    def parse(value: str) -> VoiceRef:
        engine, sep, voice_id = value.partition(":")
        if not sep or not engine or not voice_id:
            raise ValueError(f"Voice must be engine:voiceId, got {value!r}")
        return VoiceRef(engine, voice_id)

    def __str__(self) -> str:
        return f"{self.engine}:{self.voice_id}"


@dataclass(frozen=True)
class Voice:
    ref: VoiceRef
    name: str
    language: str
    gender: Literal["female", "male"] | None

    def to_json(self) -> dict:
        return {
            "id": str(self.ref),
            "engine": self.ref.engine,
            "name": self.name,
            "language": self.language,
            "gender": self.gender,
        }


@dataclass(frozen=True)
class Audio:
    samples: np.ndarray = field(repr=False)  # mono float32 in [-1, 1]
    sample_rate: int

    @property
    def duration_s(self) -> float:
        return len(self.samples) / self.sample_rate
