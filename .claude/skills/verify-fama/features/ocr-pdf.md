# OCR for scanned PDFs

A user attaches a scanned PDF (page images, no text layer) or a hybrid PDF (some text pages, some scanned image pages) as a file. For any page with no embedded text that carries a scan image (or when a whole PDF has no text layer), the worker renders the page in grayscale at 300 DPI and reads it offline with OCR: `tesseract` (`isl+eng` when `isl` is installed) first on any platform, or Apple Vision as a macOS fallback when `tesseract` is absent. The OCR blocks flow through `pdf.py`'s running header, footer, page number, and paragraph cleanup before narration. A scan OCR still cannot read fails with a clear reason.

## Sub-features

- `ocr-pdf-english` reads an English scanned PDF (via `tesseract` when installed, or Apple Vision on macOS without `tesseract`).
- `ocr-pdf-icelandic` reads an Icelandic scanned PDF with `tesseract` (`isl+eng`), keeping `þ, ð, æ, ö, á, é, í, ó, ú, ý, Þ, Ð, Æ, Ö`. Apple Vision cannot do this (`Þingvellir` → `Pingvellir`, `við` → `vio`).
- `ocr-pdf-hybrid` keeps text pages as-is and OCRs scanned image pages in the same PDF.
- `ocr-pdf-blank` fails with a clear reason when a scan has no readable text.
- `ocr-pdf-no-backend` fails with a clear message when a scan arrives on a worker with neither `tesseract` nor Apple Vision (covered by unit test).

## How to get to it (user POV)

- Web: choose `Attach file`, pick a scanned PDF, then `Add`. The episode narrates the scanned pages like any PDF.
- iPhone: tab `Add`, mode `File`, `Choose files`, pick the scanned PDF, `Create`.

## Driving it with preview tools and agent-device

Preconditions:

- Baseline from `README.md`.
- For Icelandic scans, `tesseract` with `isl` data must be installed (`tesseract --list-langs` includes `isl`). On macOS: `brew install tesseract tesseract-lang`. Modal and Docker images install `tesseract-ocr` and `tesseract-ocr-isl`.

1. **Generate multi-paragraph scanned fixtures in `$EVIDENCE/ocr-pdf/`** (portable font lookup, no binary blobs committed):

```sh
mkdir -p "$EVIDENCE/ocr-pdf"
(cd worker && uv run python - "$EVIDENCE/ocr-pdf" <<'PY'
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

out = Path(sys.argv[1])
font_path = next(
    p for p in [
        "/System/Library/Fonts/Supplemental/Georgia.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf",
    ]
    if Path(p).exists()
)
font = ImageFont.truetype(font_path, 38)

def make_scan(path, blocks):
    all_lines = [line for block in blocks for line in block]
    w = max(int(font.getlength(l)) for l in all_lines) + 160
    h = 160 + sum(len(b) * 55 for b in blocks) + max(0, len(blocks) - 1) * 85
    img = Image.new("RGB", (w, h), "white")
    draw = ImageDraw.Draw(img)
    y = 80
    for i, block in enumerate(blocks):
        if i:
            y += 85
        for line in block:
            draw.text((80, y), line, font=font, fill="black")
            y += 55
    png = path.with_suffix(".png")
    img.save(png)
    doc = canvas.Canvas(str(path), pagesize=A4)
    pw, ph = A4
    s = min(pw / img.width, ph / img.height) * 0.88
    doc.drawImage(str(png), 40, ph - 40 - img.height * s, width=img.width * s, height=img.height * s)
    doc.showPage()
    doc.save()
    png.unlink()

make_scan(out / "scan-en.pdf", [
    ["The harbour master reads the tide tables", "every morning before the boats leave."],
    ["In winter the ice comes down from the north", "and the boats stay tied to the quay."],
])
make_scan(out / "scan-is.pdf", [
    ["Þingvellir liggja við Öxará og Þjórsá."],
    ["Hafnarstjórinn vaknaði fyrir sólarupprás."],
])
PY
)
```

2. **Upload the English scan:** `fama-verify api POST /api/episodes/upload -F "file=@$EVIDENCE/ocr-pdf/scan-en.pdf"`. Run `fama-verify wait <id>`. Verify `Ready`, `language: "en"`, both paragraphs intact in order in `GET /api/episodes/<id>/document`, and `206` byte-range audio from `bookUrl`.
3. **Upload the Icelandic scan:** repeat with `scan-is.pdf`. Verify `Ready`, `language: "is"`, and `Þingvellir`, `við`, `Öxará`, `Hafnarstjórinn` intact in `GET /api/episodes/<id>/document`.
4. **Blank scan & no-backend:** run `(cd worker && uv run pytest -q tests/test_ocr.py)` to verify multi-block TSV ordering, two-column Vision ordering, hybrid PDFs, blank scan error, and the no-backend error.

## Gotchas

- Apple Vision does not support Icelandic (33 languages, no `is`) and mangles `þ`/`ð`. The worker therefore prefers `tesseract` (`isl+eng`) whenever installed, and falls back to Apple Vision on macOS.
- Normal text PDFs never invoke OCR; per-page OCR only runs on text-less pages with a raster scan image (or if the entire PDF has no embedded text).
- `pyobjc-framework-Vision` is gated to `sys_platform == 'darwin'` and imported lazily so Linux/Modal/Docker builds never install it.
