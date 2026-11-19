"""Extraction: Source -> Document. Language is detected from the text; a declared language breaks ties."""

from __future__ import annotations

import dataclasses
from pathlib import Path

from fama_worker.extract.common import split_long
from fama_worker.extract.lang import detect_language
from fama_worker.model import Document, FileSource, Source, TextSource, UrlSource

_SUFFIX_BY_TYPE = {
    "application/pdf": ".pdf",
    "application/epub+zip": ".epub",
    "text/html": ".html",
    "text/markdown": ".md",
    "text/plain": ".txt",
}


def _file(path: Path, content_type: str | None) -> Document:
    suffix = path.suffix.lower() or _SUFFIX_BY_TYPE.get((content_type or "").split(";")[0], "")
    if suffix == ".pdf":
        from fama_worker.extract.pdf import extract_pdf

        return extract_pdf(path)
    if suffix == ".epub":
        from fama_worker.extract.epub import extract_epub

        return extract_epub(path)
    text = path.read_text(encoding="utf-8", errors="replace")
    if suffix in (".html", ".htm", ".xhtml"):
        from fama_worker.extract.web import from_html

        return from_html(text, None, path.stem)[0]
    if suffix in (".txt", ".md", ".markdown", ""):
        from fama_worker.extract.plain import from_text

        return from_text(text, path.stem if suffix == ".txt" else None)
    raise ValueError(f"Unsupported file type {suffix!r}. Use PDF, EPUB, TXT, MD or HTML.")


def _url(url: str) -> Document:
    from fama_worker.extract import web

    response, downloaded = web.download(url)
    if downloaded is not None:
        try:
            return _file(downloaded, None)
        finally:
            downloaded.unlink(missing_ok=True)
    document, declared = web.from_html(response.text, str(response.url), web.url_title(url))
    return dataclasses.replace(document, language=declared)


def extract(source: Source, language: str | None = None) -> Document:
    match source:
        case UrlSource(url):
            document = _url(url)
        case TextSource(title, text):
            from fama_worker.extract.plain import from_text

            document = from_text(text, title)
        case FileSource(path, content_type):
            document = _file(path, content_type)
    declared = document.language or None
    chapters = split_long(list(document.chapters))
    if not chapters:
        raise ValueError("Found no text to read in this source.")
    text = "\n".join(c.text for c in chapters)
    return dataclasses.replace(document, chapters=tuple(chapters),
                               language=language or detect_language(text, declared))
