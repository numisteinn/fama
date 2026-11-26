"""Fixture generator and local Kokoro voiceover synthesizer for record-demo."""
from __future__ import annotations

import json
import shutil
import sys
import wave
from pathlib import Path

import numpy as np


def pick_device() -> str:
    try:
        import torch

        if torch.backends.mps.is_available():
            return "mps"
        if torch.cuda.is_available():
            return "cuda"
    except Exception:
        pass
    return "cpu"


def make_scan_pdf(spec: dict, assets_dir: Path) -> None:
    from PIL import Image, ImageDraw, ImageFont
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas

    font_path = next(
        p
        for p in [
            "/System/Library/Fonts/Supplemental/Georgia.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf",
        ]
        if Path(p).exists()
    )
    title_font = ImageFont.truetype(font_path, 54)
    body_font = ImageFont.truetype(font_path, 38)

    w = int(spec.get("width", 1320))
    h = int(spec.get("height", 660))
    bg = spec.get("background", "#fbfaf7")
    fg = spec.get("foreground", "#181818")
    img = Image.new("RGB", (w, h), bg)
    draw = ImageDraw.Draw(img)

    y = 90
    for block in spec["blocks"]:
        kind = block.get("kind", "body")
        font = title_font if kind == "title" else body_font
        step = 74 if kind == "title" else 56
        for line in block["lines"]:
            draw.text((80, y), line, font=font, fill=fg)
            y += step
        y += 55

    pdf_path = assets_dir / spec["file"]
    preview_name = spec.get("preview", pdf_path.stem + "-preview.png")
    preview_path = assets_dir / preview_name
    img.save(preview_path)

    doc = canvas.Canvas(str(pdf_path), pagesize=A4)
    pw, ph = A4
    s = min(pw / img.width, ph / img.height) * 0.88
    doc.drawImage(str(preview_path), 40, ph - 40 - img.height * s, width=img.width * s, height=img.height * s)
    doc.showPage()
    doc.save()
    print(f"fixture: created {pdf_path.name} + {preview_path.name}")


def run_fixtures(spec: dict, out_dir: Path, verify_fixtures_dir: Path | None) -> None:
    assets_dir = out_dir / "assets"
    assets_dir.mkdir(parents=True, exist_ok=True)
    fixtures = spec.get("fixtures") or {}

    for pdf_spec in fixtures.get("scanPdfs", []):
        make_scan_pdf(pdf_spec, assets_dir)

    for fname in fixtures.get("copy", []):
        if verify_fixtures_dir is None:
            raise RuntimeError("verify fixtures directory not provided")
        src = verify_fixtures_dir / fname
        if not src.exists():
            raise FileNotFoundError(f"Fixture not found: {src}")
        shutil.copy2(src, assets_dir / Path(fname).name)
        print(f"fixture: copied {fname}")


def write_wav(path: Path, samples: np.ndarray, sample_rate: int) -> float:
    clipped = np.clip(samples, -1.0, 1.0)
    pcm = (clipped * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm.tobytes())
    return len(samples) / sample_rate


def run_voiceover(spec: dict, out_dir: Path) -> None:
    from fama_worker.engines.kokoro import KokoroEngine

    assets_dir = out_dir / "assets"
    assets_dir.mkdir(parents=True, exist_ok=True)
    meta = spec.get("meta") or {}
    voice_id = meta.get("voice", "af_heart")
    speed = float(meta.get("voiceSpeed", 1.06))
    lines = spec.get("voiceover") or []

    if not lines:
        (assets_dir / "voiceover.json").write_text("{}\n")
        print("voiceover: none configured")
        return

    device = pick_device()
    engine = KokoroEngine(device)
    info: dict[str, dict] = {}
    for entry in lines:
        key = entry["id"]
        text = entry["text"]
        v = entry.get("voice", voice_id)
        sp = float(entry.get("speed", speed))
        audio = engine.synthesize(text, v, sp)
        mag = np.abs(audio.samples)
        nz = np.where(mag > 0.008)[0]
        if len(nz) > 0:
            lo = max(0, int(nz[0]) - int(audio.sample_rate * 0.04))
            hi = min(len(audio.samples), int(nz[-1]) + int(audio.sample_rate * 0.08))
            trimmed = audio.samples[lo:hi]
        else:
            trimmed = audio.samples
        wav_path = assets_dir / f"{key}.wav"
        dur = write_wav(wav_path, trimmed, audio.sample_rate)
        info[key] = {"file": wav_path.name, "text": text, "duration": round(dur, 3)}
        print(f"vo: {key} ({dur:.2f}s) — {text}")

    (assets_dir / "voiceover.json").write_text(json.dumps(info, indent=2) + "\n")
    print("voiceover.json written")


def main() -> None:
    if len(sys.argv) < 4:
        raise SystemExit("Usage: voiceover.py <fixtures|vo> <spec.json> <out-dir> [verify-fixtures-dir]")
    mode = sys.argv[1]
    spec = json.loads(Path(sys.argv[2]).read_text())
    out_dir = Path(sys.argv[3])
    verify_dir = Path(sys.argv[4]) if len(sys.argv) > 4 else None

    if mode == "fixtures":
        run_fixtures(spec, out_dir, verify_dir)
    elif mode == "vo":
        run_voiceover(spec, out_dir)
    else:
        raise SystemExit(f"Unknown mode: {mode}")


if __name__ == "__main__":
    main()
