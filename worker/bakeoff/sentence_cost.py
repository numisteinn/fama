"""Cost of one synthesis call for each sentence, against packed chunks.

    uv run python bakeoff/sentence_cost.py --text article.txt --language en --voice kokoro:af_heart --out samples/

`sentence` is the worker's plan: one Segment for each sentence. `packed` joins the
sentences of a paragraph up to the engine's limit, as the worker did before read-along.
Both shapes read the same text on the same device, with no chunk cache. Each run is a new
process: it loads the model, reads a warm-up text, then reads the article
once in one shape. A new process matters for Kokoro on MPS, where the first call with a
new input length is slower than a repeat, and a real episode is all new text. The runs
alternate (packed, sentence, packed, ...) so that other load on the machine hits both
shapes. Speed is audio seconds per wall second inside `engine.synthesize`.

The script also writes the first `--listen` paragraphs of each shape as WAV files, and
reports the pause the listener hears between two sentences in each shape.
"""

from __future__ import annotations

import argparse
import json
import statistics
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf

from fama_worker.chunk import MIN_CHARS, Segment, segments
from fama_worker.engines import get_engine
from fama_worker.model import VoiceRef
from fama_worker.normalize import normalize
from fama_worker.pipeline import PARAGRAPH_GAP_S, SEGMENT_GAP_S

WARM_UP = {
    "en": "This text warms the model before the timed run. It has two sentences of plain words.",
    "is": "Þessi texti hitar líkanið fyrir mælinguna. Hann er tvær setningar af venjulegum orðum.",
}


SHAPES = {"packed": lambda limit: limit, "sentence": lambda limit: MIN_CHARS}
"""Shape name to `min_chars`: a piece shorter than this joins the next one."""


def render(engine, voice: VoiceRef, plan: list[Segment]) -> tuple[np.ndarray, int, float, float]:
    """Returns (samples with gaps, rate, wall seconds inside synthesize, speech seconds without gaps)."""
    parts: list[np.ndarray] = []
    wall = speech = 0.0
    rate = 0
    for segment in plan:
        started = time.perf_counter()
        result = engine.synthesize(segment.spoken, voice.voice_id, 1.0)
        wall += time.perf_counter() - started
        if result.samples.size == 0:
            raise RuntimeError(f"no audio for {segment.spoken!r}")
        rate = result.sample_rate
        speech += result.duration_s
        gap = PARAGRAPH_GAP_S if segment.ends_paragraph else SEGMENT_GAP_S
        parts += [result.samples, np.zeros(int(gap * rate), np.float32)]
    return np.concatenate(parts[:-1]), rate, wall, speech


