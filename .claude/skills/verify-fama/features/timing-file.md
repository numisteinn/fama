# Timing file

For each chapter the worker uploads a timing file next to the audio. It lists the Segments of the chapter (one sentence, or a few short ones) with the time the voice starts and stops each one. Each chapter of an episode has a `timingUrl` that serves this file as JSON. No screen shows it yet: the readers (roadmap `R2`, `R3`) and the feed transcript (`R4`) build on it. So this recipe proves the file against the real audio.

## Sub-features

- `timing-listed` gives each chapter a `timingUrl`, set as soon as the chapter is listed.
- `timing-served` serves the file as `application/json` in the shape `{ segments: [{ text, startMs, endMs, endsParagraph }] }`.
- `timing-document-text` keeps the Document text in `text` ("41 years"), not the text the engine reads ("forty-one years").
- `timing-title` has the spoken title, author and chapter title as the first Segments.
- `timing-covers-chapter` ends the last Segment within 50 ms of the chapter's `durationMs`.
- `timing-on-the-voice` puts each `startMs` in the pause before its own sentence, and each `endMs` where the voice stops.
- `timing-old-episode` leaves `timingUrl` as `null` for a chapter that has no timing file.

## How to get to it (user POV)

- Add any source (see [Add a file](./add-file.md) and [Add a link](./add-link.md)). The user does nothing more: the worker makes the timing files while it narrates.
- There is no screen for it yet. A client reads `chapters[].timingUrl` from `GET /api/episodes` and fetches the file from the media path.

## Driving it with preview tools and agent-device

Preconditions:

- Baseline from `README.md`. No preview tab and no simulator are needed.
- `ffmpeg` on `PATH`. For the transcript step: `(cd worker && uv sync --group bakeoff)`, which adds Whisper (Apple Silicon only).

- **Add a file.** On the web, attach `harbour-days.epub` as in [Add a file](./add-file.md). Without a tab: `curl -fsS -H 'Authorization: Bearer dev-api-token' -F file=@.claude/skills/verify-fama/fixtures/harbour-days.epub "$WEB/api/episodes/upload"` and take `id` from the answer.
- **Ready.** Run `fama-verify wait <id>`. The output starts with `Ready`.
- **Listed and served.** Run `fama-verify api GET /api/episodes/<id>` and save it. Each entry of `chapters` has `timingUrl` `/media/dev-feed-token/episodes/<id>/chapters/00<n>.json`. `curl -si "$WEB<timingUrl>"` answers `200` with `content-type: application/json`. The first Segments of chapter 0 are the title, the author and the chapter title, each with `endsParagraph: true`.
- **Document text.** Add a text with numbers and an abbreviation, for example `It took 41 years to build the church, from 1945 to 1986. Dr. Jones says the tower is 74.5 metres tall. Oh dear! Nobody in the town liked it at first.` The Segments keep `41`, `1945 to 1986` and `74.5 metres` in `text`. `Dr. Jones says ...` is one Segment, not two. `Oh dear!` shares a Segment with the sentence after it.
- **Against the audio.** Run `uv run --project worker python .claude/skills/verify-fama/scripts/check-timing.py <id> --out "$EVIDENCE/timing/<id>"`. For each chapter it downloads the audio and the timing file and checks: the last `endMs` is within 50 ms of `durationMs`; the 90 ms before each `startMs` and after each `endMs` are silent (under -55 dB); the voice starts at most 60 ms after each `startMs`. It prints one line per chapter (`last endMs 27160 vs durationMs 27160 (+0 ms), voice starts 0 to 60 ms after startMs`) and ends with `timing: ok`. A failure prints `FAIL` with the Segment and exits 1.
- **Listen.** The same run cuts three Segments of each chapter out of the audio with ffmpeg, from `startMs` to `endMs`, as `<chapter>-cut-<segment>.wav`. Each file must hold that sentence, whole, and nothing else.
- **Transcript.** Add `--transcribe` and run it with `uv run --project worker --group bakeoff python ...`. For each cut it prints `text` and what Whisper `heard`. They must be the same words (Whisper writes numbers its own way). Whisper needs English audio here; for Icelandic, listen.
- **Old episode.** A chapter without a timing file cannot be made by this worker. The API test `a chapter without a timing file has timingUrl null` in `apps/api/src/http.test.ts` proves it.
- **Proof.** `$EVIDENCE/timing/<id>/` holds `check-timing.json` (each Segment with its levels and voice onset), the chapter audio, the timing files and the cuts. Save the script output and the episode JSON there too.

## Gotchas

- The script reads the port from `FAMA_VERIFY_API_PORT` (default 8788), the same variable as `fama-verify`.
- The worker uploads the timing file before the chapter audio, and the API lists a chapter when the audio arrives. So a `Running` episode never shows a chapter with `timingUrl: null`. If one does, the worker is from before timing files: `doctor` prints the build commit.
- An engine opens each call with silence (Kokoro with 0.3 s). The worker drops it for a Segment that continues a paragraph and keeps it before a new paragraph, and `startMs` is where the voice starts in both cases. So the first `startMs` of a chapter is about 300 ms for Kokoro, not 0.
- `endMs` is where the audio of the Segment ends. The engine closes each call with silence (Kokoro with 0.5 s), and that silence is inside the Segment. So a cut from `startMs` to `endMs` ends with a short silence.
- A Segment is not always one sentence. A sentence under 20 characters joins the next one, and a heading (`CHAPTER I.`) is its own paragraph. A sentence over the engine's limit (400 characters for Kokoro, 500 for Piper) becomes two or more Segments.
- The chunk cache makes a second run fast, and the times are the same: they come from the audio, cached or not.
- `timingUrl` is a media path. It needs the feed token in the path and no `Authorization` header, like chapter audio.
