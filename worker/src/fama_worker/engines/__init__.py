"""Engine registry: one table from engine name to engine, one table of default voices.

An engine turns text into audio for one of its voices. Engines load their models on the
first call to `synthesize`, so listing voices stays fast. The device is a constructor
argument, so the same code runs on a Mac (mps), on Modal (cuda) or anywhere (cpu).
"""

from __future__ import annotations

import os
from collections.abc import Callable
from typing import Protocol

from fama_worker.model import Audio, Voice, VoiceRef


class Engine(Protocol):
    name: str
    model_version: str
    max_chars: int

    def voices(self) -> list[Voice]: ...

    def synthesize(self, text: str, voice_id: str, speed: float) -> Audio: ...


def resolve_device(preference: str | None = None) -> str:
    """`auto` picks cuda, then mps, then cpu. `FAMA_DEVICE` overrides the default."""
    preference = preference or os.environ.get("FAMA_DEVICE", "auto")
    if preference != "auto":
        return preference
    try:
        import torch
    except ImportError:
        return "cpu"
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def _kokoro(device: str) -> Engine:
    from fama_worker.engines.kokoro import KokoroEngine

    return KokoroEngine(device)


def _piper(device: str) -> Engine:
    from fama_worker.engines.piper import PiperEngine

    return PiperEngine(device)


ENGINES: dict[str, Callable[[str], Engine]] = {
    "kokoro": _kokoro,
    "piper": _piper,
}

# Chosen from the bakeoff in BAKEOFF.md.
DEFAULT_VOICE: dict[str, VoiceRef] = {
    "en": VoiceRef("kokoro", "af_heart"),
    "is": VoiceRef("piper", "is_IS-salka-medium"),
    "es": VoiceRef("kokoro", "ef_dora"),
    "fr": VoiceRef("kokoro", "ff_siwis"),
    "it": VoiceRef("kokoro", "if_sara"),
    "pt": VoiceRef("kokoro", "pf_dora"),
    "hi": VoiceRef("kokoro", "hf_alpha"),
}

_loaded: dict[str, Engine] = {}


def get_engine(name: str, device: str | None = None) -> Engine:
    if name not in ENGINES:
        raise ValueError(f"Unknown engine {name!r}. Known: {', '.join(ENGINES)}")
    if name not in _loaded:
        _loaded[name] = ENGINES[name](resolve_device(device))
    return _loaded[name]


def all_voices() -> list[Voice]:
    return [voice for name in ENGINES for voice in get_engine(name).voices()]


def default_voice(language: str) -> VoiceRef:
    if language not in DEFAULT_VOICE:
        raise ValueError(f"No voice for language {language!r}. Pick one with --voice.")
    return DEFAULT_VOICE[language]
