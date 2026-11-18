"""Language detection. The full fastText model: the lite one reads Icelandic as Danish."""

from __future__ import annotations

SAMPLE_CHARS = 4000


def detect_language(text: str) -> str:
    from fast_langdetect import detect

    sample = " ".join(text[:SAMPLE_CHARS].split())
    if not sample:
        raise ValueError("The source has no text to read.")
    return detect(sample, model="full", k=1)[0]["lang"]
