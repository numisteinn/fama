"""Helpers every extractor shares: markdown to chapters, front matter, long chapters."""

from __future__ import annotations

import re

from fama_worker.model import Chapter

# Sections nobody wants narrated. Matched against chapter and section titles.
FRONT_MATTER = re.compile(
    r"^\s*(cover|title ?page|half[- ]title|(un)?copyright|contents|table of contents|dedication|also by"
    r"|imprint|colophon|index|about the publisher|efnisyfirlit|efni)\b"
    r"|project gutenberg|gutenberg license|full license",
    re.IGNORECASE,
)

# Article sections that are lists of links or citations.
END_SECTIONS = re.compile(
    r"^\s*(references|notes|footnotes|citations|sources|bibliography|further reading|see also|external links"
    r"|gallery|works cited|tilvísanir|heimildir|neðanmálsgreinar|tengt efni|tenglar|ytri tenglar|myndasafn"
    r"|tengill|ítarefni|sjá einnig)\s*$",
    re.IGNORECASE,
)

MAX_CHAPTER_WORDS = 5000
LONG_ARTICLE_WORDS = 2500
MIN_CHAPTER_WORDS = 40

_HEADING = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")


def words(text: str) -> int:
    return len(text.split())


def paragraphs(text: str) -> str:
    """Collapse whitespace inside paragraphs; keep one blank line between paragraphs."""
    blocks = (" ".join(block.split()) for block in re.split(r"\n\s*\n", text))
    return "\n\n".join(block for block in blocks if block)


def unwrap(text: str) -> str:
    """Join hard-wrapped lines inside paragraphs and words hyphenated at a line break."""
    text = re.sub(r"(?<=\w)-\n\s*(?=[a-záéíóúýþæöð])", "", text)
    return paragraphs(text)


def clean_markdown(text: str) -> str:
    text = re.sub(r"<sup>.*?</sup>", "", text, flags=re.DOTALL)
    text = re.sub(r"<[^>]+>", "", text)
    text = text.replace("\\[", "[").replace("\\]", "]").replace("\\*", "").replace("\\_", "_")
    text = re.sub(r"^\s*\[(edit|breyta[^\]]*)\]\s*$", "", text, flags=re.MULTILINE | re.IGNORECASE)
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    # IPA in brackets or slashes, as in Wikipedia lead sentences.
    text = re.sub(r"\[[^\]\n]*[ˈˌːʰ̥ʏɪœɔðθʃʒŋɛæɑ][^\]\n]*\]", "", text)
    text = re.sub(r"/[^/\s][^/\n]*[ˈˌːʰ̥ʏɪœɔðθʃʒŋɛæɑ][^/\n]*/", "", text)
    text = re.sub(r"\b[\w-]+ pronunciation:\s*[,;]?\s*", "", text)
    text = re.sub(r"(\*\*|__|\*|_)(?=\S)(.+?)(?<=\S)\1", r"\2", text)
    text = re.sub(r"^\s*(?:[-*+]|\d+\.)\s+(?=\S)", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\s*\|.*$", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\s*>\s?", "", text, flags=re.MULTILINE)
    text = re.sub(r"^.*↑.*$", "", text, flags=re.MULTILINE)
    text = re.sub(r"^.*\d+°\s*\d+[′'].*$", "", text, flags=re.MULTILINE)  # map coordinates
    return text


def _sentence(title: str) -> str:
    return title if re.search(r"[.!?:]$", title) else f"{title}."


def markdown_chapters(markdown: str, title: str) -> tuple[str | None, list[Chapter]]:
    """Split markdown at headings. Returns the H1 title (if any) and the chapters.

    Short articles stay one chapter with section titles read inline. Long ones get one
    chapter per top-level section. Citation and link sections are dropped.
    """
    sections: list[tuple[int, str, list[str]]] = [(0, "", [])]
    h1: str | None = None
    for line in markdown.splitlines():
        match = _HEADING.match(line)
        if match:
            level, heading = len(match[1]), clean_markdown(match[2]).strip()
            if level == 1 and h1 is None and not any(s[2] for s in sections):
                h1 = heading
                continue
            sections.append((level, heading, []))
        else:
            sections[-1][2].append(line)

    kept: list[tuple[int, str, str]] = []
    dropped_level: int | None = None
    for level, heading, lines in sections:
        if dropped_level is not None and level > dropped_level:
            continue
        dropped_level = None
        if heading and END_SECTIONS.match(heading):
            dropped_level = level
            continue
        body = paragraphs(clean_markdown("\n".join(lines)))
        # A lone word with no punctuation is page chrome, such as Wikipedia's "Appearance" menu.
        body = "\n\n".join(p for p in body.split("\n\n") if " " in p or re.search(r"[.!?:]$", p))
        kept.append((level, heading, body))

    title = h1 or title
    total = sum(words(body) for _, _, body in kept)
    levels = [level for level, heading, _ in kept if heading]
    split_level = min(levels) if levels and total > LONG_ARTICLE_WORDS else None

    chapters: list[tuple[str, list[str]]] = [(title, [])]
    for level, heading, body in kept:
        if split_level is not None and level == split_level:
            chapters.append((heading, []))
        elif heading:
            chapters[-1][1].append(_sentence(heading))
        if body:
            chapters[-1][1].append(body)
    result = [Chapter(t, "\n\n".join(parts)) for t, parts in chapters if any(words(p) for p in parts)]
    return h1, result


def split_long(chapters: list[Chapter], limit: int = MAX_CHAPTER_WORDS) -> list[Chapter]:
    """Cut chapters longer than `limit` words at paragraph breaks, so each uploads soon."""
    out: list[Chapter] = []
    for chapter in chapters:
        if words(chapter.text) <= limit:
            out.append(chapter)
            continue
        parts: list[list[str]] = [[]]
        count = 0
        for paragraph in chapter.text.split("\n\n"):
            if count and count + words(paragraph) > limit:
                parts.append([])
                count = 0
            parts[-1].append(paragraph)
            count += words(paragraph)
        out.extend(
            Chapter(chapter.title if i == 0 else f"{chapter.title} ({i + 1})", "\n\n".join(part))
            for i, part in enumerate(parts)
        )
    return out
