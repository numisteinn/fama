"""Voice bakeoff: render one paragraph per candidate, time it, score it with ASR.

    uv run --group bakeoff python bakeoff/run.py [--only is|en] [--out ~/Developer/fama-samples]

Each candidate reads the same paragraph after Fama's normalization and chunking, so the
numbers match how the worker would use it. Timing is warm: one warm-up call, then the
best of two runs. RTF = synthesis seconds / audio seconds (lower is faster).
Scores are listening-free: an ASR model transcribes the sample, and word and character
error rates against the input catch mispronunciations, skipped words and babble.
Results go to bakeoff/results.json; BAKEOFF.md is written from them by hand.
"""

from __future__ import annotations

import argparse
import difflib
import json
import os
import platform
import re
import subprocess
import sys
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np

from fama_worker import audio
from fama_worker.chunk import segments
from fama_worker.model import Audio
from fama_worker.normalize import normalize

os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

TEXT = {
    "is": (
        "Reykjavík er höfuðborg Íslands og þar búa um 140 þúsund manns. Borgin stendur við Faxaflóa og varð "
        "verslunarstaður á 18. öld. Þann 17. júní 1944 var lýðveldið stofnað á Þingvöllum. Á sumrin er sólin á "
        "lofti nær allan sólarhringinn, en á veturna eru dagarnir stuttir og norðurljósin dansa á himninum. "
        "Margir fara í sund á hverjum degi, t.d. í Vesturbæjarlaug, og heitu pottarnir eru vinsæll staður til "
        "að spjalla um daginn og veginn."
    ),
    "en": (
        "The church took 41 years to build, from 1945 to 1986. At 74.5 metres tall, it is the largest church in "
        "Iceland. Its design was inspired by the basalt columns that form when lava cools slowly. Inside, a large "
        "pipe organ with 5,275 pipes fills the nave with sound. Visitors can take a lift to the top of the tower, "
        "where the view stretches across the colourful roofs of Reykjavík to the mountains beyond the bay."
    ),
}
CHUNK_CHARS = 400
GAP_S = 0.12


@dataclass
class Candidate:
    language: str
    engine: str
    voice: str
    model: str
    license: str
    size_mb: float
    load: Callable[[], Callable[[str], Audio]] = field(repr=False)


@dataclass
class Result:
    language: str
    engine: str
    voice: str
    model: str
    license: str
    size_mb: float
    load_s: float = 0.0
    synth_s: float = 0.0
    audio_s: float = 0.0
    rtf: float = 0.0
    wer: float = 0.0
    cer: float = 0.0
    words_per_minute: float = 0.0
    clipped_share: float = 0.0
    longest_pause_s: float = 0.0
    misheard: list[str] = field(default_factory=list)
    transcript: str = ""
    error: str | None = None
    sample: str = ""


def _fama_engine(name: str, voice: str) -> Callable[[], Callable[[str], Audio]]:
    def load():
        from fama_worker.engines import get_engine

        engine = get_engine(name)
        return lambda text: engine.synthesize(text, voice, 1.0)

    return load


def _mms() -> Callable[[str], Audio]:
    import torch
    from transformers import AutoTokenizer, VitsModel

    model = VitsModel.from_pretrained("facebook/mms-tts-isl").eval()
    tokenizer = AutoTokenizer.from_pretrained("facebook/mms-tts-isl")

    def synth(text: str) -> Audio:
        with torch.no_grad():
            waveform = model(**tokenizer(text, return_tensors="pt")).waveform[0].numpy()
        return Audio(waveform.astype(np.float32), model.config.sampling_rate)

    return synth


def _mlx(repo: str, **options) -> Callable[[], Callable[[str], Audio]]:
    def load():
        from mlx_audio.tts.utils import load_model

        model = load_model(repo)

        def synth(text: str) -> Audio:
            results = list(model.generate(text=text, **options))
            samples = np.concatenate([np.array(r.audio, dtype=np.float32) for r in results])
            return Audio(samples, results[0].sample_rate)

        return synth

    return load


