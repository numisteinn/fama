"""Generate public catalog Voice previews."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Protocol

from fama_worker import audio
from fama_worker.engines import Engine, get_engine
from fama_worker.model import Audio, Voice, VoiceRef

PREVIEW_TEXT = {
    "en": "Hi, I'm {name}, a voice on Fama.",
    "is": "Halló, ég heiti {name} og les fyrir þig á Fama.",
    "es": "Hola, soy {name}, una voz de Fama.",
    "fr": "Bonjour, je m’appelle {name} et je lis pour vous sur Fama.",
    "it": "Ciao, sono {name}, una voce di Fama.",
    "pt": "Olá, eu sou {name}, uma das vozes da Fama.",
    "hi": "नमस्ते, मेरा नाम {name} है और यह फ़ामा पर मेरी आवाज़ है।",
}


class PreviewApi(Protocol):
    def register_voices(self, voices: list[dict]) -> None: ...

    def missing_voice_previews(self) -> set[str]: ...

    def put_voice_preview(self, voice: VoiceRef, file: Path) -> None: ...


def preview_text(voice: Voice) -> str:
    name = voice.name.removesuffix(" (US)").removesuffix(" (UK)")
    return PREVIEW_TEXT[voice.language].format(name=name)


def generate_previews(
    api: PreviewApi,
    voices: Sequence[Voice],
    *,
    regenerate: bool = False,
    only: str | None = None,
    engine_for: Callable[[str], Engine] = get_engine,
) -> int:
    if only is not None and all(str(voice.ref) != only for voice in voices):
        raise ValueError(f"Unknown Voice: {only}")

    api.register_voices([voice.to_json() for voice in voices])
    if only is not None:
        selected = {only}
    elif regenerate:
        selected = {str(voice.ref) for voice in voices}
    else:
        selected = api.missing_voice_previews()

    count = 0
    with TemporaryDirectory(prefix="fama-previews-") as directory:
        path = Path(directory) / "preview.m4a"
        for voice in voices:
            if str(voice.ref) not in selected:
                continue
            rendered = engine_for(voice.ref.engine).synthesize(preview_text(voice), voice.ref.voice_id, 1.0)
            if rendered.samples.size == 0:
                raise ValueError(f"Voice produced no preview audio: {voice.ref}")
            clip = Audio(audio.level(rendered.samples), rendered.sample_rate)
            audio.encode_chapter(clip, path, title=voice.name, album="Fama", artist=None, track=1)
            api.put_voice_preview(voice.ref, path)
            count += 1
    return count
