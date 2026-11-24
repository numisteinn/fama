"""Text PDFs with pypdfium2: TOC chapters, no running headers, footers or page numbers."""

from __future__ import annotations

import ctypes
import math
import re
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from statistics import median

from fama_worker.extract.common import FRONT_MATTER
from fama_worker.model import Chapter, Document

_PAGE_NUMBER = re.compile(r"^\W*(?:page\s*)?(?:\d+|[ivxlcdm]+)(?:\s*(?:of|/)\s*\d+)?\W*$", re.IGNORECASE)
EDGE_BLOCKS = 2
REPEAT_SHARE = 0.3
RUNNING_MAX_WORDS = 12
MIN_LETTER_SHARE = 0.5  # below this a block is a table of numbers or an equation
LEAD_MIN_WORDS = 100


@dataclass(frozen=True)
class Paragraph:
    page: int
    text: str


@dataclass(frozen=True)
class _Line:
    x0: float
    y0: float
    x1: float
    y1: float
    size: float
    max_size: float
    rotated: bool
    soft_hyphen: bool
    text: str


@dataclass(frozen=True)
class _Block:
    x0: float
    y0: float
    x1: float
    y1: float
    lines: tuple[_Line, ...]


def _block_text(lines: tuple[_Line, ...]) -> str:
    parts: list[str] = []
    for i, line in enumerate(lines):
        if i > 0 and lines[i - 1].soft_hyphen and parts[-1].endswith("-"):
            parts[-1] = parts[-1][:-1] + line.text
        else:
            parts.append(line.text)
    raw = "\n".join(parts)
    raw = re.sub(r"(?<=\w)-\n(?=[a-záéíóúýþæöð])", "", raw)
    return " ".join(raw.split())


def _prose(text: str) -> bool:
    chars = [c for c in text if not c.isspace()]
    return bool(chars) and sum(c.isalpha() for c in chars) / len(chars) >= MIN_LETTER_SHARE


def _edge_key(text: str) -> str:
    return re.sub(r"\d+", "#", text.lower())


_Box = tuple[float, float, float, float]  # left, bottom, right, top in PDF page space
_Matrix = tuple[float, float, float, float, float, float]


def _inside(box: _Box, x: float, y: float) -> bool:
    return box[0] <= x <= box[2] and box[1] <= y <= box[3]


def _concat(first: _Matrix, then: _Matrix) -> _Matrix:
    a1, b1, c1, d1, e1, f1 = first
    a2, b2, c2, d2, e2, f2 = then
    return (
        a1 * a2 + b1 * c2,
        a1 * b2 + b1 * d2,
        c1 * a2 + d1 * c2,
        c1 * b2 + d1 * d2,
        e1 * a2 + f1 * c2 + e2,
        e1 * b2 + f1 * d2 + f2,
    )


def _clip_boxes(page) -> dict[int, _Box]:
    """Map each clipped text object to the box its clip paths leave visible, in page space.

    PDFium returns all text of a page, also text that a clip path hides. Layout tools place a
    neighbour page or an old running header on the page and clip it away, so that text must go.
    The box is the bounds of each clip path, so it can only keep too much, never too little.
    """
    import pypdfium2.raw as pdfium_c

    boxes: dict[int, _Box] = {}
    x = ctypes.c_float()
    y = ctypes.c_float()

    def clip_box(obj, matrix: _Matrix, inherited: _Box | None) -> _Box | None:
        clip = pdfium_c.FPDFPageObj_GetClipPath(obj)
        box = inherited
        for path in range(pdfium_c.FPDFClipPath_CountPaths(clip) if clip else 0):
            xs: list[float] = []
            ys: list[float] = []
            for index in range(pdfium_c.FPDFClipPath_CountPathSegments(clip, path)):
                segment = pdfium_c.FPDFClipPath_GetPathSegment(clip, path, index)
                if pdfium_c.FPDFPathSegment_GetPoint(segment, x, y):
                    xs.append(matrix[0] * x.value + matrix[2] * y.value + matrix[4])
                    ys.append(matrix[1] * x.value + matrix[3] * y.value + matrix[5])
            if not xs:
                continue
            bounds = (min(xs), min(ys), max(xs), max(ys))
            box = bounds if box is None else (
                max(box[0], bounds[0]), max(box[1], bounds[1]), min(box[2], bounds[2]), min(box[3], bounds[3])
            )
        return box

    def walk(count: int, get, matrix: _Matrix, inherited: _Box | None, depth: int) -> None:
        for index in range(count):
            obj = get(index)
            kind = pdfium_c.FPDFPageObj_GetType(obj)
            if kind == pdfium_c.FPDF_PAGEOBJ_TEXT:
                box = clip_box(obj, matrix, inherited)
                if box is not None:
                    boxes[ctypes.cast(obj, ctypes.c_void_p).value] = box
            elif kind == pdfium_c.FPDF_PAGEOBJ_FORM and depth < 16:
                # Objects in a form XObject are in the space of the form. Its matrix moves them to the parent.
                form = pdfium_c.FS_MATRIX()
                inner = matrix
                if pdfium_c.FPDFPageObj_GetMatrix(obj, form):
                    inner = _concat((form.a, form.b, form.c, form.d, form.e, form.f), matrix)
                walk(
                    pdfium_c.FPDFFormObj_CountObjects(obj),
                    lambda i, obj=obj: pdfium_c.FPDFFormObj_GetObject(obj, i),
                    inner,
                    clip_box(obj, matrix, inherited),
                    depth + 1,
                )

    walk(
        pdfium_c.FPDFPage_CountObjects(page.raw),
        lambda i: pdfium_c.FPDFPage_GetObject(page.raw, i),
        (1.0, 0.0, 0.0, 1.0, 0.0, 0.0),
        None,
        0,
    )
    return boxes