CANDIDATES = [
    *(Candidate("is", "piper", f"is_IS-{v}-medium", "rhasspy/piper-voices (VITS, Talrómur data)",
                "MIT code, CC BY 4.0 data", 63.5, _fama_engine("piper", f"is_IS-{v}-medium"))
      for v in ("salka", "ugla", "bui", "steinn")),
    Candidate("is", "mms", "isl", "facebook/mms-tts-isl (VITS)", "CC BY-NC 4.0", 145.0, _mms),
    Candidate("is", "omnivoice", "auto", "k2-fsa/OmniVoice via mlx-community/OmniVoice-bfloat16",
              "Apache-2.0 code, CC BY-NC weights", 2040.0, _mlx("mlx-community/OmniVoice-bfloat16", language="is")),
    Candidate("en", "kokoro", "af_heart", "hexgrad/Kokoro-82M (torch, mps)", "Apache-2.0", 327.0,
              _fama_engine("kokoro", "af_heart")),
    Candidate("en", "chatterbox-turbo", "default", "ResembleAI Chatterbox Turbo via mlx-community/chatterbox-turbo-fp16",
              "MIT", 2990.0, _mlx("mlx-community/chatterbox-turbo-fp16")),
]


def render(synth: Callable[[str], Audio], text: str) -> Audio:
    parts, rate = [], None
    for segment in segments(text, CHUNK_CHARS, speak=lambda piece: piece):
        result = synth(segment.spoken)
        rate = result.sample_rate
        parts += [result.samples, np.zeros(int(GAP_S * rate), dtype=np.float32)]
    return Audio(np.concatenate(parts[:-1]), rate)


def _words(text: str, language: str) -> list[str]:
    return re.sub(r"[^\w\s]", " ", normalize(text, language).lower()).split()


def _distance(a: list, b: list) -> int:
    row = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        previous, row[0] = row[0], i
        for j, y in enumerate(b, 1):
            previous, row[j] = row[j], min(row[j] + 1, row[j - 1] + 1, previous + (x != y))
    return row[-1]


