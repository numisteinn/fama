import numpy as np
import pytest

from fama_worker import engines
from fama_worker.model import Audio, Voice, VoiceRef


class ToneEngine:
    """A stand-in engine: a short tone per word, and a log of what it was asked to say."""

    name = "tone"
    model_version = "tone-1"
    max_chars = 120

    def __init__(self, device: str) -> None:
        self.calls: list[str] = []

    def voices(self):
        return [Voice(VoiceRef("tone", "a"), "Tone", "en", None)]

    def synthesize(self, text: str, voice_id: str, speed: float) -> Audio:
        self.calls.append(text)
        rate = 16000
        seconds = 0.05 * len(text.split()) / speed
        t = np.arange(int(seconds * rate)) / rate
        return Audio((0.3 * np.sin(2 * np.pi * 440 * t)).astype(np.float32), rate)


@pytest.fixture
def tone(monkeypatch, tmp_path):
    monkeypatch.setattr(engines, "_loaded", {})
    monkeypatch.setattr(engines, "ENGINES", {"tone": ToneEngine})
    monkeypatch.setenv("FAMA_CACHE_DIR", str(tmp_path / "cache"))
    return engines.get_engine("tone")