def _extract_lines(page) -> tuple[float, list[_Line]]:
    """Read character geometry from PDFium and assemble visual lines in top-down coordinates.

    Only glyphs that the page shows are read: inside the page box and inside the clip of their text object.
    """
    import pypdfium2.raw as pdfium_c

    page_w, page_h = page.get_size()
    page_box = page.get_bbox()
    clips = _clip_boxes(page)
    textpage = page.get_textpage()
    try:
        tp = textpage.raw
        n_chars = textpage.count_chars()
        if n_chars <= 0:
            return page_w, []

        rect = pdfium_c.FS_RECTF()
        mat = pdfium_c.FS_MATRIX()
        runs: list[_Line] = []

        chars: list[str] = []
        sizes: list[float] = []
        rotated_count = 0
        glyph_count = 0
        x0 = y0 = math.inf
        x1 = y1 = -math.inf
        last_soft_hyphen = False

        def flush() -> None:
            nonlocal chars, sizes, rotated_count, glyph_count, x0, y0, x1, y1, last_soft_hyphen
            text = "".join(chars).strip()
            if text and glyph_count > 0:
                runs.append(
                    _Line(
                        x0=x0,
                        y0=y0,
                        x1=x1,
                        y1=y1,
                        size=median(sizes),
                        max_size=max(sizes),
                        rotated=rotated_count > glyph_count / 2,
                        soft_hyphen=last_soft_hyphen,
                        text=text,
                    )
                )
            chars = []
            sizes = []
            rotated_count = 0
            glyph_count = 0
            x0 = y0 = math.inf
            x1 = y1 = -math.inf
            last_soft_hyphen = False

        i = 0
        while i < n_chars:
            code = pdfium_c.FPDFText_GetUnicode(tp, i)
            if code in (0x0D, 0x0A):
                flush()
                i += 1
                continue
            if code in (0, 0xFEFF, 0xFFFE):
                i += 1
                continue

            # FPDFText_GetUnicode returns UTF-16 code units; pair surrogates into one Unicode scalar.
            char_idx = i
            if 0xD800 <= code <= 0xDBFF:
                if i + 1 < n_chars:
                    low = pdfium_c.FPDFText_GetUnicode(tp, i + 1)
                    if 0xDC00 <= low <= 0xDFFF:
                        code = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00)
                        i += 2
                    else:
                        i += 1
                        continue
                else:
                    i += 1
                    continue
            elif 0xDC00 <= code <= 0xDFFF:
                i += 1
                continue
            else:
                i += 1

            is_hyphen = pdfium_c.FPDFText_IsHyphen(tp, char_idx) == 1
            ch = "-" if (is_hyphen or code == 0x02) else chr(code)

            if ch.isspace():
                if chars and chars[-1] != " ":
                    chars.append(" ")
                continue

            if not pdfium_c.FPDFText_GetLooseCharBox(tp, char_idx, ctypes.byref(rect)):
                continue
            mid_x = (rect.left + rect.right) / 2
            mid_y = (rect.top + rect.bottom) / 2
            clip = clips.get(ctypes.cast(pdfium_c.FPDFText_GetTextObject(tp, char_idx), ctypes.c_void_p).value) if clips else None
            if not _inside(page_box, mid_x, mid_y) or (clip is not None and not _inside(clip, mid_x, mid_y)):
                flush()  # a hidden glyph also ends the visible line before it
                continue
            cx0 = float(rect.left)
            cy0 = page_h - float(rect.top)
            cx1 = float(rect.right)
            cy1 = page_h - float(rect.bottom)

            fs = float(pdfium_c.FPDFText_GetFontSize(tp, char_idx))
            if pdfium_c.FPDFText_GetMatrix(tp, char_idx, ctypes.byref(mat)):
                scale = math.hypot(mat.b, mat.d)
                if scale > 0:
                    fs *= scale
            ang = float(pdfium_c.FPDFText_GetCharAngle(tp, char_idx))
            is_rot = abs(math.sin(ang)) > 0.1 or math.cos(ang) < 0.9

            # PDFium omits \r\n after soft line-break hyphens; split when the next glyph wraps to a new line.
            if glyph_count > 0 and not is_rot and rotated_count == 0:
                ref = max(fs, max(sizes))
                wrapped_left = cx0 < x0 + 0.5 * ref
                dropped = cy0 >= y1 - 0.1 * ref and cy0 > y0 + 0.6 * ref
                if (dropped and wrapped_left) or (last_soft_hyphen and (wrapped_left or cy0 > y0 + 0.5 * ref)):
                    flush()

            chars.append(ch)
            sizes.append(fs)
            glyph_count += 1
            if is_rot:
                rotated_count += 1
            if cx0 < x0:
                x0 = cx0
            if cy0 < y0:
                y0 = cy0
            if cx1 > x1:
                x1 = cx1
            if cy1 > y1:
                y1 = cy1
            last_soft_hyphen = is_hyphen or code == 0x02

        flush()
    finally:
        textpage.close()

    # Merge consecutive same-line fragments split by PDFium around inline math or font changes.
    lines: list[_Line] = []
    for run in runs:
        if lines and not lines[-1].rotated and not run.rotated:
            prev = lines[-1]
            overlap = min(prev.y1, run.y1) - max(prev.y0, run.y0)
            min_h = max(1.0, min(prev.y1 - prev.y0, run.y1 - run.y0))
            ref = max(prev.size, run.size, 1.0)
            gap_x = run.x0 - prev.x1
            continues_right = (gap_x >= -0.5 * ref) or (run.x0 >= prev.x0 and run.x1 > prev.x1 and gap_x >= -2.5 * ref)
            if overlap >= 0.4 * min_h and continues_right and gap_x <= 1.5 * ref:
                sep = " " if gap_x > 0.15 * ref and not prev.text.endswith(" ") and not run.text.startswith(" ") else ""
                lines[-1] = _Line(
                    x0=min(prev.x0, run.x0),
                    y0=min(prev.y0, run.y0),
                    x1=max(prev.x1, run.x1),
                    y1=max(prev.y1, run.y1),
                    size=max(prev.size, run.size),
                    max_size=max(prev.max_size, run.max_size),
                    rotated=False,
                    soft_hyphen=run.soft_hyphen,
                    text=prev.text + sep + run.text,
                )
                continue
        lines.append(run)
    return page_w, lines


