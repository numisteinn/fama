"""Write the verification fixtures into ../fixtures. Short on purpose: each narrates in seconds.

Run from the repo root: uv run --project worker python .claude/skills/verify-fama/scripts/make-fixtures.py
"""

import textwrap
import zipfile
from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

OUT = Path(__file__).resolve().parent.parent / "fixtures"

EN = [
    "The harbour wakes before the town does. Fishing boats slide out past the breakwater while the cafes "
    "are still dark, and the gulls follow them in long, lazy circles.",
    "By mid-morning the swimming pool by the shore is full. People come for the hot tubs, stay for the "
    "conversation, and leave with wet hair and a plan for the rest of the day.",
    "In the evening the light turns gold and the whole harbour goes quiet again, as if it had been waiting "
    "all day for that one hour.",
]
IS = [
    "Höfnin vaknar á undan bænum. Bátarnir sigla út fyrir brimgarðinn á meðan kaffihúsin eru enn dimm, "
    "og mávarnir fylgja þeim í löngum hringjum.",
    "Um miðjan morgun er sundlaugin við ströndina full. Fólk kemur fyrir heitu pottana, stoppar fyrir "
    "spjallið og fer heim með blautt hár.",
    "Á kvöldin verður birtan gyllt og höfnin þagnar aftur, eins og hún hafi beðið allan daginn eftir "
    "þessari einu stund.",
]


def article(path: Path, lang: str, title: str, paragraphs: list[str]) -> None:
    body = "".join(f"<p>{p}</p>" for p in paragraphs)
    path.write_text(
        f'<!doctype html><html lang="{lang}"><head><meta charset="utf-8"><title>{title}</title>'
        f'<meta name="author" content="Fama Fixtures"></head><body><nav><a href="/">Home</a></nav>'
        f"<article><h1>{title}</h1>{body}</article><footer>Cookie settings</footer></body></html>",
        encoding="utf-8",
    )


def epub(path: Path) -> None:
    chapter = lambda anchor, title, text: f'<h2 id="{anchor}">{title}</h2><p>{text}</p>'
    files = {
        "mimetype": "application/epub+zip",
        "META-INF/container.xml": '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
        "OEBPS/content.opf": """<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/">
<metadata><dc:title>Harbour Days</dc:title><dc:creator>Fama Fixtures</dc:creator><dc:language>en</dc:language></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="body" href="text.xhtml" media-type="application/xhtml+xml"/></manifest>
<spine><itemref idref="body"/></spine></package>""",
        "OEBPS/nav.xhtml": """<html xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol>
<li><a href="text.xhtml#c1">Morning</a></li><li><a href="text.xhtml#c2">Evening</a></li></ol></nav></body></html>""",
        "OEBPS/text.xhtml": f"<html><body>{chapter('c1', 'Morning', EN[0] + ' ' + EN[1])}{chapter('c2', 'Evening', EN[2] + ' ' + EN[0])}</body></html>",
    }
    with zipfile.ZipFile(path, "w") as archive:
        for name, data in files.items():
            archive.writestr(name, data)


def pdf(path: Path) -> None:
    _, height = A4
    doc = canvas.Canvas(str(path), pagesize=A4)
    doc.setTitle("Harbour Notes")
    doc.setAuthor("Fama Fixtures")
    for idx, (part, text) in enumerate((("Part One", EN[0]), ("Part Two", EN[2]))):
        key = f"part-{idx}"
        doc.bookmarkPage(key)
        doc.addOutlineEntry(part, key, level=0)
        doc.setFont("Helvetica-Bold", 18)
        doc.drawString(72, height - 100, part)
        doc.setFont("Helvetica", 11)
        y = height - 140
        for line in textwrap.wrap(text, width=82):
            doc.drawString(72, y, line)
            y -= 15
        doc.showPage()
    doc.save()


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    article(OUT / "article.html", "en", "The Quiet Harbour", EN)
    article(OUT / "grein.html", "is", "Höfnin hljóða", IS)
    epub(OUT / "harbour-days.epub")
    pdf(OUT / "harbour-notes.pdf")
    (OUT / "harbour.md").write_text("# Harbour Note\n\n" + EN[1] + "\n", encoding="utf-8")
    print("\n".join(sorted(p.name for p in OUT.iterdir())))
