"""On-disk cache of synthesized chunks.

The key covers everything that changes the audio, so a re-run or a retry only
synthesizes chunks it has not made before.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path

import soundfile as sf

from fama_worker.model import Audio, VoiceRef


def default_cache_dir() -> Path:
    return Path(os.environ.get("FAMA_CACHE_DIR", Path.home() / ".cache" / "fama" / "chunks"))


def chunk_key(text: str, voice: VoiceRef, model_version: str, speed: float) -> str:
    payload = json.dumps([text, voice.engine, voice.voice_id, model_version, float(speed)], ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


class ChunkCache:
    def __init__(self, root: Path | None = None) -> None:
        self.root = root or default_cache_dir()

    def _path(self, key: str) -> Path:
        return self.root / key[:2] / f"{key}.flac"

    def get(self, key: str) -> Audio | None:
        path = self._path(key)
        if not path.exists():
            return None
        samples, rate = sf.read(path, dtype="float32")
        return Audio(samples, rate)

    def put(self, key: str, audio: Audio) -> None:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=path.parent, suffix=".flac", delete=False) as handle:
            temporary = Path(handle.name)
        try:
            sf.write(temporary, audio.samples, audio.sample_rate, subtype="PCM_16", format="FLAC")
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)
