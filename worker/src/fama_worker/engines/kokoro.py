"""Kokoro-82M through the torch `kokoro` package.

On an M5 Pro, torch on MPS ran 32.9x real time against 30.6x for mlx-audio (BAKEOFF.md),
so one torch code path serves mps, cuda and cpu.
"""

from __future__ import annotations

import os

import numpy as np

from fama_worker.model import Audio, Voice, VoiceRef

REPO = "hexgrad/Kokoro-82M"
SAMPLE_RATE = 24000

# Voice prefix letter -> (Kokoro lang_code, language). Japanese and Chinese need extra
# G2P packages (misaki[ja], misaki[zh]), so they are left out.
_LANGUAGES = {"a": "en", "b": "en", "e": "es", "f": "fr", "h": "hi", "i": "it", "p": "pt"}

_VOICES = (
    "af_heart af_alloy af_aoede af_bella af_jessica af_kore af_nicole af_nova af_river af_sarah af_sky "
    "am_adam am_echo am_eric am_fenrir am_liam am_michael am_onyx am_puck am_santa "
    "bf_alice bf_emma bf_isabella bf_lily bm_daniel bm_fable bm_george bm_lewis "
    "ef_dora em_alex em_santa ff_siwis hf_alpha hf_beta hm_omega hm_psi if_sara im_nicola "
    "pf_dora pm_alex pm_santa"
).split()

_ACCENT = {"a": "US", "b": "UK"}


def _voice(voice_id: str) -> Voice:
    prefix, gender, name = voice_id[0], voice_id[1], voice_id[3:]
    accent = f" ({_ACCENT[prefix]})" if prefix in _ACCENT else ""
    return Voice(
        ref=VoiceRef("kokoro", voice_id),
        name=f"{name.capitalize()}{accent}",
        language=_LANGUAGES[prefix],
        gender="female" if gender == "f" else "male",
    )


class KokoroEngine:
    name = "kokoro"
    model_version = "kokoro-82m-v1.0"
    max_chars = 400

    def __init__(self, device: str) -> None:
        self.device = device
        self._pipelines: dict = {}

    def voices(self) -> list[Voice]:
        return [_voice(v) for v in _VOICES]

    def _pipeline(self, lang_code: str):
        if lang_code not in self._pipelines:
            os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
            from kokoro import KPipeline

            self._pipelines[lang_code] = KPipeline(lang_code=lang_code, device=self.device, repo_id=REPO)
        return self._pipelines[lang_code]

    def synthesize(self, text: str, voice_id: str, speed: float) -> Audio:
        if voice_id not in _VOICES:
            raise ValueError(f"Unknown kokoro voice {voice_id!r}")
        pipeline = self._pipeline(voice_id[0])
        parts = [
            result.audio.detach().cpu().numpy()
            for result in pipeline(text, voice=voice_id, speed=speed, split_pattern=None)
            if result.audio is not None
        ]
        samples = np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)
        return Audio(samples.astype(np.float32), SAMPLE_RATE)
