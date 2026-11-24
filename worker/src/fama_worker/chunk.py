"""Split chapter text into Segments: the pieces an engine synthesizes in one call.

A Segment is one sentence, so the timing file can say when each sentence starts. It has
two texts: `text` as the Document has it, for the reader, and `spoken`, which the engine
reads. So the split runs on the Document text, and each piece is normalized after.

A Segment never crosses a paragraph. A sentence shorter than MIN_CHARS ("Oh dear!") joins
the next one: each call has a fixed cost, and a very short call sounds clipped. A sentence
longer than the engine's limit splits at clause marks, then words.
"""

from __future__ import annotations

import functools
import re
from collections.abc import Callable
from dataclasses import dataclass

MIN_CHARS = 20

# The space after a sentence end. A closing quote or bracket stays with the sentence it closes.
_SENTENCE_END = re.compile(r"[.!?…][\"')\]]*(\s+)(?=[\"'(\[]?[A-ZÁÉÍÓÚÝÞÆÖÄÜÅØ0-9])")
_CLAUSE_END = re.compile(r"(?<=[,;:])\s+")
_ENDS_SENTENCE = re.compile(r"[.!?…][\"')\]]*$")
# "J." and "U.S.": letters with a dot each. More often an initial than the end of a sentence.
_ENDS_WITH_INITIALS = re.compile(r"(?:^|\s)[\"'(\[]*(?:[^\W\d_]\.)+$")

Speak = Callable[[str], str]
"""Document text to the text the engine reads, for one language."""


@dataclass(frozen=True)
class Segment:
    text: str  # as the Document has it
    spoken: str  # what the engine reads
    ends_paragraph: bool


def _is_cut(left: str, right: str, speak: Speak) -> bool:
    """Whether the engine reads the two pieces apart as it reads them together.

    "Dr. Smith" and "kl. 5" look like a sentence end. They are not one: read alone, "kl."
    is the letters k and l."""
    if _ENDS_WITH_INITIALS.search(left):
        return False
    spoken = speak(left)
    return bool(_ENDS_SENTENCE.search(spoken)) and speak(f"{left} {right}") == f"{spoken} {speak(right)}"


def sentences(paragraph: str, speak: Speak) -> list[str]:
    ends = [match.span(1) for match in _SENTENCE_END.finditer(paragraph)]
    starts = [0, *(end for _, end in ends)]
    stops = [*(start for start, _ in ends), len(paragraph)]
    out: list[str] = []
    for piece in (paragraph[start:stop] for start, stop in zip(starts, stops)):
        if out and not _is_cut(out[-1], piece, speak):
            out[-1] = f"{out[-1]} {piece}"
        else:
            out.append(piece)
    return out


def _join(pieces: list[str], limit: int, target: int, speak: Speak) -> list[str]:
    """Join each piece shorter than `target` to the next one, while one call can read the result."""

    def fits(piece: str) -> bool:
        return len(speak(piece)) <= limit

    out: list[str] = []
    for piece in pieces:
        if out and len(speak(out[-1])) < target and fits(f"{out[-1]} {piece}"):
            out[-1] = f"{out[-1]} {piece}"
        else:
            out.append(piece)
    if len(out) > 1 and len(speak(out[-1])) < target and fits(f"{out[-2]} {out[-1]}"):
        out[-2:] = [f"{out[-2]} {out[-1]}"]
    return out


def _fit(piece: str, limit: int, speak: Speak) -> list[str]:
    """Break one sentence that is longer than the limit."""
    if len(speak(piece)) <= limit:
        return [piece]
    parts = _CLAUSE_END.split(piece)
    if len(parts) == 1:
        parts = piece.split(" ")
        if len(parts) == 1:
            return [piece[i : i + limit] for i in range(0, len(piece), limit)]
    return _join([p for part in parts for p in _fit(part, limit, speak)], limit, limit, speak)


def segments(text: str, limit: int, speak: Speak, min_chars: int = MIN_CHARS) -> list[Segment]:
    speak = functools.cache(speak)
    out: list[Segment] = []
    for paragraph in re.split(r"\n\s*\n", text):
        paragraph = " ".join(paragraph.split())
        if not re.search(r"\w", speak(paragraph)):
            continue
        pieces = [p for sentence in sentences(paragraph, speak) for p in _fit(sentence, limit, speak)]
        pieces = _join(pieces, limit, min_chars, speak)
        out.extend(Segment(p, speak(p), ends_paragraph=i == len(pieces) - 1) for i, p in enumerate(pieces))
    return out