def _longest_pause(samples: np.ndarray, rate: int) -> float:
    frame = int(0.02 * rate)
    frames = samples[: len(samples) // frame * frame].reshape(-1, frame)
    loud = 20 * np.log10(np.sqrt(np.mean(frames**2, axis=1)) + 1e-9) > -45
    if not loud.any():
        return len(samples) / rate
    inner = loud[np.argmax(loud): len(loud) - np.argmax(loud[::-1])]
    longest = run = 0
    for value in inner:
        run = 0 if value else run + 1
        longest = max(longest, run)
    return longest * 0.02


class Transcriber:
    def __init__(self) -> None:
        self._is = None

    def __call__(self, path: Path, language: str) -> str:
        if language == "en":
            import mlx_whisper

            return mlx_whisper.transcribe(str(path), path_or_hf_repo="mlx-community/whisper-large-v3-turbo",
                                          language="en")["text"]
        if self._is is None:
            import torch
            from transformers import pipeline

            self._is = pipeline("automatic-speech-recognition",
                                model="language-and-voice-lab/whisper-large-icelandic-62640-steps-967h",
                                device="mps", dtype=torch.float16)
        return self._is(str(path), return_timestamps=True,
                        generate_kwargs={"language": "icelandic", "task": "transcribe"})["text"]


def bake(candidate: Candidate, out: Path, transcribe: Transcriber) -> Result:
    result = Result(**{k: v for k, v in asdict(candidate).items() if k != "load"})
    text = normalize(TEXT[candidate.language], candidate.language)
    try:
        started = time.perf_counter()
        synth = candidate.load()
        render(synth, "Góðan dag." if candidate.language == "is" else "Good morning.")
        result.load_s = time.perf_counter() - started
        timings = []
        for _ in range(2):
            started = time.perf_counter()
            sample = render(synth, text)
            timings.append(time.perf_counter() - started)
    except Exception as error:  # a candidate that fails to load or run is a result, not a crash
        result.error = f"{type(error).__name__}: {error}"[:500]
        return result
    result.synth_s = min(timings)
    result.audio_s = sample.duration_s
    result.rtf = result.synth_s / result.audio_s
    result.clipped_share = float(np.mean(np.abs(sample.samples) >= 0.999))
    result.longest_pause_s = _longest_pause(sample.samples, sample.sample_rate)
    path = out / candidate.language / f"{candidate.engine}-{candidate.voice}.m4a"
    leveled = Audio(audio.level(sample.samples), sample.sample_rate)
    audio.encode_chapter(leveled, path, title=f"{candidate.engine} {candidate.voice}", album="Fama bakeoff",
                         artist=None, track=1)
    result.sample = str(path.relative_to(out))
    reference = _words(text, candidate.language)
    result.words_per_minute = len(reference) / result.audio_s * 60
    result.transcript = transcribe(path, candidate.language).strip()
    heard = _words(result.transcript, candidate.language)
    result.wer = _distance(reference, heard) / len(reference)
    result.cer = _distance(list(" ".join(reference)), list(" ".join(heard))) / len(" ".join(reference))
    matcher = difflib.SequenceMatcher(a=reference, b=heard, autojunk=False)
    result.misheard = [f"{' '.join(reference[i1:i2]) or '-'} -> {' '.join(heard[j1:j2]) or '-'}"
                       for op, i1, i2, j1, j2 in matcher.get_opcodes() if op != "equal"]
    return result


def table(results: list[Result]) -> str:
    lines = ["| lang | engine:voice | license | size MB | load s | RTF | x real time | WER | CER | wpm | longest pause s |",
             "|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in results:
        if r.error:
            lines.append(f"| {r.language} | {r.engine}:{r.voice} | {r.license} | {r.size_mb:.0f} | failed: {r.error} |||||||")
            continue
        lines.append(f"| {r.language} | {r.engine}:{r.voice} | {r.license} | {r.size_mb:.0f} | {r.load_s:.1f} | "
                     f"{r.rtf:.4f} | {1 / r.rtf:.1f} | {r.wer:.1%} | {r.cer:.1%} | {r.words_per_minute:.0f} | "
                     f"{r.longest_pause_s:.2f} |")
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", choices=["is", "en"])
    parser.add_argument("--engine")
    parser.add_argument("--out", default=str(Path.home() / "Developer" / "fama-samples"))
    parser.add_argument("--text", help="file with a longer text for --only's language; results go to results-long.json")
    args = parser.parse_args()
    out = Path(args.out)
    results_path = Path(__file__).with_name("results.json")
    if args.text:
        if not args.only:
            parser.error("--text needs --only")
        TEXT[args.only] = Path(args.text).read_text(encoding="utf-8")
        results_path = Path(__file__).with_name("results-long.json")
        out = out / "long"
    previous = {(r["engine"], r["voice"]): r for r in json.loads(results_path.read_text())} if results_path.exists() else {}
    transcribe = Transcriber()
    chosen = [c for c in CANDIDATES if (not args.only or c.language == args.only)
              and (not args.engine or c.engine == args.engine)]
    for candidate in chosen:
        print(f"baking {candidate.engine}:{candidate.voice}", file=sys.stderr, flush=True)
        result = bake(candidate, out, transcribe)
        previous[(result.engine, result.voice)] = asdict(result)
        print(table([result]).splitlines()[-1], file=sys.stderr, flush=True)
    machine = subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True, text=True).stdout.strip()
    ordered = sorted(previous.values(), key=lambda r: (r["language"], r["engine"], r["voice"]))
    results_path.write_text(json.dumps(ordered, ensure_ascii=False, indent=2) + "\n")
    print(f"\nMachine: {machine or platform.machine()}\n")
    print(table([Result(**r) for r in ordered]))


if __name__ == "__main__":
    main()
