"""Web pages: fetch, then trafilatura for title, author, main text and image."""

from __future__ import annotations

import re
import tempfile
from pathlib import Path
from urllib.parse import unquote, urlparse

import httpx

from fama_worker.extract.common import markdown_chapters
from fama_worker.model import Cover, Document

USER_AGENT = "fama-worker/0.1 (open source text-to-speech reader)"
MAX_COVER_BYTES = 5 * 1024 * 1024


def fetch(url: str) -> httpx.Response:
    response = httpx.get(url, follow_redirects=True, timeout=30, headers={"User-Agent": USER_AGENT})
    response.raise_for_status()
    return response


def _site_title(title: str | None) -> str | None:
    if not title:
        return None
    return re.split(r"\s+[|–—-]\s+(?=[^|–—-]*$)", title)[0].strip() or title


def _author(author: str | None) -> str | None:
    # Trafilatura sometimes returns page furniture (Wikipedia: "Authority control databases ...").
    return author if author and len(author.split()) <= 6 else None


def _cover(url: str | None) -> Cover | None:
    if not url:
        return None
    try:
        response = fetch(url)
    except httpx.HTTPError:
        return None
    kind = response.headers.get("content-type", "")
    ext = "png" if "png" in kind else "jpg" if "jpeg" in kind or "jpg" in kind else None
    if ext is None or len(response.content) > MAX_COVER_BYTES:
        return None
    return Cover(response.content, ext)


def from_html(html: str, url: str | None, fallback_title: str) -> tuple[Document, str]:
    """Return the document (language unset) and its plain text for language detection."""
    import trafilatura

    markdown = trafilatura.extract(html, url=url, output_format="markdown", include_formatting=True,
                                   include_tables=False, include_comments=False, include_links=False,
                                   include_images=False)
    if not markdown:
        raise ValueError("Found no article text on this page.")
    meta = trafilatura.extract_metadata(html, default_url=url)
    title = _site_title(meta.title if meta else None) or fallback_title
    h1, chapters = markdown_chapters(markdown, title)
    document = Document(
        title=h1 or title,
        author=_author(meta.author if meta else None),
        language="",
        chapters=tuple(chapters),
        cover=_cover(meta.image if meta else None),
    )
    declared = re.search(r"<html[^>]*\blang=[\"']?([a-zA-Z]{2,3})", html[:5000])
    return document, (meta.language if meta and meta.language else None) or (declared[1].lower() if declared else "")


def url_title(url: str) -> str:
    parsed = urlparse(url)
    tail = unquote(parsed.path.rstrip("/").rsplit("/", 1)[-1]).replace("_", " ")
    return tail or parsed.netloc


def download(url: str) -> tuple[httpx.Response, Path | None]:
    """Fetch the URL. A PDF or EPUB lands in a temporary file for the file extractors."""
    response = fetch(url)
    kind = response.headers.get("content-type", "").split(";")[0].strip()
    suffix = {"application/pdf": ".pdf", "application/epub+zip": ".epub"}.get(kind)
    if suffix is None and Path(urlparse(url).path).suffix.lower() in (".pdf", ".epub"):
        suffix = Path(urlparse(url).path).suffix.lower()
    if suffix is None:
        return response, None
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as handle:
        handle.write(response.content)
    return response, Path(handle.name)
