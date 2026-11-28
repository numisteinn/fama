from pathlib import Path

import numpy as np
import pytest

from fama_worker.audio import duration_ms
from fama_worker.model import Audio, Voice, VoiceRef
from fama_worker.previews import generate_previews, preview_text

HEART = Voice(VoiceRef("kokoro", "af_heart"), "Heart (US)", "en", "female")
SALKA = Voice(VoiceRef("piper", "is_IS-salka-medium"), "Salka", "is", "female")


class StubEngine:
    name = "stub"
    model_version = "test"
    max_chars = 400

    def voices(self) -> list[Voice]:
        return [HEART, SALKA]

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, float]] = []

    def synthesize(self, text: str, voice_id: str, speed: float) -> Audio:
        self.calls.append((text, voice_id, speed))
        times = np.arange(24_000) / 24_000
        return Audio((0.1 * np.sin(2 * np.pi * 440 * times)).astype(np.float32), 24_000)


class StubApi:
    def __init__(self) -> None:
        self.registered: list[dict] = []
        self.uploads: list[VoiceRef] = []
        self.missing_reads = 0

    def register_voices(self, voices: list[dict]) -> None:
        self.registered = voices

    def missing_voice_previews(self) -> set[str]:
        assert self.registered
        self.missing_reads += 1
        return {str(SALKA.ref), "other:unavailable"}

    def put_voice_preview(self, voice: VoiceRef, file: Path) -> None:
        assert file.suffix == ".m4a"
        assert 950 <= duration_ms(file) <= 1050
        self.uploads.append(voice)


@pytest.mark.parametrize(
    ("options", "expected", "missing_reads"),
    [
        ({}, [SALKA], 1),
        ({"regenerate": True}, [HEART, SALKA], 0),
        ({"only": str(HEART.ref)}, [HEART], 0),
    ],
)
def test_generate_previews(options: dict, expected: list[Voice], missing_reads: int):
    engine = StubEngine()
    api = StubApi()
    catalog = [HEART, SALKA]
    requested_engines: list[str] = []

    def engine_for(name: str) -> StubEngine:
        requested_engines.append(name)
        return engine

    assert generate_previews(api, catalog, engine_for=engine_for, **options) == len(expected)
    assert api.registered == [voice.to_json() for voice in catalog]
    assert api.missing_reads == missing_reads
    assert api.uploads == [voice.ref for voice in expected]
    assert requested_engines == [voice.ref.engine for voice in expected]
    assert engine.calls == [(preview_text(voice), voice.ref.voice_id, 1.0) for voice in expected]


def test_unknown_voice_leaves_catalog_alone():
    api = StubApi()
    with pytest.raises(ValueError, match="Unknown Voice"):
        generate_previews(api, [HEART], only="kokoro:unknown")
    assert api.registered == []
    assert api.uploads == []


@pytest.mark.parametrize(
    ("language", "greeting"),
    [("en", "Hi"), ("is", "Halló"), ("es", "Hola"), ("fr", "Bonjour"),
     ("it", "Ciao"), ("pt", "Olá"), ("hi", "नमस्ते")],
)
def test_preview_text_uses_voice_name_and_language(language: str, greeting: str):
    voice = Voice(HEART.ref, HEART.name, language, HEART.gender)
    text = preview_text(voice)
    assert text.startswith(greeting)
    assert "Heart" in text
    assert "(US)" not in text
