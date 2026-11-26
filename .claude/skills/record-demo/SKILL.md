---
name: record-demo
description: Record polished, narrated 1080p demo videos of real Fama features (16:9 landscape or 9:16 vertical) from a declarative JSON spec. Drives the live local web app via Chrome DevTools Protocol, mixes local Kokoro voiceover with real Fama Piper/Kokoro audio clips, adds spring zoom/pan, cursor motion, live typing, and exports an MP4 plus contact sheet. Zero external API cost.
---

# Record Demo

`record-demo` turns a declarative JSON demo spec into a studio-grade MP4 of the real Fama app — combining:

- **Planned, dead-air-free real capture** (like `opencode-in-chrome`): drives the live `fama-verify` web app at 2× retina over Chrome DevTools Protocol, records exact element bounding boxes, live typing frames, timing JSONs, and downloads real generated `.m4a` samples and chapters into `assets/manifest.json`.
- **Local TTS + deterministic studio composition** (like `explainroo`): synthesizes short voiceover beats locally with Fama's own Kokoro engine (`worker/`), pauses voiceover whenever real Fama audio plays, renders every frame deterministically in headless Chrome (spring camera pan/zoom, animated cursor + click ripples, live audio waveform badge, optional iPhone bezel, captions, end card), and mixes everything in FFmpeg.

## Prerequisites

