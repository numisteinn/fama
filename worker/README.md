# Fama worker

The worker turns a source (link, file or pasted text) into narrated audio: one AAC `.m4a` per chapter and one `.m4b` book file with chapter marks, title, author and cover. It runs on a Mac (Apple GPU through MPS) and, later, on Modal (CUDA). Terms follow `../CONTEXT.md`. The HTTP contract is `../docs/api.md`.

## Install

You need [uv](https://docs.astral.sh/uv/) and ffmpeg (`brew install ffmpeg`).

```bash
cd worker
uv sync
```

The first run of each voice downloads its model from Hugging Face: Kokoro is about 330 MB, a Piper voice about 63 MB.

## Commands

```bash
uv run fama make https://is.wikipedia.org/wiki/Reykjav%C3%ADk      # language detected, default voice
uv run fama make book.epub --voice kokoro:bm_george --speed 1.1 --out out
uv run fama make paper.pdf
pbpaste | uv run fama make -                                        # pasted text
uv run fama voices                                                  # all voices, defaults marked
uv run fama work --api http://localhost:8787 --token dev-worker-token  # pull jobs (FAMA_WORKER_TOKEN)
```

`fama make` writes:

```
out/<slug>/chapters/000.m4a ...
out/<slug>/book.m4b
out/<slug>/cover.jpg        (when the source has one)
out/<slug>/episode.json     (title, language, voice, chapter durations)
```

`fama work` loops: claim a job (with the worker token, `FAMA_WORKER_TOKEN` on the API), send its lease token on every job call, send progress at least every 30 seconds, upload each chapter as soon as it is encoded, then the book, then complete. A `409` drops the job. Chapters listed in `completedChapters` are not uploaded again. `--once` stops after one job or an empty queue.

Settings:

| Variable | Default | Meaning |
|---|---|---|
| `FAMA_DEVICE` | `auto` | `cuda`, `mps` or `cpu`. `auto` picks the first one present in that order. |
| `FAMA_CACHE_DIR` | `~/.cache/fama/chunks` | Synthesized chunks, as 16-bit FLAC. |

## How it works

`extract` (Source to Document) → `normalize` (numbers, abbreviations, URLs, footnotes) → `chunk` (sentences packed to the engine's limit, never across a paragraph) → `synthesize` (through the chunk cache) → `encode` (one `.m4a` per chapter) → `assemble` (one `.m4b`, no re-encode).

- The chunk cache key is `sha256(text, engine, voice, model version, speed)`. A re-run or a retried job only synthesizes chunks it has not made before.
- `engines/__init__.py` holds the two tables: `ENGINES` (name to engine) and `DEFAULT_VOICE` (language to voice). To add an engine, write a class with `name`, `model_version`, `max_chars`, `voices()` and `synthesize(text, voice_id, speed)`, and add one line to `ENGINES`.
- Defaults come from the bakeoff in `BAKEOFF.md`: `kokoro:af_heart` for English, `piper:is_IS-steinn-medium` for Icelandic.

## Tests

```bash
uv run pytest
```

The tests cover extraction (built EPUB and PDF fixtures, article markdown, Gutenberg text), normalization, chunking, cache keys, re-run idempotency, the `.m4b` layout (ffprobe), and `fama work` against a fake API server: the full run, a `409` drop, a resume with `completedChapters`, and a failed job.

## Bakeoff

```bash
uv run --group bakeoff python bakeoff/run.py           # all candidates, Apple Silicon only
uv run --group bakeoff python bakeoff/run.py --only is
```

Samples go to `~/Developer/fama-samples/<lang>/<engine>-<voice>.m4a`. Results go to `bakeoff/results.json`. See `BAKEOFF.md`.

## Licenses

See `NOTICE.md`. The worker code is MIT. `piper-tts` (GPL-3.0) and `PyMuPDF` (AGPL-3.0) are copyleft dependencies.
