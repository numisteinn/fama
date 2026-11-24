# Notices

## Code

Parts of the worker are adapted from [pdf-narrator](https://github.com/mateogon/pdf-narrator) (MIT License, Copyright (c) 2024 Mateo Gonzalez Arrigorriaga):

- The list of front-matter titles to skip (`extract/common.py`).
- The EPUB spine, nav and NCX walk, and the cover lookup (`extract/epub.py`).
- The PDF TOC chapter split (`extract/pdf.py`).
- The ffmetadata chapter file and the ffmpeg M4B command (`audio.py`).
- The Kokoro voice list (`engines/kokoro.py`).

The MIT License text of pdf-narrator:

> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Models

| Model | Used for | License |
|---|---|---|
| [hexgrad/Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) | English, Spanish, French, Hindi, Italian, Portuguese voices | Apache-2.0 |
| [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices) `is_IS` salka, ugla, bui, steinn | Icelandic voices | Trained on Talrómur, CC BY 4.0 |

The Icelandic voices are trained on the **Talrómur** speech corpus, CLARIN-IS, [http://hdl.handle.net/20.500.12537/104](http://hdl.handle.net/20.500.12537/104), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

## Dependency licenses to know

The worker is MIT. Permissive PDF dependencies:

- `pypdfium2` is Apache-2.0 / BSD-3-Clause (bundles PDFium under BSD-3-Clause / Apache-2.0 and its permissive third-party build libraries).
- `reportlab` (dev-only, used to build PDF test and verification fixtures) is BSD-3-Clause; its dependencies are `pillow` (MIT-CMU) and `charset-normalizer` (MIT).

Some of the worker's runtime dependencies are copyleft:

- `piper-tts` is GPL-3.0-or-later and bundles espeak-ng (GPL-3.0).
- `num2words` is LGPL-2.1.
- `misaki` (Kokoro's G2P) loads espeak-ng through `espeakng-loader`.

Running the worker for yourself is fine under all of them. Shipping the worker as part of a closed product is not; see the open issues in `README.md`.