- `ffmpeg`, `ffprobe`, `node` (22+ via `mise.toml`), and `uv` with `worker/` synced.
- Google Chrome (or Playwright's cached Chromium, or `CHROME_PATH` env var).
- Run from the repo root with mise shims on `PATH`: `export PATH="$HOME/.local/share/mise/shims:$PATH"`.

## CLI (`scripts/fama-demo`)

```sh
# Full run: fresh isolated fama-verify stack -> capture -> teardown -> Kokoro VO -> 16:9 MP4 + contact sheet
.claude/skills/record-demo/scripts/fama-demo run .claude/skills/record-demo/examples/round4-showcase.json

# Render a 9:16 vertical cut from an existing captured run (no re-capture or re-OCR!)
.claude/skills/record-demo/scripts/fama-demo render ~/Developer/fama-shots/demos/<RUN_DIR> --format 9:16

# Re-synthesize Kokoro voiceover after editing spec voiceover lines, then re-render
.claude/skills/record-demo/scripts/fama-demo vo ~/Developer/fama-shots/demos/<RUN_DIR>
.claude/skills/record-demo/scripts/fama-demo render ~/Developer/fama-shots/demos/<RUN_DIR>
```

Outputs are written under `~/Developer/fama-shots/demos/<name>-<timestamp>/` (or `--out <dir>`), leaving the repo clean:

- `demo-16x9.mp4` / `demo-9x16.mp4` — final H.264 + AAC MP4 (`+faststart`)
- `contact-sheet-16x9.png` / `contact-sheet-9x16.png` — 3×3 visual QA grid
- `end-frame-16x9.png` / `end-frame-9x16.png` — end-card verification frame
- `spec.json` — copy of the spec used for reproducibility
- `assets/` — 2× screenshots, `manifest.json`, `voiceover.json`, `timeline.json`, and real `.m4a`/`.wav` audio clips

## Writing a demo spec (`spec.json`)

Start from [examples/round4-showcase.json](./examples/round4-showcase.json). A spec has five top-level fields:

### 1. `meta`
```json
{
  "name": "my-feature",
  "brandBadge": "Fama · Feature Demo",
  "urlLabel": "fama.app",
  "endTitle": "fama",
  "endSubtitle": "Links, files & scanned PDFs — narrated with live read-along.",
  "endTags": ["Offline OCR", "Voice Samples", "Read-along", "Narrate Again"],
  "voice": "af_heart",
  "voiceSpeed": 1.06,
  "fps": 30,
  "viewport": { "width": 1120, "height": 740, "scale": 2 }
}
```

### 2. `fixtures` (optional)
- `scanPdfs`: generate image-only scanned PDFs + `-preview.png` thumbnails via `reportlab` + `Pillow` (no binary blobs needed in git).
- `copy`: copy named files from `.claude/skills/verify-fama/fixtures/` into `assets/`.

### 3. `capture` (ordered CDP steps)
Every step runs sequentially against the live `fama-verify` web app (isolated ports `8971`/`8972`, never touching port `8787` or production):

| `op` | Key fields | What it does |
| --- | --- | --- |
| `wait` | `selector` (or `role` + `name` / `nameStartsWith` / `nameContains`), `timeoutMs` | Wait until a visible matching element exists. |
| `box` | `as`, selector/role matchers | Measure and store `{ x, y, w, h, cx, cy }` in `manifest.boxes[as]`. |
| `snap` | `as`, `blur?`, `delayMs?` | Capture a 2× retina PNG into `manifest.shots[as]`. |
| `click` | `box`, `waitAriaChecked?`, `delayMs?` | Dispatch real mouse move + click at `manifest.boxes[box]`. |
| `hover` | `box`, `delayMs?` | Move pointer over `manifest.boxes[box]` (reveals hover controls like Narrate again). |
| `upload` | `selector`, `file` | Attach a file from `assets/` via `DOM.setFileInputFiles`. |
| `typeSequence` | `box`, `text`, `prefix`, `stepChars?` | Focus textarea, move caret to end, insert `text` in chunks, snapping `prefix + 0..N` for smooth live typing frames. |
| `recordClip` | `as`, `steps?`, `durationMs?` | Record continuous live tab video via CDP `Page.startScreencast` while running nested `steps` (e.g. live Read-along playback + scrubber movement, smooth scrolling, or spinners) and encode an all-intraframe H.264 `.mp4` into `manifest.clips[as]`. |
| `clickReaderSentence` | `index`, `pause?`, `boxAs?` | Click a Read-along sentence (`index` supports negative indexing like `-1`); set `pause: false` inside `recordClip` to record real continuous audio playback + live highlight transitions. |
| `pauseAudio` | — | Pause `<audio>` playback cleanly after a `recordClip`. |
| `downloadSample` | `voiceContains`, `as`, `episodeIndex?` | Fetch ready sample audio from `/api/episodes/:id/samples`. |
| `downloadChapter` | `index`, `audioAs`, `timingAs`, `episodeIndex?` | Fetch chapter `.m4a` and `timingUrl` JSON from `/api/episodes`. |
| `snapReaderSentences` | `selector`, `prefix`, `max?` | Click each visible Read-along sentence, pause audio, snap `prefix + i`, and store sentence boxes. |
| `snapLastReaderSentence` | `selector`, `as`, `boxAs` | Click the final Read-along sentence, pause audio, snap `as`, and store its box in `boxAs`. |
| `sleep` | `ms` | Short settle pause when needed. |

### 4. `voiceover`
Array of `{ "id": "vo_01", "text": "..." }` synthesized locally with Fama's Kokoro engine. Keep each line crisp (1 short sentence, ~3–5 s) so pacing feels tight.

### 5. `beats` (relative-time storyboard)
Beats are **relative** — `render.mjs` automatically computes exact timestamps from real `ffprobe` durations of each VO and Fama audio clip, so changing a sentence or voice never breaks sync!

| `type` | What it does |
| --- | --- |
| `vo` | Plays voiceover `id`. Supports `feature` badge, `pauseAfter`, `camera` keyframes (relative offsets `at: 0..1` as fraction of beat duration, targeting `{ box, zoom }` or `{ x, y, zoom }`), `events` (relative `at: 0..1` shot swaps, clicks, `typeSequence` playback, floating `attachmentCard`, optional `iphoneShot`). |
| `liveAudio` | Plays a full downloaded Fama `.m4a` clip (`audio`) with **zero VO overlap**, showing the animated `liveLabel` waveform pill, optional `click` right before start, `shot`, `camera`, and `caption`. |
| `liveReadAlong` | Plays a slice of a real chapter `.m4a` (`audio` + `timing` JSON) across `segments: [i, j, ...]`, automatically jumping `shotPrefix + segIdx` on the exact `startMs` of each segment! Supports `truncateLastSec` so long second sentences fade out cleanly right after the highlight jumps. |
| `hold` | Quiet beat (e.g. final end-card settle) with `duration`, optional `endCard: true`, and `camera` ease-out. |

### Continuous video clips & OpenCode Browse imports
Any beat or beat event can display a continuous `.mp4`/`.webm` video clip instead of a static screenshot via `"clip"`:

```json
{
  "type": "liveReadAlong",
  "audio": "ch0V1",
  "timing": "v1",
  "segments": [1, 2],
  "clip": { "file": "readAlongLive", "trimStart": 0.15, "speed": 1.0, "fade": 0.12 }
}
```

- `file` can be a `manifest.clips` key recorded by `recordClip`, OR any external `.mp4`/`.webm` filename placed in `<run-dir>/assets/` (including **OpenCode Browse** tab recordings!).
- External clips are automatically transcoded once into `assets/.seekcache/` as all-intraframe H.264 so deterministic frame-by-frame seeking stays instant and glitch-free.
- Use `speed` (e.g. `2.5` during loading/spinners) and `trimStart` to tighten pacing cleanly.

### Side-by-side iPhone frames & recordings (optional)
To include real iPhone Simulator screens or recordings (captured via `agent-device screenshot` or `agent-device record` into `<run-dir>/assets/`), add `"iphoneShot": "<name>.png"` or `"iphoneClip": { "file": "<name>.mp4", "trimStart": 0, "speed": 1 }` on any beat. In `16:9`, the web window shifts neatly left and a sleek iPhone bezel slides in on the right; in `9:16`, the iPhone bezel centers cleanly in the frame.

## Verification checklist (always run before sharing)

1. Inspect `contact-sheet-*.png` and `end-frame-*.png` with `read_file` to verify framing, crisp typography (including Icelandic `þ/ð/æ/ö`), no clipped end card, and no awkward pill overlaps.
2. Check the `ffprobe` stream info and `volumedetect` printed by `fama-demo` (video 1920×1080 or 1080×1920 H.264, audio 48 kHz AAC, peak around `-1` to `-4 dB`).
3. Embed the final MP4 in chat using Markdown image syntax with its absolute path so the user can watch it inline.
