"""EPUB: spine order, chapters from the TOC, no cover, copyright, contents or license pages."""

from __future__ import annotations

import posixpath
import re
import warnings
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import unquote

from bs4 import BeautifulSoup, XMLParsedAsHTMLWarning

from fama_worker.extract.common import FRONT_MATTER, MIN_CHAPTER_WORDS, words
from fama_worker.model import Chapter, Cover, Document

_BLOCKS = ["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "pre", "dd", "dt", "td", "div"]
_LICENSE = re.compile(r"project gutenberg(?:-tm)? license|START OF (?:THE|THIS) PROJECT GUTENBERG", re.IGNORECASE)
LEAD_MIN_WORDS = 300


@dataclass
class _Section:
    title: str | None
    paragraphs: list[str] = field(default_factory=list)


def _resolve(base: str, href: str) -> tuple[str, str]:
    path, _, fragment = unquote(href).partition("#")
    return posixpath.normpath(posixpath.join(base, path)), fragment


def _toc(archive: zipfile.ZipFile, opf: BeautifulSoup, base: str, manifest: dict) -> list[tuple[str, str, str]]:
    """Return (title, file, fragment) for top-level TOC entries, in reading order."""
    nav = opf.find("item", properties=re.compile(r"\bnav\b"))
    entries: list[tuple[int, str, str, str]] = []
    if nav is not None:
        nav_path = posixpath.normpath(posixpath.join(base, unquote(nav["href"])))
        soup = BeautifulSoup(archive.read(nav_path), "xml")
        toc = next((n for n in soup.find_all("nav") if "toc" in (n.get("epub:type") or n.get("type") or "")),
                   soup.find("nav"))
        for link in toc.find_all("a") if toc else []:
            if link.get("href"):
                depth = len(link.find_parents("ol")) - 1
                entries.append((depth, " ".join(link.get_text(" ").split()),
                                *_resolve(posixpath.dirname(nav_path), link["href"])))
    else:
        spine = opf.find("spine")
        ncx_id = spine.get("toc") if spine else None
        if ncx_id in manifest:
            ncx_path = manifest[ncx_id][0]
            soup = BeautifulSoup(archive.read(ncx_path), "xml")
            for point in soup.find_all("navPoint"):
                label, content = point.find("navLabel"), point.find("content")
                if label and content and content.get("src"):
                    depth = len(point.find_parents("navPoint"))
                    entries.append((depth, " ".join(label.get_text(" ").split()),
                                    *_resolve(posixpath.dirname(ncx_path), content["src"])))
    top = [e for e in entries if e[0] == 0]
    chosen = top if len(top) >= 2 else entries
    return [(title, path, fragment) for _, title, path, fragment in chosen if title]


def _cover(archive: zipfile.ZipFile, opf: BeautifulSoup, manifest: dict) -> Cover | None:
    meta = opf.find("meta", attrs={"name": "cover"})
    item = next((i for i, (_, _, props) in manifest.items() if "cover-image" in props), None)
    item = item or (meta.get("content") if meta else None)
    if item not in manifest:
        return None
    path, media_type, _ = manifest[item]
    ext = {"image/jpeg": "jpg", "image/png": "png"}.get(media_type)
    try:
        data = archive.read(path)
    except KeyError:
        return None
    return Cover(data, ext) if ext and len(data) < 10 * 1024 * 1024 else None


def _events(html: bytes, markers: dict[str, str]):
    """Yield ("mark", title) where a TOC entry points, and ("text", paragraph) for leaf blocks."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", XMLParsedAsHTMLWarning)
        soup = BeautifulSoup(html, "lxml")
    for junk in soup.find_all(["script", "style", "nav", "img", "svg"]):
        junk.decompose()
    for junk in soup.find_all(id=re.compile(r"^pg-(header|footer|machine-header|start-separator|end-separator)")):
        junk.decompose()
    body = soup.body or soup
    for element in body.find_all(True):
        if element.get("id") in markers:
            yield "mark", markers[element["id"]]
        if element.name in _BLOCKS and not element.find(_BLOCKS):
            text = " ".join(element.get_text(" ").split())
            if text:
                yield "text", text


def _looks_like_contents(paragraphs: list[str]) -> bool:
    return len(paragraphs) >= 8 and sum(words(p) for p in paragraphs) / len(paragraphs) < 6


def _keep(section: _Section) -> bool:
    body = " ".join(section.paragraphs)
    return (words(body) >= MIN_CHAPTER_WORDS and not _LICENSE.search(body)
            and not FRONT_MATTER.search(section.title or "") and not _looks_like_contents(section.paragraphs))


def _key(text: str) -> str:
    return re.sub(r"\W+", "", text.lower())


def _without_heading(title: str, paragraphs: list[str]) -> list[str]:
    """Drop the heading lines the narrator already reads as the chapter title."""
    remaining = _key(title)
    while paragraphs and _key(paragraphs[0]) and remaining.startswith(_key(paragraphs[0])):
        remaining = remaining[len(_key(paragraphs[0])):]
        paragraphs = paragraphs[1:]
    return paragraphs


def extract_epub(path: Path) -> Document:
    with zipfile.ZipFile(path) as archive:
        container = BeautifulSoup(archive.read("META-INF/container.xml"), "xml")
        opf_path = container.find("rootfile")["full-path"]
        base = posixpath.dirname(opf_path)
        opf = BeautifulSoup(archive.read(opf_path), "xml")
        manifest = {
            item["id"]: (posixpath.normpath(posixpath.join(base, unquote(item["href"]))), item.get("media-type", ""),
                         item.get("properties", "").split())
            for item in opf.find("manifest").find_all("item") if item.get("id") and item.get("href")
        }
        spine = [ref["idref"] for ref in opf.find("spine").find_all("itemref") if ref.get("linear") != "no"]
        toc = _toc(archive, opf, base, manifest)
        title_tag, author_tag = opf.find("dc:title") or opf.find("title"), opf.find("dc:creator") or opf.find("creator")
        title = " ".join(title_tag.get_text().split()) if title_tag else path.stem
        author = " ".join(author_tag.get_text().split()) if author_tag else None
        language_tag = opf.find("dc:language") or opf.find("language")
        language = language_tag.get_text().strip()[:2].lower() if language_tag else ""
        cover = _cover(archive, opf, manifest)

        sections = [_Section(None)]
        for idref in spine:
            if idref not in manifest or "html" not in manifest[idref][1]:
                continue
            file = manifest[idref][0]
            entries = [(t, frag) for t, f, frag in toc if f == file]
            whole_file = next((t for t, frag in entries if not frag), None)
            if whole_file:
                sections.append(_Section(whole_file))
            elif not toc:
                sections.append(_Section(None))
            markers = {frag: t for t, frag in entries if frag}
            for kind, value in _events(archive.read(file), markers):
                if kind == "mark":
                    sections.append(_Section(value))
                else:
                    sections[-1].paragraphs.append(value)

    chapters = []
    for index, section in enumerate(sections):
        if section.title is None:
            if toc and index == 0 and words(" ".join(section.paragraphs)) < LEAD_MIN_WORDS:
                continue
            section.title = section.paragraphs[0][:80] if section.paragraphs else title
        section.paragraphs = _without_heading(section.title, section.paragraphs)
        if _keep(section):
            chapters.append(Chapter(section.title, "\n\n".join(section.paragraphs)))
    return Document(title=title, author=author, language=language, chapters=tuple(chapters), cover=cover)
