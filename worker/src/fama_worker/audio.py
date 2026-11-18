"""Chapter encoding and book assembly with ffmpeg. Every write is atomic."""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile as sf

from fama_worker.model import Audio, Cover

BITRATE = "64k"
TARGET_RMS_DB = -20.0
PEAK_LIMIT = 0.95


def ffmpeg() -> str:
    path = shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"
    if not Path(path).exists():
        raise RuntimeError("ffmpeg is required. Install it with `brew install ffmpeg`.")
    return path


def _run(command: list[str]) -> None:
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(f"ffmpeg failed: {result.stderr[-2000:]}")


def level(samples: np.ndarray) -> np.ndarray:
    """Bring speech to a steady loudness, so engines and chapters match."""
    rms = float(np.sqrt(np.mean(np.square(samples)))) if samples.size else 0.0
    if rms < 1e-5:
        return samples
    gain = 10 ** (TARGET_RMS_DB / 20) / rms
    peak = float(np.max(np.abs(samples))) * gain
    if peak > PEAK_LIMIT:
        gain *= PEAK_LIMIT / peak
    return (samples * gain).astype(np.float32)


def _metadata_value(value: str) -> str:
    value = value.replace("\r", " ").replace("\n", " ")
    for char in ("\\", "=", ";", "#"):
        value = value.replace(char, "\\" + char)
    return value


def encode_chapter(audio: Audio, path: Path, *, title: str, album: str, artist: str | None, track: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=path.parent) as tmp:
        wav = Path(tmp) / "chapter.wav"
        staged = Path(tmp) / "chapter.m4a"
        sf.write(wav, audio.samples, audio.sample_rate, subtype="PCM_16")
        command = [ffmpeg(), "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", str(wav),
                   "-c:a", "aac", "-b:a", BITRATE, "-ac", "1",
                   "-metadata", f"title={title}", "-metadata", f"album={album}", "-metadata", f"track={track}"]
        if artist:
            command += ["-metadata", f"artist={artist}"]
        _run(command + ["-movflags", "+faststart", str(staged)])
        os.replace(staged, path)


@dataclass(frozen=True)
class BookChapter:
    path: Path
    title: str
    duration_ms: int


def assemble_book(chapters: Sequence[BookChapter], path: Path, *, title: str, author: str | None,
                  cover: Path | None) -> None:
    """Join chapter files without re-encoding and add chapter marks, tags and cover."""
    if not chapters:
        raise ValueError("A book needs at least one chapter.")
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=path.parent) as tmp:
        tmp = Path(tmp)
        playlist = tmp / "chapters.txt"
        playlist.write_text("".join("file '" + str(c.path.resolve()).replace("'", "'\\''") + "'\n" for c in chapters))
        lines = [";FFMETADATA1", f"title={_metadata_value(title)}", f"album={_metadata_value(title)}",
                 "genre=Audiobook", "media_type=2"]
        if author:
            lines += [f"artist={_metadata_value(author)}", f"album_artist={_metadata_value(author)}"]
        start = 0
        for chapter in chapters:
            end = start + chapter.duration_ms
            lines += ["[CHAPTER]", "TIMEBASE=1/1000", f"START={start}", f"END={end}",
                      f"title={_metadata_value(chapter.title)}"]
            start = end
        metadata = tmp / "metadata.txt"
        metadata.write_text("\n".join(lines) + "\n", encoding="utf-8")
        staged = tmp / "book.m4b"
        command = [ffmpeg(), "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
                   "-f", "concat", "-safe", "0", "-i", str(playlist), "-f", "ffmetadata", "-i", str(metadata)]
        if cover:
            command += ["-i", str(cover)]
        command += ["-map", "0:a:0", "-map_metadata", "1", "-map_chapters", "1", "-c:a", "copy"]
        if cover:
            command += ["-map", "2:v:0", "-c:v", "copy", "-disposition:v:0", "attached_pic"]
        _run(command + ["-movflags", "+faststart", "-f", "ipod", str(staged)])
        os.replace(staged, path)


def write_cover(cover: Cover, directory: Path) -> Path:
    path = directory / f"cover.{cover.ext}"
    path.write_bytes(cover.data)
    return path


def duration_ms(path: Path) -> int:
    ffprobe = str(Path(ffmpeg()).with_name("ffprobe"))
    result = subprocess.run([ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                            capture_output=True, text=True, check=True)
    return round(float(result.stdout.strip()) * 1000)


def shrink_book(source: Path, target: Path, max_bytes: int, min_kbps: int = 24) -> bool:
    """Re-encode a book at the bitrate that fits `max_bytes`. False when even `min_kbps` is too big."""
    seconds = duration_ms(source) / 1000
    kbps = int(max_bytes * 8 * 0.95 / seconds / 1000)
    if kbps < min_kbps:
        return False
    with tempfile.TemporaryDirectory(dir=target.parent) as tmp:
        staged = Path(tmp) / "book.m4b"
        _run([ffmpeg(), "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", str(source),
              "-map", "0", "-map_metadata", "0", "-map_chapters", "0", "-c:a", "aac", "-b:a", f"{kbps}k",
              "-c:v", "copy", "-movflags", "+faststart", "-f", "ipod", str(staged)])
        os.replace(staged, target)
    return target.stat().st_size <= max_bytes
