"""Pasted text, TXT and Markdown."""

from __future__ import annotations

import re

from fama_worker.extract.common import markdown_chapters, unwrap
from fama_worker.model import Chapter, Document

_GUTENBERG_START = re.compile(r"^\*{3}\s*START OF (THE|THIS) PROJECT GUTENBERG.*$", re.IGNORECASE | re.MULTILINE)
_GUTENBERG_END = re.compile(r"^\*{3}\s*END OF (THE|THIS) PROJECT GUTENBERG.*$", re.IGNORECASE | re.MULTILINE)
_CHAPTER_LINE = re.compile(
    r"^\s*((?:chapter|book|part|kafli)\s+(?:[0-9]+|[ivxlcdm]+|[a-z]+)\b.*|[0-9]+\.\s+kafli\b.*)$",
    re.IGNORECASE | re.MULTILINE,
)
_MARKDOWN_HEADING = re.compile(r"^#{1,6}\s+\S", re.MULTILINE)


def strip_gutenberg(text: str) -> str:
    start = _GUTENBERG_START.search(text)
    if start:
        text = text[start.end():]
    end = _GUTENBERG_END.search(text)
    return text[: end.start()] if end else text


def first_words(text: str, count: int = 8) -> str:
    return " ".join(text.split()[:count]) or "Untitled"


def from_text(text: str, title: str | None) -> Document:
    text = strip_gutenberg(text.replace("\r\n", "\n"))
    title = title or first_words(text)
    if _MARKDOWN_HEADING.search(text):
        h1, chapters = markdown_chapters(text, title)
        return Document(title=h1 or title, author=None, language="", chapters=tuple(chapters))
    marks = list(_CHAPTER_LINE.finditer(text))
    if len(marks) < 2:
        return Document(title=title, author=None, language="", chapters=(Chapter(title, unwrap(text)),))
    chapters = []
    intro = unwrap(text[: marks[0].start()])
    if len(intro.split()) > 100:
        chapters.append(Chapter(title, intro))
    for mark, following in zip(marks, marks[1:] + [None]):
        body = unwrap(text[mark.end(): following.start() if following else len(text)])
        if body:
            chapters.append(Chapter(" ".join(mark[1].split()).title(), body))
    return Document(title=title, author=None, language="", chapters=tuple(chapters))
