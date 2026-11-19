import zipfile
from pathlib import Path

import pymupdf

from fama_worker.extract import extract
from fama_worker.extract.common import markdown_chapters, split_long
from fama_worker.model import Chapter, FileSource, TextSource

PROSE = "The quick brown fox jumps over the lazy dog while the farmer watches from the porch. " * 6


def test_article_drops_citation_sections_and_reads_headings_inline():
    markdown = f"# Title\n\nLead {PROSE}\n\n## History\n\n{PROSE}<sup>\\[1\\]</sup>\n\n## References\n\n1. ↑ A source\n\n## External links\n\n- Link"
    h1, chapters = markdown_chapters(markdown, "Fallback")
    assert h1 == "Title"
    assert len(chapters) == 1
    assert "History." in chapters[0].text
    assert "source" not in chapters[0].text and "[1]" not in chapters[0].text and "Link" not in chapters[0].text


def test_long_article_splits_at_top_sections():
    body = PROSE * 10
    markdown = f"# T\n\n{body}\n\n## Saga\n\n{body}\n\n### Undirkafli\n\n{body}\n\n## Landafræði\n\n{body}\n\n## Tilvísanir\n\nx"
    _, chapters = markdown_chapters(markdown, "T")
    assert [c.title for c in chapters] == ["T", "Saga", "Landafræði"]
    assert "Undirkafli." in chapters[1].text


def test_split_long_cuts_at_paragraphs():
    chapter = Chapter("Long", "\n\n".join(["word " * 100] * 30))
    parts = split_long([chapter], limit=1000)
    assert [p.title for p in parts] == ["Long", "Long (2)", "Long (3)"]
    assert sum(len(p.text.split()) for p in parts) == 3000


def test_pasted_text_strips_gutenberg_and_detects_language():
    text = ("*** START OF THE PROJECT GUTENBERG EBOOK X ***\n" + "Reykjavík er höfuðborg Íslands og fjölmennasta "
            "sveitarfélag landsins. Þar búa flestir landsmenn.\n" * 5 + "*** END OF THE PROJECT GUTENBERG EBOOK X ***\nLicense")
    document = extract(TextSource(None, text))
    assert document.language == "is"
    assert "License" not in document.chapters[0].text and "GUTENBERG" not in document.chapters[0].text


def _epub(path: Path) -> Path:
    chapter = lambda anchor, title: f'<h2 id="{anchor}">{title}</h2><p>{PROSE}</p>'
    files = {
        "mimetype": "application/epub+zip",
        "META-INF/container.xml": '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
        "OEBPS/content.opf": """<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/">
<metadata><dc:title>A Book</dc:title><dc:creator>An Author</dc:creator><dc:language>en</dc:language></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>
<item id="img" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>
<item id="body" href="text.xhtml" media-type="application/xhtml+xml"/>
<item id="lic" href="license.xhtml" media-type="application/xhtml+xml"/></manifest>
<spine><itemref idref="cover" linear="no"/><itemref idref="body"/><itemref idref="lic"/></spine></package>""",
        "OEBPS/nav.xhtml": """<html xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol>
<li><a href="text.xhtml#copy">Copyright</a></li><li><a href="text.xhtml#c1">Chapter One</a></li>
<li><a href="text.xhtml#c2">Chapter Two</a></li><li><a href="license.xhtml">The Full Project Gutenberg License</a></li></ol></nav></body></html>""",
        "OEBPS/cover.xhtml": "<html><body><img src='cover.jpg'/></body></html>",
        "OEBPS/cover.jpg": "\xff\xd8 not really a jpeg",
        "OEBPS/text.xhtml": f"<html><body><section id='pg-header'><p>{PROSE} Project Gutenberg header</p></section>{chapter('copy', 'Copyright')}{chapter('c1', 'Chapter One')}{chapter('c2', 'Chapter Two')}</body></html>",
        "OEBPS/license.xhtml": f"<html><body><p>{PROSE}</p></body></html>",
    }
    with zipfile.ZipFile(path, "w") as archive:
        for name, data in files.items():
            archive.writestr(name, data)
    return path


def test_epub_chapters_follow_the_toc_and_skip_front_matter(tmp_path):
    document = extract(FileSource(_epub(tmp_path / "book.epub")))
    assert (document.title, document.author, document.language) == ("A Book", "An Author", "en")
    assert [c.title for c in document.chapters] == ["Chapter One", "Chapter Two"]
    assert not document.chapters[0].text.startswith("Chapter One")
    assert "header" not in document.chapters[0].text
    assert document.cover is not None and document.cover.ext == "jpg"


def _pdf(path: Path) -> Path:
    doc = pymupdf.open()
    lines = ["This is a long paragraph about the history of the city and how it grew over the cen-",
             "turies into a capital that people visit for its harbour and its swimming pools."]
    for number in range(1, 7):
        page = doc.new_page()
        page.insert_text((72, 30), "A RUNNING HEADER", fontsize=9)
        y = 100
        if number in (1, 4):
            page.insert_text((72, y), f"Part {1 if number == 1 else 2}", fontsize=18)
            y += 40
        for line in lines:
            page.insert_text((72, y), line, fontsize=11)
            y += 14
        page.insert_text((300, 800), str(number), fontsize=9)
    doc.set_toc([[1, "Part 1", 1], [1, "Part 2", 4]])
    doc.set_metadata({"title": "City Book", "author": "Jón"})
    doc.save(path)
    return path


def test_pdf_uses_toc_and_drops_headers_page_numbers_and_hyphens(tmp_path):
    document = extract(FileSource(_pdf(tmp_path / "city.pdf")))
    assert document.title == "City Book" and document.author == "Jón"
    assert [c.title for c in document.chapters] == ["Part 1", "Part 2"]
    text = document.chapters[0].text
    assert "RUNNING HEADER" not in text
    assert "centuries" in text and "cen-" not in text
    assert not any(line.strip().isdigit() for line in text.splitlines())
    assert not text.startswith("Part 1")
