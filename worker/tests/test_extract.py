import zipfile
from pathlib import Path

import pytest
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

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
    width, height = A4
    doc = canvas.Canvas(str(path), pagesize=A4)
    doc.setTitle("City Book")
    doc.setAuthor("Jón")
    lines = ["This is a long paragraph about the history of the city and how it grew over the cen-",
             "turies into a capital that people visit for its harbour and its swimming pools."]
    for number in range(1, 7):
        doc.setFont("Helvetica", 9)
        doc.drawString(72, height - 30, "A RUNNING HEADER")
        y = height - 100
        if number in (1, 4):
            part = f"Part {1 if number == 1 else 2}"
            key = f"part-{number}"
            doc.bookmarkPage(key)
            doc.addOutlineEntry(part, key, level=0)
            doc.setFont("Helvetica-Bold", 18)
            doc.drawString(72, y, part)
            y -= 40
        doc.setFont("Helvetica", 11)
        for line in lines:
            doc.drawString(72, y, line)
            y -= 14
        doc.setFont("Helvetica", 9)
        doc.drawString(300, height - 800, str(number))
        doc.showPage()
    doc.save()
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


def test_pdf_falls_back_to_largest_horizontal_title_and_joins_page_break(tmp_path):
    path = tmp_path / "paper.pdf"
    width, height = A4
    doc = canvas.Canvas(str(path), pagesize=A4)
    doc.setTitle("Untitled")
    doc.setAuthor("")

    # Rotated margin stamp in a larger font must be skipped when detecting the title.
    doc.saveState()
    doc.translate(24, 200)
    doc.rotate(90)
    doc.setFont("Helvetica", 22)
    doc.drawString(0, 0, "arXiv:2601.00001v1 [cs.CL] 1 Jan 2026")
    doc.restoreState()

    doc.setFont("Helvetica-Bold", 18)
    doc.drawString(72, height - 100, "Harbour Currents")
    doc.setFont("Helvetica", 11)
    doc.drawString(72, height - 140, "The fishing fleet leaves the bay before dawn and follows the warm")
    doc.showPage()

    doc.setFont("Helvetica", 11)
    doc.drawString(72, height - 100, "coastal current toward the northern fishing grounds every winter morning.")
    doc.showPage()
    doc.save()

    document = extract(FileSource(path))
    assert document.title == "Harbour Currents"
    assert document.author is None
    assert "warm coastal current" in document.chapters[0].text
    assert "arXiv" not in document.chapters[0].text


def test_pdf_skips_text_that_the_page_does_not_show(tmp_path):
    path = tmp_path / "placed.pdf"
    width, height = A4
    doc = canvas.Canvas(str(path), pagesize=A4)
    doc.setTitle("Placed Pages")
    doc.setFont("Helvetica", 11)
    doc.drawString(72, height - 100, "The harbour master reads the tide tables each morning before the boats leave.")
    # A neighbour page that the layout tool left next to the page.
    doc.drawString(-400, height - 130, "The neighbour page is outside the page box.")
    # An old header that a clip path cuts away.
    doc.saveState()
    clip = doc.beginPath()
    clip.rect(72, height - 170, 400, 20)
    doc.clipPath(clip, stroke=0, fill=0)
    doc.drawString(72, height - 165, "The clip shows this sentence about the lighthouse keeper.")
    doc.drawString(72, height - 300, "The clip hides this old header.")
    doc.restoreState()
    # A placed form has its own space: its clip moves with it to the place on the page.
    doc.beginForm("placed")
    clip = doc.beginPath()
    clip.rect(0, 0, 400, 20)
    doc.clipPath(clip, stroke=0, fill=0)
    doc.drawString(0, 5, "The placed form shows this sentence about the ferry.")
    doc.drawString(0, 100, "The placed form cuts this line.")
    doc.endForm()
    doc.saveState()
    doc.translate(72, 300)
    doc.doForm("placed")
    doc.restoreState()
    doc.showPage()
    doc.save()

    text = extract(FileSource(path)).chapters[0].text
    assert "tide tables" in text and "lighthouse keeper" in text and "about the ferry" in text
    assert "neighbour page" not in text and "old header" not in text and "cuts this line" not in text


def test_pdf_drops_a_running_header_with_the_page_number_on_alternating_sides(tmp_path):
    path = tmp_path / "bill.pdf"
    _, height = A4
    places = ["Harbour", "Lighthouse", "Glacier", "Meadow", "Quarry", "Orchard",
              "Ferry", "Bakery", "Library", "Foundry", "Vineyard", "Tannery"]
    rows = ["dues", "rent", "tolls", "wages", "repairs", "grants"]
    doc = canvas.Canvas(str(path), pagesize=A4)
    doc.setTitle("Budget Bill")
    for number, place in enumerate(places, start=1):
        # Draw the header fragments between body rows so PDFium puts them in separate blocks.
        header = (
            [(72, "Section 02"), (330, "Budget Bill 1"), (510, str(number))]
            if number % 2
            else [(72, str(number)), (180, "Budget Bill 1"), (460, "Section 02")]
        )
        y = height - 90
        for index, row in enumerate(rows):
            if index < len(header):
                x, label = header[index]
                if label != "Section 02" or number > 6:
                    doc.setFont("Helvetica", 9)
                    doc.drawString(x, height - 40, label)
            doc.setFont("Helvetica", 11)
            doc.drawString(72, y, f"{place} {row}")
            doc.drawString(330, y, f"{place} {row} paid")
            y -= 30
        doc.drawString(72, y - 20, f"The {place.lower()} accounts close at the end of the year, and the town council reads them")
        doc.drawString(72, y - 34, "in an open meeting before it sets the budget for the next year.")
        doc.showPage()
    doc.save()

    text = "\n\n".join(chapter.text for chapter in extract(FileSource(path)).chapters)
    assert "Budget Bill" not in text and "Section 02" not in text
    assert not any(paragraph.strip().isdigit() for paragraph in text.split("\n\n"))
    for place in places:
        assert f"The {place.lower()} accounts close" in text
        for row in rows:
            assert f"{place} {row}" in text and f"{place} {row} paid" in text


def test_pdf_without_text_layer_raises_plain_error(tmp_path):
    path = tmp_path / "scan.pdf"
    doc = canvas.Canvas(str(path), pagesize=A4)
    doc.rect(72, 72, 200, 200)
    doc.showPage()
    doc.save()

    with pytest.raises(ValueError, match="This PDF has no text layer"):
        extract(FileSource(path))


def test_a_refused_page_names_the_site_and_the_code():
    from fama_worker.extract.web import refusal

    url = "https://www.mbl.is/frettir/innlent/2026/11/24/a/"
    assert refusal(url, 403) == "mbl.is blocked the request (403)."
    assert refusal(url, 404) == "mbl.is has no page at this link (404)."
    assert refusal(url, 500) == "mbl.is answered with an error (500)."