def pauses(samples: np.ndarray, rate: int, floor_db: float = -45.0, min_s: float = 0.15) -> list[float]:
    """Lengths of the quiet stretches inside the audio, in seconds."""
    window = int(0.01 * rate)
    frames = samples[: len(samples) // window * window].reshape(-1, window)
    quiet = 20 * np.log10(np.sqrt((frames**2).mean(axis=1)) + 1e-9) < floor_db
    runs, length = [], 0
    for is_quiet in quiet:
        if is_quiet:
            length += 1
        else:
            if length * 0.01 >= min_s:
                runs.append(length * 0.01)
            length = 0
    return runs


def one_run(args: argparse.Namespace) -> dict:
    """One process, one shape, one read of the article. Also writes the WAV file when asked."""
    voice = VoiceRef.parse(args.voice)
    engine = get_engine(voice.engine)
    text = args.text.read_text(encoding="utf-8")
    plan = segments(text, engine.max_chars, lambda piece: normalize(piece, args.language),
                    min_chars=SHAPES[args.shape](engine.max_chars))
    engine.synthesize(WARM_UP[args.language], voice.voice_id, 1.0)
    samples, rate, wall, speech = render(engine, voice, plan)
    _, _, again, _ = render(engine, voice, plan)
    result = {
        "shape": args.shape, "device": getattr(engine, "device", "cpu"), "words": len(text.split()),
        "read": sum(len(s.spoken.split()) for s in plan),
        "calls": len(plan), "chars_per_call": round(statistics.mean(len(s.spoken) for s in plan)),
        "audio_s": len(samples) / rate, "speech_s": speech, "wall_s": wall, "repeat_wall_s": again,
    }
    if args.write:
        ends = np.cumsum([s.ends_paragraph for s in plan])
        end = next((i + 1 for i, n in enumerate(ends) if n == args.listen), len(plan))
        part, rate, _, _ = render(engine, voice, plan[:end])
        sf.write(args.out / f"{voice.voice_id}-{args.shape}.wav", part, rate, subtype="PCM_16")
        quiet = pauses(part, rate)
        result |= {"pause_s_median": round(statistics.median(quiet), 2) if quiet else None, "pauses": len(quiet)}
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--text", type=Path, required=True)
    parser.add_argument("--language", required=True)
    parser.add_argument("--voice", required=True)
    parser.add_argument("--runs", type=int, default=7, help="processes for each shape")
    parser.add_argument("--listen", type=int, default=4, help="paragraphs in the WAV files")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--shape", choices=list(SHAPES), help="internal: do one run and print it")
    parser.add_argument("--write", action="store_true", help="internal: write the WAV file in this run")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    if args.shape:
        print(json.dumps(one_run(args)))
        return

    runs: dict[str, list[dict]] = {name: [] for name in SHAPES}
    for run in range(args.runs):
        for name in list(SHAPES) if run % 2 == 0 else list(reversed(SHAPES)):
            command = [sys.executable, __file__, "--text", str(args.text), "--language", args.language,
                       "--voice", args.voice, "--listen", str(args.listen),
                       "--out", str(args.out), "--shape", name] + (["--write"] if run == 0 else [])
            done = subprocess.run(command, capture_output=True, text=True, check=True)
            runs[name].append(json.loads(done.stdout.strip().splitlines()[-1]))
            print(f"run {run} {name}: {runs[name][-1]['wall_s']:.2f} s", file=sys.stderr)

    report: dict = {"voice": args.voice, "device": runs["packed"][0]["device"], "words": runs["packed"][0]["words"],
                    "runs": args.runs, "shapes": {}}
    if len({r["read"] for results in runs.values() for r in results}) != 1:
        raise RuntimeError("the two shapes did not read the same number of words")
    for name, results in runs.items():
        first = results[0]
        walls = [r["wall_s"] for r in results]
        repeats = [r["repeat_wall_s"] for r in results]
        report["shapes"][name] = {
            "calls": first["calls"], "chars_per_call": first["chars_per_call"],
            "audio_s": round(first["audio_s"], 1), "speech_s": round(first["speech_s"], 1),
            "wall_s": [round(w, 2) for w in walls],
            "wall_s_median": round(statistics.median(walls), 2),
            "x_real_time": round(first["audio_s"] / statistics.median(walls), 1),
            "x_real_time_best": round(first["audio_s"] / min(walls), 1),
            "repeat_wall_s_median": round(statistics.median(repeats), 2),
            "pause_s_median": first.get("pause_s_median"), "pauses": first.get("pauses"),
        }
    a, b = report["shapes"]["packed"], report["shapes"]["sentence"]
    report["sentence_speed_vs_packed"] = round(b["x_real_time"] / a["x_real_time"], 3)
    report["sentence_speed_vs_packed_best"] = round(b["x_real_time_best"] / a["x_real_time_best"], 3)
    report["sentence_speed_vs_packed_repeat"] = round(
        (b["audio_s"] / b["repeat_wall_s_median"]) / (a["audio_s"] / a["repeat_wall_s_median"]), 3)
    print(json.dumps(report, indent=2))
    (args.out / f"{VoiceRef.parse(args.voice).voice_id}.json").write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    main()
