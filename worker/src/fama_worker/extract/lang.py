"""Language detection with the full fastText model (the lite one reads Icelandic as Danish).

Digits and symbols are stripped first: a line of map coordinates turned a clear Icelandic
article into "de". A low-confidence guess yields to the language the source declares.
"""

from __future__ import annotations

import re

SAMPLE_CHARS = 4000
MIN_CONFIDENCE = 0.5


def detect_language(text: str, declared: str | None = None) -> str:
    from fast_langdetect import detect

    letters = " ".join(re.sub(r"[^\w\s.,!?]|[\d_]", " ", text[:SAMPLE_CHARS]).split())
    if not letters:
        if declared:
            return declared
        raise ValueError("The source has no text to read.")
    guess = detect(letters, model="full", k=1)[0]
    if declared and guess["score"] < MIN_CONFIDENCE:
        return declared
    return guess["lang"]