def _group_blocks(lines: list[_Line]) -> list[_Block]:
    """Group consecutive horizontal lines into paragraph blocks."""
    horizontal = [line for line in lines if not line.rotated]
    if not horizontal:
        return []

    groups: list[list[_Line]] = []
    for line in horizontal:
        if not groups:
            groups.append([line])
            continue
        cur = groups[-1]
        prev = cur[-1]
        ref = max(prev.size, line.size, 1.0)
        min_s = max(min(prev.size, line.size), 0.1)
        same_size = abs(prev.size - line.size) <= 1.5 and ref / min_s <= 1.25
        gap_y = line.y0 - prev.y1
        close_y = -0.35 * ref <= gap_y <= 0.50 * ref
        overlaps_x = min(prev.x1, line.x1) > max(prev.x0, line.x0)
        block_x0 = min(item.x0 for item in cur)
        ends_sentence = bool(re.search(r"[.!?:\"”)]$", prev.text))
        indented_new = (
            line.x0 - block_x0 > 0.8 * ref
            and not prev.text.startswith(("•", "-", "–", "—", "*"))
            and ends_sentence
        )
        list_start = ends_sentence and bool(re.match(r"^(?:[•\-–—*]|\d+\.)\s+", line.text))
        if same_size and close_y and overlaps_x and not indented_new and not list_start:
            cur.append(line)
        else:
            groups.append([line])

    return [
        _Block(
            x0=min(line.x0 for line in group),
            y0=min(line.y0 for line in group),
            x1=max(line.x1 for line in group),
            y1=max(line.y1 for line in group),
            lines=tuple(group),
        )
        for group in groups
    ]


