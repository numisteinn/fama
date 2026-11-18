"""Text PDFs with PyMuPDF: TOC chapters, no running headers, footers or page numbers."""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

from fama_worker.extract.common import FRONT_MATTER
from fama_worker.model import Chapter, Document

_PAGE_NUMBER = re.compile(r"^\W*(?:page\s*)?(?:\d+|[ivxlcdm]+)(?:\s*(?:of|/)\s*\d+)?\W*$", re.IGNORECASE)
EDGE_BLOCKS = 2
REPEAT_SHARE = 0.3
MIN_LETTER_SHARE = 0.5  # below this a block is a table of numbers or an equation
LEAD_MIN_WORDS = 100


@dataclass(frozen=True)
class Paragraph:
    page: int
    text: str


def _block_text(raw: str) -> str:
    raw = re.sub(r"(?<=\w)-\n(?=[a-záéíóúýþæöð])", "", raw)
    return " ".join(raw.split())


def _prose(text: str) -> bool:
    chars = [c for c in text if not c.isspace()]
    return bool(chars) and sum(c.isalpha() for c in chars) / len(chars) >= MIN_LETTER_SHARE


def _edge_key(text: str) -> str:
    return re.sub(r"\d+", "#", text.lower())


def _pages(doc) -> list[list[str]]:
    pages = []
    for page in doc:
        blocks = [b for b in page.get_text("blocks", sort=True) if b[6] == 0]
        pages.append([_block_text(b[4]) for b in blocks if _block_text(b[4])])
    edges = Counter()
    for blocks in pages:
        for text in {*blocks[:EDGE_BLOCKS], *blocks[-EDGE_BLOCKS:]}:
            edges[_edge_key(text)] += 1
    threshold = max(3, REPEAT_SHARE * len(pages))
    running = {key for key, count in edges.items() if count >= threshold}

    def keep(index: int, blocks: list[str]) -> bool:
        text = blocks[index]
        at_edge = index < EDGE_BLOCKS or index >= len(blocks) - EDGE_BLOCKS
        return not (at_edge and (_PAGE_NUMBER.match(text) or _edge_key(text) in running))

    return [[b for i, b in enumerate(blocks) if keep(i, blocks) and _prose(b)] for blocks in pages]


def _paragraphs(pages: list[list[str]]) -> list[Paragraph]:
    """Blocks become paragraphs. A sentence cut by a page or column break joins again."""
    out: list[Paragraph] = []
    for number, blocks in enumerate(pages):
        for text in blocks:
            previous = out[-1].text if out else ""
            if previous and not re.search(r"[.!?:\"”)]$", previous) and re.match(r"[a-záéíóúýþæöð]", text):
                joined = previous[:-1] + text if previous.endswith("-") else f"{previous} {text}"
                out[-1] = Paragraph(out[-1].page, joined)
            else:
                out.append(Paragraph(number, text))
    return out


def _key(text: str) -> str:
    """Compare headings without section numbers: "5.1 Training" matches "Training"."""
    text = re.sub(r"^(?:\d+(?:\.\d+)*\.?|[ivxlcdm]+\.)\s+", "", text.lower())
    return re.sub(r"\W+", "", text)[:40]


def _toc_entries(doc) -> list[tuple[str, int]]:
    toc = doc.get_toc()
    if not toc:
        return []
    level = 1 if sum(1 for e in toc if e[0] == 1) >= 2 else 2
    entries = [(title.strip(), page - 1) for lvl, title, page in toc if lvl == level and page >= 1]
    return sorted(entries, key=lambda e: e[1])


def _largest_line(page) -> str | None:
    """The biggest text on the first page is the title of most papers and reports."""
    spans = [(round(span["size"], 1), " ".join(span["text"].split()))
             for block in page.get_text("dict")["blocks"] for line in block.get("lines", [])
             if line.get("dir", (1, 0)) == (1, 0)  # skip rotated margin text such as arXiv stamps
             for span in line["spans"] if span["text"].strip()]
    if not spans:
        return None
    size = max(s for s, _ in spans)
    title = " ".join(t for s, t in spans if s == size)
    return title if 2 <= len(title) <= 200 else None


def _title(doc, path: Path) -> str:
    title = (doc.metadata or {}).get("title", "").strip()
    if not title or re.match(r"(microsoft word|untitled|document)\b", title, re.IGNORECASE) or title.endswith((".doc", ".docx", ".pdf")):
        return (_largest_line(doc[0]) if len(doc) else None) or path.stem.replace("_", " ")
    return title


def extract_pdf(path: Path) -> Document:
    import pymupdf

    with pymupdf.open(path) as doc:
        paragraphs = _paragraphs(_pages(doc))
        entries = _toc_entries(doc)
        title = _title(doc, path)
        author = (doc.metadata or {}).get("author", "").strip() or None
    if not "".join(p.text for p in paragraphs).strip():
        raise ValueError("This PDF has no text layer. Scanned PDFs need OCR, which Fama does not do yet.")

    starts: list[tuple[str, int]] = []
    for name, page in entries:
        on_page = [i for i, p in enumerate(paragraphs) if p.page == page]
        after = [i for i, p in enumerate(paragraphs) if p.page >= page]
        if not after:
            continue
        heading = next((i for i in on_page if _key(paragraphs[i].text).startswith(_key(name)[:20])), after[0])
        if starts and heading <= starts[-1][1]:
            continue
        starts.append((name, heading))

    if not starts:
        text = "\n\n".join(p.text for p in paragraphs)
        return Document(title=title, author=author, language="", chapters=(Chapter(title, text),))
    chapters = []
    lead = paragraphs[: starts[0][1]]
    if sum(len(p.text.split()) for p in lead) >= LEAD_MIN_WORDS:
        chapters.append(Chapter(title, "\n\n".join(p.text for p in lead)))
    for (name, start), following in zip(starts, starts[1:] + [("", len(paragraphs))]):
        if FRONT_MATTER.search(name):
            continue
        body = paragraphs[start: following[1]]
        if body and _key(body[0].text) == _key(name):
            body = body[1:]
        text = "\n\n".join(p.text for p in body)
        if text.strip():
            chapters.append(Chapter(name, text))
    return Document(title=title, author=author, language="", chapters=tuple(chapters))
