"""Split chapter text into chunks an engine can synthesize in one call.

A chunk never crosses a paragraph. Sentences pack into a chunk up to the engine's
character limit, because one call per paragraph is faster than one per sentence and
sounds more natural. A sentence longer than the limit splits at clause marks, then words.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

_SENTENCE_END = re.compile(r"(?<=[.!?…])[\"')\]]*\s+(?=[\"'(\[]?[A-ZÁÉÍÓÚÝÞÆÖÄÜÅØ0-9])")
_CLAUSE_END = re.compile(r"(?<=[,;:])\s+")


@dataclass(frozen=True)
class Chunk:
    text: str
    ends_paragraph: bool


def sentences(paragraph: str) -> list[str]:
    return [s.strip() for s in _SENTENCE_END.split(paragraph) if s.strip()]


def _fit(piece: str, limit: int) -> list[str]:
    """Break one sentence that is longer than the limit."""
    if len(piece) <= limit:
        return [piece]
    parts = _CLAUSE_END.split(piece)
    if len(parts) == 1:
        parts = piece.split(" ")
        if len(parts) == 1:
            return [piece[i : i + limit] for i in range(0, len(piece), limit)]
    return _pack([p for part in parts for p in _fit(part, limit)], limit)


def _pack(pieces: list[str], limit: int) -> list[str]:
    out: list[str] = []
    for piece in pieces:
        if out and len(out[-1]) + 1 + len(piece) <= limit:
            out[-1] = f"{out[-1]} {piece}"
        else:
            out.append(piece)
    return out


def chunk_text(text: str, limit: int) -> list[Chunk]:
    chunks: list[Chunk] = []
    for paragraph in re.split(r"\n\s*\n", text):
        paragraph = " ".join(paragraph.split())
        if not re.search(r"\w", paragraph):
            continue
        pieces = _pack([p for s in sentences(paragraph) for p in _fit(s, limit)], limit)
        chunks.extend(Chunk(p, ends_paragraph=i == len(pieces) - 1) for i, p in enumerate(pieces))
    return chunks
