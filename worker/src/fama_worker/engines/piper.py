"""Piper voices from rhasspy/piper-voices, run with ONNX Runtime.

Any Piper voice id works (`<locale>-<name>-<quality>`); `voices()` lists the Icelandic ones.
"""

from __future__ import annotations

import logging

import numpy as np

from fama_worker.model import Audio, Voice, VoiceRef

REPO = "rhasspy/piper-voices"
# Pinned so the chunk cache key (model_version) names the exact weights.
REVISION = "04ca88f5685ca5253c701af3687e155b113bd512"
SENTENCE_GAP_S = 0.2

# Newer espeak-ng marks voiceless Icelandic consonants with "#". The voices were trained
# without it, so Piper drops it; the warning on every sentence is noise.
logging.getLogger("piper.phoneme_ids").setLevel(logging.ERROR)

_LISTED = {
    "is_IS-salka-medium": ("Salka", "female"),
    "is_IS-ugla-medium": ("Ugla", "female"),
    "is_IS-bui-medium": ("Búi", "male"),
    "is_IS-steinn-medium": ("Steinn", "male"),
}


def _hub_path(voice_id: str) -> str:
    locale, name, quality = voice_id.rsplit("-", 2)
    return f"{locale.split('_')[0]}/{locale}/{name}/{quality}/{voice_id}"


class PiperEngine:
    name = "piper"
    model_version = f"piper-voices@{REVISION[:12]}"
    max_chars = 500

    def __init__(self, device: str) -> None:
        self.use_cuda = device == "cuda"
        self._voices: dict = {}

    def voices(self) -> list[Voice]:
        return [
            Voice(ref=VoiceRef("piper", voice_id), name=name, language=voice_id[:2], gender=gender)
            for voice_id, (name, gender) in _LISTED.items()
        ]

    def _load(self, voice_id: str):
        if voice_id not in self._voices:
            from huggingface_hub import hf_hub_download
            from piper import PiperVoice

            base = _hub_path(voice_id)
            model = hf_hub_download(REPO, f"{base}.onnx", revision=REVISION)
            config = hf_hub_download(REPO, f"{base}.onnx.json", revision=REVISION)
            self._voices[voice_id] = PiperVoice.load(model, config_path=config, use_cuda=self.use_cuda)
        return self._voices[voice_id]

    def synthesize(self, text: str, voice_id: str, speed: float) -> Audio:
        from piper import SynthesisConfig

        voice = self._load(voice_id)
        rate = voice.config.sample_rate
        gap = np.zeros(int(SENTENCE_GAP_S * rate), dtype=np.float32)
        parts: list[np.ndarray] = []
        for chunk in voice.synthesize(text, SynthesisConfig(length_scale=1.0 / speed)):
            if parts:
                parts.append(gap)
            parts.append(chunk.audio_float_array.astype(np.float32))
        samples = np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)
        return Audio(samples, rate)
