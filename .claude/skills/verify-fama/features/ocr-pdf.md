# OCR for scanned PDFs

A user attaches a scanned PDF (page images, no text layer) as a file. The worker finds no embedded text, renders each page, and reads it with OCR: Apple Vision on macOS (built in, offline) or the `tesseract` CLI when it is installed. The text then flows through the normal PDF path, so running headers, footers, page numbers and hyphenated line breaks come out clean and the episode narrates. A scan OCR still cannot read fails with a clear reason, not an empty episode.

## Sub-features

- `ocr-pdf-english` reads an English scanned PDF on macOS with Apple Vision, with no extra install.
- `ocr-pdf-icelandic` reads an Icelandic scanned PDF with tesseract `isl`, keeping `þ, ð, æ, ö, á, é, í, ó, ú, ý, Þ, Ð, Æ, Ö`. Apple Vision cannot do this: it reads `Þingvellir` as `Pingvellir` and `við` as `vio`.
- `ocr-pdf-blank` fails with a clear reason when a scan has no readable text.
- `ocr-pdf-no-backend` fails with an install hint when a scan arrives on a machine with no OCR engine (a Linux worker without tesseract).

## How to get to it (user POV)

- Web: choose `Attach file`, pick a scanned PDF, then `Add`. The episode narrates the scanned pages like any PDF.
- iPhone: tab `Add`, mode `File`, `Choose files`, pick the scanned PDF, `Create`.

## Driving it with preview tools and agent-device

Preconditions:

- Baseline from `README.md`.
- The worker must be able to find `tesseract` for the Icelandic case. `which tesseract` prints a path, and `tesseract --list-langs` includes `isl`. On macOS: `brew install tesseract tesseract-lang`.

- **Make a scanned PDF.** Scanned PDFs have no text layer, so the normal PDF fixtures do not cover this. Generate one in the scratchpad with the worker's own dependencies (no binary blobs committed):

```sh
cd worker && uv run python - <<'PY'
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

def scanned(path, lines):
    font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Georgia.ttf", 42)
    img = Image.new("RGB", (max(int(font.getlength(l)) for l in lines) + 120, 120 + 70 * len(lines)), "white")
    d = ImageDraw.Draw(img)
    for i, l in enumerate(lines):
        d.text((60, 60 + 70 * i), l, font=font, fill="black")
    png = path.with_suffix(".png"); img.save(png)
    doc = canvas.Canvas(str(path), pagesize=A4)
    w, h = A4
    s = min(w / img.width, h / img.height) * 0.9
    doc.drawImage(str(png), 40, h - 40 - img.height * s, width=img.width * s, height=img.height * s)
    doc.showPage(); doc.save(); png.unlink()

scanned(Path("/tmp/fama-scan-en.pdf"), ["The harbour master reads the tide tables every morning before the boats leave."])
scanned(Path("/tmp/fama-scan-is.pdf"), ["Þingvellir liggja við Öxará og Þjórsá. Hafnarstjórinn vaknaði fyrir sólarupprás."])
PY
```

- **Upload the English scan.** `fama-verify api POST /api/episodes/upload -F "file=@/tmp/fama-scan-en.pdf"` prints the new episode with its `id`. Run `fama-verify wait <id>`. It ends `Ready`, with language `en`, and `durationMs` greater than 0.
- **Read the stored Document.** `fama-verify api GET /api/episodes/<id>/document` shows a `Document` whose first chapter text contains the scanned sentence (for example `tide tables`), with no running header and no page number. Save both JSON bodies to `$EVIDENCE/ocr-pdf-english/`.
- **Upload the Icelandic scan.** Repeat with `/tmp/fama-scan-is.pdf`. `fama-verify wait <id>` ends `Ready` with language `is`. `fama-verify api GET /api/episodes/<id>/document` shows the chapter text with the diacritics intact: `Þingvellir`, `við`, `Öxará`. Save to `$EVIDENCE/ocr-pdf-icelandic/`.
- **Audio proof.** `fama-verify api GET /api/episodes/<id>` lists a `bookUrl` with a non-zero `durationMs`; a `curl -H 'Range: bytes=0-' http://localhost:8788<bookUrl>` returns `206`. No mocks: the worker read the scan and narrated it for real.
- **Blank scan.** Make a one-page scan with no text (`doc.rect(72, 72, 200, 200)` only) and upload it. `fama-verify wait <id>` ends `Failed` with a reason that says no text could be read. `GET /api/episodes/<id>` shows the reason next to the failed job.
- **Tests.** From `worker/`, `uv run pytest -q tests/test_ocr.py` proves the same paths with generated fixtures, including the Icelandic diacritics and the no-backend hint.

## Gotchas

- Apple Vision does not read Icelandic. Its supported languages stop at 33 and include `sv-SE`, `da-DK`, `no-NO` and `fi-FI`, but no `is`. On a Mac without tesseract, an Icelandic scan OCRs through Vision and comes out mangled (`Þingvellir` → `Pingvellir`, `við` → `vio`). tesseract `isl` is the only backend that reads the diacritics correctly, so the Icelandic proof needs tesseract installed.
- The worker prefers tesseract when it is on `PATH`, because it is the only Icelandic-capable backend; Vision is the built-in macOS fallback for English.
- A text PDF never goes through OCR: the worker only renders and OCRs pages whose text layer is empty, so normal PDFs keep their exact output and speed.
- `pyobjc-framework-Vision` is gated to `sys_platform == 'darwin'` and imported lazily, so Linux, Docker and Modal builds do not need or install it.
- On a Linux worker without tesseract, a scanned PDF fails with an install hint rather than a silent empty episode. The Docker and Modal images do not install tesseract by default; add it there before relying on cloud OCR.
