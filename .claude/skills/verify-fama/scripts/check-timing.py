"""Prove the timing files of one episode against its real chapter audio.

    uv run --project worker python .claude/skills/verify-fama/scripts/check-timing.py <episodeId> --out <dir>

Reads the episode from the verification API, then for each chapter:
- the timing file is served as JSON, and its last `endMs` is within 50 ms of `durationMs`
- for each Segment, the audio is silent just before `startMs` and just after `endMs`, and the voice
  starts at `startMs`. So each `startMs` is the start of its own sentence.
- `--cuts N` writes N Segments as WAV files, cut with ffmpeg at `startMs` and `endMs`, to listen to.
- `--transcribe` also runs Whisper on each cut (needs `uv run --group bakeoff`), to compare with `text`.

Exit status 1 when a check fails.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

import numpy as np

API = f"http://localhost:{os.environ.get('FAMA_VERIFY_API_PORT', '8788')}"
TOKEN = "dev-api-token"
RATE = 16000
SILENT_DB = -55.0  # the gap between two Segments is digital silence before the AAC encode
VOICE_DB = -40.0
MAX_ONSET_MS = 60  # the worker cuts at -60 dB; the AAC encode moves a soft start by a few ms


def fetch(path: str, token: str | None = None) -> tuple[bytes, str]:
    request = urllib.request.Request(API + path, headers={"Authorization": f"Bearer {token}"} if token else {})
    with urllib.request.urlopen(request) as response:
        return response.read(), response.headers.get("content-type", "")


def decode(m4a: Path) -> np.ndarray:
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(m4a), "-f", "f32le", "-ac", "1", "-ar", str(RATE), "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32)


def level_db(samples: np.ndarray, from_ms: float, to_ms: float) -> float:
    part = samples[max(0, int(from_ms * RATE / 1000)):max(0, int(to_ms * RATE / 1000))]
    return -120.0 if part.size == 0 else float(20 * np.log10(np.sqrt(np.mean(np.square(part))) + 1e-6))


def onset_ms(samples: np.ndarray, start_ms: int) -> int | None:
    """Milliseconds from `start_ms` to the first 10 ms that holds voice."""
    for offset in range(0, 1000, 10):
        if level_db(samples, start_ms + offset, start_ms + offset + 10) > VOICE_DB:
            return offset
    return None


def transcriber(language: str):
    import mlx_whisper

    def transcribe(path: Path) -> str:
        return mlx_whisper.transcribe(str(path), path_or_hf_repo="mlx-community/whisper-large-v3-turbo",
                                      language=language)["text"].strip()

    return transcribe


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("episode")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--cuts", type=int, default=3, help="Segments of each chapter to write as WAV files")
    parser.add_argument("--transcribe", action="store_true")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    episode = json.loads(fetch(f"/api/episodes/{args.episode}", TOKEN)[0])
    transcribe = transcriber(episode["language"]) if args.transcribe else None
    failures: list[str] = []
    report = {"episode": episode["id"], "title": episode["title"], "voice": episode["voice"], "chapters": []}
    for chapter in episode["chapters"]:
        name = f"chapter {chapter['index']}"
        if chapter["timingUrl"] is None:
            failures.append(f"{name}: timingUrl is null")
            continue
        body, content_type = fetch(chapter["timingUrl"])
        if content_type != "application/json":
            failures.append(f"{name}: timing file is served as {content_type!r}")
        segments = json.loads(body)["segments"]
        m4a = args.out / f"{chapter['index']:03d}.m4a"
        m4a.write_bytes(fetch(chapter["url"])[0])
        (args.out / f"{chapter['index']:03d}.json").write_bytes(body)
        samples = decode(m4a)

        end_gap = segments[-1]["endMs"] - chapter["durationMs"]
        if abs(end_gap) > 50:
            failures.append(f"{name}: last endMs is {end_gap} ms from durationMs")
        rows = []
        for i, segment in enumerate(segments):
            start, end = segment["startMs"], segment["endMs"]
            before = level_db(samples, start - 100, start - 10) if i else None
            after = level_db(samples, end + 10, end + 100) if i < len(segments) - 1 else None
            onset = onset_ms(samples, start)
            rows.append({"text": segment["text"], "startMs": start, "endMs": end, "onsetMs": onset,
                         "beforeDb": before and round(before, 1), "afterDb": after and round(after, 1)})
            where = f"{name} segment {i} at {start} ms ({segment['text'][:40]!r})"
            if before is not None and before > SILENT_DB:
                failures.append(f"{where}: sound just before startMs ({before:.1f} dB)")
            if after is not None and after > SILENT_DB:
                failures.append(f"{where}: sound just after endMs ({after:.1f} dB)")
            if onset is None or onset > MAX_ONSET_MS:
                failures.append(f"{where}: the voice starts {onset} ms after startMs")

        step = max(1, len(segments) // max(1, args.cuts))
        cuts = []
        for i in list(range(len(segments) // 2 % step, len(segments), step))[:args.cuts]:
            segment = segments[i]
            wav = args.out / f"{chapter['index']:03d}-cut-{i:03d}.wav"
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{segment['startMs'] / 1000:.3f}",
                            "-to", f"{segment['endMs'] / 1000:.3f}", "-i", str(m4a), str(wav)], check=True)
            cut = {"segment": i, "startMs": segment["startMs"], "file": wav.name, "text": segment["text"]}
            if transcribe:
                cut["heard"] = transcribe(wav)
            cuts.append(cut)
            print(f"{name} cut at {segment['startMs']} ms\n   text:  {segment['text']}"
                  + (f"\n   heard: {cut['heard']}" if transcribe else ""))

        onsets = [r["onsetMs"] for r in rows if r["onsetMs"] is not None]
        print(f"{name}: {len(segments)} segments, last endMs {segments[-1]['endMs']} vs durationMs "
              f"{chapter['durationMs']} ({end_gap:+d} ms), voice starts {min(onsets)} to {max(onsets)} ms after startMs")
        report["chapters"].append({"index": chapter["index"], "durationMs": chapter["durationMs"],
                                   "lastEndMs": segments[-1]["endMs"], "segments": rows, "cuts": cuts})
    (args.out / "check-timing.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    for failure in failures:
        print(f"FAIL {failure}")
    print("timing: ok" if not failures else f"timing: {len(failures)} failures")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