def _order_blocks(blocks: list[_Block], page_w: float) -> list[_Block]:
    """Order blocks top-to-bottom, preserving left-then-right column order on two-column bands."""
    if len(blocks) <= 1:
        return blocks

    sorted_blocks = sorted(blocks, key=lambda b: (round(b.y0, 1), round(b.x0, 1)))
    lo, hi = 0.42 * page_w, 0.58 * page_w

    # Full-width blocks span across the center band and act as horizontal dividers.
    full: list[_Block] = []
    narrow: list[_Block] = []
    for block in sorted_blocks:
        if block.x0 < lo and block.x1 > hi:
            full.append(block)
        else:
            narrow.append(block)

    if not narrow:
        return sorted_blocks

    def sort_band(band: list[_Block]) -> list[_Block]:
        if len(band) < 4:
            return sorted(band, key=lambda b: (round(b.y0, 1), round(b.x0, 1)))
        mid = page_w / 2
        left = [b for b in band if b.x1 <= mid + 0.02 * page_w]
        right = [b for b in band if b.x0 >= mid - 0.02 * page_w]
        if len(left) >= 2 and len(right) >= 2 and len(left) + len(right) == len(band):
            return sorted(left, key=lambda b: (round(b.y0, 1), round(b.x0, 1))) + sorted(
                right, key=lambda b: (round(b.y0, 1), round(b.x0, 1))
            )
        return sorted(band, key=lambda b: (round(b.y0, 1), round(b.x0, 1)))

    ordered: list[_Block] = []
    dividers = sorted(full, key=lambda b: (round(b.y0, 1), round(b.x0, 1)))
    remaining = narrow
    for div in dividers:
        above = [b for b in remaining if (b.y0 + b.y1) / 2 < div.y0]
        remaining = [b for b in remaining if (b.y0 + b.y1) / 2 >= div.y0]
        ordered.extend(sort_band(above))
        ordered.append(div)
    ordered.extend(sort_band(remaining))
    return ordered


def _pages(doc) -> tuple[list[list[str]], list[_Line]]:
    pages: list[list[str]] = []
    first_page_lines: list[_Line] = []
    for idx in range(len(doc)):
        page = doc[idx]
        try:
            page_w, lines = _extract_lines(page)
        finally:
            page.close()
        if idx == 0:
            first_page_lines = lines
        blocks = _order_blocks(_group_blocks(lines), page_w)
        texts = [_block_text(block.lines) for block in blocks]
        pages.append([t for t in texts if t])

    edges: Counter[str] = Counter()
    for blocks in pages:
        for text in {*blocks[:EDGE_BLOCKS], *blocks[-EDGE_BLOCKS:]}:
            edges[_edge_key(text)] += 1
    threshold = max(3, REPEAT_SHARE * len(pages))
    running = {key for key, count in edges.items() if count >= threshold}

    def keep(index: int, blocks: list[str]) -> bool:
        text = blocks[index]
        at_edge = index < EDGE_BLOCKS or index >= len(blocks) - EDGE_BLOCKS
        is_running = len(text.split()) <= RUNNING_MAX_WORDS and _edge_key(text) in running
        return not (at_edge and (_PAGE_NUMBER.match(text) or is_running))

    cleaned = [[b for i, b in enumerate(blocks) if keep(i, blocks) and _prose(b)] for blocks in pages]
    return cleaned, first_page_lines


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
    toc = list(doc.get_toc())
    if not toc:
        return []
    level = 0 if sum(1 for item in toc if item.level == 0) >= 2 else 1
    entries: list[tuple[str, int]] = []
    for item in toc:
        if item.level != level:
            continue
        dest = item.get_dest()
        page_index = dest.get_index() if dest is not None else None
        if page_index is None or page_index < 0:
            continue
        title = item.get_title().strip()
        if title:
            entries.append((title, page_index))
    return sorted(entries, key=lambda e: e[1])


def _largest_line(lines: list[_Line]) -> str | None:
    """The biggest horizontal text on the first page is the title of most papers and reports."""
    horizontal = [line for line in lines if not line.rotated and line.text.strip()]
    if not horizontal:
        return None
    top_size = max(round(line.max_size, 1) for line in horizontal)
    matching = tuple(line for line in horizontal if round(line.max_size, 1) == top_size)
    title = _block_text(matching)
    return title if 2 <= len(title) <= 200 else None


def _title(meta: dict[str, str], first_page_lines: list[_Line], path: Path) -> str:
    title = (meta.get("Title") or "").strip()
    if not title or re.match(r"(microsoft word|untitled|document)\b", title, re.IGNORECASE) or title.endswith((".doc", ".docx", ".pdf")):
        return _largest_line(first_page_lines) or path.stem.replace("_", " ")
    return title


def extract_pdf(path: Path) -> Document:
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(path)
    try:
        pages, first_page_lines = _pages(doc)
        paragraphs = _paragraphs(pages)
        entries = _toc_entries(doc)
        meta = doc.get_metadata_dict()
        title = _title(meta, first_page_lines, path)
        author = (meta.get("Author") or "").strip() or None
    finally:
        doc.close()

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
