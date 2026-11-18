"""Text normalization for listening: numbers, abbreviations, URLs, footnote markers.

Engines read digits poorly (espeak reads Icelandic ordinals as cardinals) and read
footnote markers and URLs aloud. This stage turns text into words a TTS model says well.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Callable

from num2words import CONVERTER_CLASSES, num2words

# Noise every language drops.
_URL = re.compile(r"(?:\bhttps?://|\bwww\.)\S+?(?=[.,;:!?)\]\"'¹²³⁴⁵⁶⁷⁸⁹⁰]*(?:\s|$))", re.IGNORECASE)
_EMAIL = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")
_FOOTNOTE = re.compile(
    r"\[\s*(?:\d+(?:[,–-]\s*\d+)*|[a-z]|note\s*\d+|[^\]]{0,30}(?:needed|óvirkur tengill|heimild vantar)[^\]]{0,10})\s*\]",
    re.IGNORECASE,
)
_SUPERSCRIPT = re.compile(r"[⁰¹²³⁴⁵⁶⁷⁸⁹]+")
_GLUED_FOOTNOTE = re.compile(r"(?<=[^\W\d_][.,;:!?”\"’)])\d{1,3}(?=\s|$)")
_DAGGERS = re.compile(r"(?<=\w)[*†‡]+")
_INVISIBLE = re.compile("[­​‌‍⁠﻿]")


def _drop_noise(text: str) -> str:
    # NFKC turns superscript digits into plain digits, so drop them first.
    text = unicodedata.normalize("NFKC", _INVISIBLE.sub("", _SUPERSCRIPT.sub("", text)))
    for pattern in (_URL, _EMAIL, _FOOTNOTE, _GLUED_FOOTNOTE, _DAGGERS):
        text = pattern.sub("", text)
    return text


def _tidy(text: str) -> str:
    text = re.sub(r"[„“”«»]", '"', text)
    text = re.sub(r"[‘’‚]", "'", text)
    text = text.replace("…", "...")
    text = re.sub(r"\s*[—―]\s*", ", ", text)
    text = re.sub(r"(?<=\w)\s+–\s+(?=\w)", ", ", text)
    text = re.sub(r"[*_#|~^<>{}\[\]]", " ", text)
    text = re.sub(r"\(\s*[,;:]?\s*\)", "", text)
    text = re.sub(r"\(\s*[,;:]\s*", "(", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r" +([,.;:!?)])", r"\1", text)
    text = re.sub(r"([,;:])(?:\s*[,;:])+", r"\1", text)
    text = re.sub(r"\(\s+", "(", text)
    lines = [line.strip() for line in text.split("\n")]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


_SENTENCE_START = re.compile(r"\s+[A-ZÁÉÍÓÚÝÞÆÖ]")
# Expansions that come before a name or number, so their dot never ends a sentence.
_LEADING = {"Mister", "Missus", "Miz", "Doctor", "Professor", "number", "page", "pages", "figure", "circa",
            "doktor", "séra", "númer", "blaðsíða", "klukkan", "samkvæmt", "samanber", "sirka"}


def _apply(text: str, table: dict[str, str]) -> str:
    """Expand abbreviations. A dot that also ended the sentence stays."""
    for pattern, spoken in table.items():
        def expand(match: re.Match, spoken: str = spoken) -> str:
            ends_sentence = (spoken not in _LEADING and match[0].endswith(".")
                             and _SENTENCE_START.match(match.string, match.end()))
            return spoken + "." if ends_sentence else spoken

        text = re.sub(pattern, expand, text)
    return text


# English

_EN_ABBREVIATIONS = {
    r"\bMr\.": "Mister",
    r"\bMrs\.": "Missus",
    r"\bMs\.": "Miz",
    r"\bDr\.(?=\s+[A-Z])": "Doctor",
    r"\bProf\.": "Professor",
    r"\bvs\.": "versus",
    r"\betc\.": "et cetera",
    r"\be\.g\.": "for example",
    r"\bi\.e\.": "that is",
    r"\bapprox\.": "approximately",
    r"\bca\.(?=\s*\d)": "circa",
    r"\bc\.(?=\s*\d)": "circa",
    r"\bNo\.(?=\s*\d)": "number",
    r"\bpp\.(?=\s*\d)": "pages",
    r"\bp\.(?=\s*\d)": "page",
    r"\bfig\.(?=\s*\d)": "figure",
    r"&": " and ",
}

_EN_UNITS = {
    "km²": "square kilometres", "km2": "square kilometres", "km": "kilometres", "m": "metres",
    "cm": "centimetres", "mm": "millimetres", "ft": "feet", "mi": "miles", "kg": "kilograms",
    "lb": "pounds", "°C": "degrees Celsius", "°F": "degrees Fahrenheit", "%": "percent",
}

_EN_CURRENCY = {"$": "dollars", "£": "pounds", "€": "euros"}

_MONTHS_EN = ["January", "February", "March", "April", "May", "June", "July", "August",
              "September", "October", "November", "December"]


def _en_number(match: re.Match) -> str:
    whole, decimals, suffix = match.group(1), match.group(2), match.group(3)
    value = int(whole.replace(",", ""))
    if suffix:
        return num2words(value, lang="en", to="ordinal")
    if decimals is not None:
        digits = " ".join(num2words(int(d), lang="en") for d in decimals)
        return f"{num2words(value, lang='en')} point {digits}"
    if "," not in whole and len(whole) == 4 and 1100 <= value <= 2099:
        return num2words(value, lang="en", to="year")
    return num2words(value, lang="en")


def _english(text: str) -> str:
    text = re.sub(r"\b(\d{4})-(\d{2})-(\d{2})\b",
                  lambda m: f"{_MONTHS_EN[int(m[2]) - 1]} {int(m[3])}, {m[1]}" if 1 <= int(m[2]) <= 12 else m[0],
                  text)
    text = _apply(text, _EN_ABBREVIATIONS)
    text = re.sub(r"(?<=\d)\s?[–—]\s?(?=\d)", " to ", text)
    text = re.sub(r"\b(\d{4})-(\d{4})\b", r"\1 to \2", text)
    text = re.sub(r"([$£€])\s?(\d[\d,]*(?:\.\d+)?)(\s(?:thousand|million|billion|trillion))?",
                  lambda m: f"{m[2]}{m[3] or ''} {_EN_CURRENCY[m[1]]}", text)
    units = "|".join(re.escape(u) for u in sorted(_EN_UNITS, key=len, reverse=True))
    text = re.sub(rf"(?<=\d)\s?({units})(?![\w])", lambda m: f" {_EN_UNITS[m[1]]}", text)
    return re.sub(r"(?<![\w.])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(st|nd|rd|th)?(?![\w])", _en_number, text)


# Icelandic

_IS_ABBREVIATIONS = {
    r"\bþ\.\s?e\.\s?a\.\s?s\.": "það er að segja",
    r"\bþ\.\s?á\.?\s?m\.": "þar á meðal",
    r"\bo\.\s?s\.\s?frv\.": "og svo framvegis",
    r"\bo\.\s?m\.\s?fl\.": "og margt fleira",
    r"\bo\.\s?þ\.\s?h\.": "og þess háttar",
    r"\bu\.\s?þ\.\s?b\.": "um það bil",
    r"\ba\.\s?m\.\s?k\.": "að minnsta kosti",
    r"\bm\.\s?ö\.\s?o\.": "með öðrum orðum",
    r"\bm\.\s?a\.": "meðal annars",
    r"\bt\.\s?d\.": "til dæmis",
    r"\bþ\.\s?e\.": "það er",
    r"\bo\.\s?fl\.": "og fleira",
    r"\bf\.\s?Kr\.": "fyrir Krist",
    r"\be\.\s?Kr\.": "eftir Krist",
    r"\bf\.\s?h\.": "fyrir hönd",
    r"\be\.\s?h\.": "eftir hádegi",
    r"\bf\.\s?o\.": "fyrir ofan",
    r"\bm\.\s?kr\.": "milljónir króna",
    r"\bma\.\s?kr\.": "milljarðar króna",
    r"\bskv\.": "samkvæmt",
    r"\bsbr\.": "samanber",
    r"\bnr\.": "númer",
    r"\bbls\.": "blaðsíða",
    r"\bþús\.": "þúsund",
    r"\bca\.": "sirka",
    r"\bath\.": "athugið",
    r"\bfrh\.": "framhald",
    r"\bdr\.": "doktor",
    r"\bsr\.": "séra",
    r"\bkl\.": "klukkan",
    r"\bfædd?\.": "fæddur",
    r"\bkr\.": "krónur",
    r"&": " og ",
}

_IS_UNITS = {
    "km²": "ferkílómetrar", "km2": "ferkílómetrar", "km": "kílómetrar", "m": "metrar",
    "cm": "sentímetrar", "mm": "millímetrar", "kg": "kíló", "°C": "gráður", "%": "prósent",
    "ISK": "krónur", "kr": "krónur",
}

_IS_MONTHS = ("janúar", "febrúar", "mars", "apríl", "maí", "júní", "júlí", "ágúst", "september",
              "október", "nóvember", "desember")

_IS_ORDINAL_STEMS = {
    1: "fyrst", 3: "þriðj", 4: "fjórð", 5: "fimmt", 6: "sjött", 7: "sjöund", 8: "áttund",
    9: "níund", 10: "tíund", 11: "elleft", 12: "tólft", 13: "þrettánd", 14: "fjórtánd",
    15: "fimmtánd", 16: "sextánd", 17: "sautjánd", 18: "átjánd", 19: "nítjánd", 20: "tuttugast",
    30: "þrítugast", 40: "fertugast", 50: "fimmtugast", 60: "sextugast", 70: "sjötugast",
    80: "áttugast", 90: "nítugast", 100: "hundraðast", 1000: "þúsundast",
}
# Ending -i: masculine nominative. -a: accusative/dative, used for dates. -u: oblique feminine (öld).
_IS_ANNAR = {"i": "annar", "a": "annan", "u": "annarri"}
_IS_NEUTER = {"einn": "eitt", "tveir": "tvö", "þrír": "þrjú", "fjórir": "fjögur"}


def _is_cardinal(value: int, neuter: bool = False) -> str:
    words = num2words(value, lang="is")
    if neuter:
        last = words.rsplit(" ", 1)
        if last[-1] in _IS_NEUTER:
            last[-1] = _IS_NEUTER[last[-1]]
        words = " ".join(last)
    return words


def is_ordinal(value: int, ending: str = "i") -> str:
    """Icelandic ordinal in its weak form, for example 17 -> sautjándi."""

    def unit(n: int) -> str:
        return _IS_ANNAR[ending] if n == 2 else _IS_ORDINAL_STEMS[n] + ending

    if value <= 0 or value >= 1000:
        return _is_cardinal(value)
    parts = []
    hundreds, rest = divmod(value, 100)
    if hundreds:
        stem = _IS_ORDINAL_STEMS[100] + ending
        parts.append(stem if hundreds == 1 else f"{_is_cardinal(hundreds, neuter=True)} {stem}")
    if rest:
        if rest < 20 or rest % 10 == 0:
            parts.append(unit(rest))
        else:
            tens, ones = divmod(rest, 10)
            parts.extend([unit(tens * 10), unit(ones)])
    if len(parts) > 1:
        parts.insert(len(parts) - 1, "og")
    return " ".join(parts)


def is_year(value: int) -> str:
    """1786 -> sautján hundruð áttatíu og sex, 2025 -> tvö þúsund tuttugu og fimm."""
    if 2000 <= value <= 2099:
        head, rest = "tvö þúsund", value - 2000
    elif 1100 <= value <= 1999:
        head, rest = f"{_is_cardinal(value // 100)} hundruð", value % 100
    else:
        return _is_cardinal(value, neuter=True)
    if rest == 0:
        return head
    if rest < 20 or rest % 10 == 0:
        return f"{head} og {_is_cardinal(rest, neuter=True)}"
    return f"{head} {_is_cardinal(rest, neuter=True)}"


def _is_ordinal_match(match: re.Match) -> str:
    value, following = int(match.group(1)), match.group(2)
    word = following.lower()
    if word.startswith(_IS_MONTHS):
        ending = "a"
    elif word.startswith(("öld", "aldar")):
        ending = "u"
    else:
        ending = "i"
    return f"{is_ordinal(value, ending)} {following}"


def _is_number(match: re.Match) -> str:
    whole, decimals = match.group(1), match.group(2)
    value = int(whole.replace(".", "").replace(" ", "").replace(" ", ""))
    if decimals is not None:
        return f"{_is_cardinal(value)} komma {_is_cardinal(int(decimals))}"
    if len(whole) == 4 and 1100 <= value <= 2099:
        return is_year(value)
    return _is_cardinal(value)


def _icelandic(text: str) -> str:
    text = re.sub(r"\b(\d{4})-(\d{2})-(\d{2})\b",
                  lambda m: f"{int(m[3])}. {_IS_MONTHS[int(m[2]) - 1]} {m[1]}" if 1 <= int(m[2]) <= 12 else m[0],
                  text)
    text = _apply(text, _IS_ABBREVIATIONS)
    text = re.sub(r"(?<=\d)\.?\s?[–—]\s?(?=\d)", " til ", text)
    text = re.sub(r"\b(\d{4})-(\d{4})\b", r"\1 til \2", text)
    text = re.sub(r"([$€£])\s?(\d[\d.]*(?:,\d+)?)",
                  lambda m: f"{m[2]} {dict(zip('$€£', ('dollarar', 'evrur', 'pund')))[m[1]]}", text)
    units = "|".join(re.escape(u) for u in sorted(_IS_UNITS, key=len, reverse=True))
    text = re.sub(rf"(?<=\d)\s?({units})(?![\w])", lambda m: f" {_IS_UNITS[m[1]]}", text)
    text = re.sub(r"(?<![\w.,])(\d{1,3})\.(?=\s)\s+([a-záéíóúýþæöð]\w*)", _is_ordinal_match, text)
    return re.sub(r"(?<![\w.,])(\d{1,3}(?:[.  ]\d{3})+|\d+)(?:,(\d+))?(?![\w]|[.,]\d)", _is_number, text)


def _generic(language: str) -> Callable[[str], str]:
    def convert(text: str) -> str:
        return re.sub(r"(?<![\w.,])\d+(?![\w]|[.,]\d)", lambda m: num2words(int(m[0]), lang=language), text)

    return convert


def _rules(language: str) -> Callable[[str], str]:
    if language == "en":
        return _english
    if language == "is":
        return _icelandic
    if language in CONVERTER_CLASSES:
        return _generic(language)
    return lambda text: text


def normalize(text: str, language: str) -> str:
    """Return text a TTS engine can read aloud. Paragraph breaks (blank lines) survive."""
    return _tidy(_rules(language)(_drop_noise(text)))
