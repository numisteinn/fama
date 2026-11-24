# Roadmap

Features we plan to add, and how to build many of them at the same time. Most come from two similar projects, [abogen](https://github.com/denizsafak/abogen) and [pdf-narrator](https://github.com/mateogon/pdf-narrator). Both have open licenses, so read their code before you build the same feature.

## The shape of the work

Today the worker extracts and narrates in one step, and the Document lives only inside the worker. Three of the four main features need the Document outside the worker, and a stop between extraction and narration. That is one foundation, not three features that each build it.

| Feature | Needs the stored Document | Needs the stop before narration |
|---|---|---|
| Read-along | no | no |
| Review | yes | yes |
| Voice sample | yes | yes (the worker must be free) |
| Narrate again | yes | no |

So the work is one foundation unit (`F`), then lanes that fan out from it. Read-along and the small lanes do not need `F` and start now.

```
now ──┬─ F   Stored Document ──┬─ V1 Review core ──┬─ V2 Review web ─────┬─ S2 Sample web
      │                        │                   ├─ V3 Review iPhone ──┴─ S3 Sample iPhone
      │                        │                   └─ N1 Narrate again core ──┬─ N2 web
      │                        └─ S1 Sample core                              └─ N3 iPhone
      ├─ R1  Timing file ──┬─ R2 Reader web
      │                    ├─ R3 Reader iPhone
      │                    └─ R4 Feed transcript
      ├─ E   Time left
      ├─ M   Add many files
      └─ X   Extraction (OCR, PDF library)
```

Five units can start now: `F`, `R1`, `E`, `M`, `X`. After `F` and `R1` land, five more can run: `V1`, `S1`, `R2`, `R3`, `R4`.

## Rules for parallel work

1. **One unit is one branch and one PR.** The branch name is `roadmap/<id>`, for example `roadmap/r1`. An open PR or branch with that name means the unit is taken. Look with `gh pr list` and `git branch -r` before you start. There is no status table to edit.
2. **A unit starts only when the units before it are on `main`.** The graph above gives the order.
3. **New code goes in new files.** The table in "Files" gives each unit its own files. In a shared file, a unit adds only the lines that connect its new file (one export, one route layer, one message case).
4. **The shapes in this file are the seams.** A unit that must change a shape another unit uses changes this file in the same PR, and says so in the PR title.
5. **Each unit owns one migration file.** Numbers are reserved in "Files". Do not edit another unit's migration.
6. **Each unit ends with its proof.** Tests, a verify-fama run, and a recipe in `.claude/skills/verify-fama/features/`. The PR also removes the unit from this file and updates `CONTEXT.md` and `docs/api.md` for its own terms and routes.

## Foundation

### F. Stored Document

The worker uploads the Document after extraction. The API stores it. From then on the worker narrates from the stored Document and does not extract again.

- Why: Review edits it, Voice sample reads from it, Narrate again compares against it. A retry also gets cheaper, because it does not download and extract again.
- Shape: `Document { title, author, language, chapters: [{ title, text }] }`. Stored at `users/<userId>/episodes/<episodeId>/document.json`.
- Rule: audio chapter `i` narrates Document chapter `i`. No unit may break this.
- Worker routes: `PUT /api/worker/jobs/:id/document`. `ClaimedJob` gains `documentPath`, set when a Document exists. The worker then reads it and skips extraction.
- Client route: `GET /api/episodes/:id/document`.
- In the worker, `process` splits into two functions: extract (source to stored Document) and narrate (stored Document to audio).
- `CONTEXT.md` changes: the Document no longer "lives only inside the worker".
- Proof: fail a job after extraction, retry it, and the worker log shows no second extraction. The episode audio is the same as before.

## Lanes

### R. Read-along

The app shows the text and marks the sentence the voice reads now. A tap on a sentence moves playback to it.

First principles: the mark must never be on the wrong sentence. So each marked unit needs a real start time, not an estimate.

- Measured on 2026-11-24 with Kokoro (17 chunks, 59 sentence starts, technical prose): one chunk holds 4.5 sentences and 24 s of audio on average. An estimate of the sentence start from its share of the characters is wrong by 0.41 s (median) and 1.49 s (90th percentile). The old roadmap line "sentence timing costs nothing extra" is not correct: the worker knows the duration of a chunk, not of a sentence.
- Design: a **Segment** is the text of one synthesis call with its start and end time. For read-along the worker makes one Segment for each sentence. Very short sentences can join the next one.
- `R1` must measure the cost first: narration speed (audio seconds per wall second) and sound, with one sentence for each call against today's chunks, for Kokoro and for Piper. If the cost is too high for one engine, that engine uses its own word timestamps (Kokoro has them) and keeps its chunks.
- The Segment keeps the text as the Document has it ("3 bækur"), not the normalized text the engine reads. So the worker splits first and normalizes each Segment after.

Units:

- **R1. Timing file** (worker, API, contract). For each chapter the worker uploads `chapters/<index:000>.json` next to the audio: `{ segments: [{ text, startMs, endMs, endsParagraph }] }`. Times are from the start of the chapter. The spoken title is a Segment too. `Chapter` gains `timingUrl: string | null`. An old episode has `null` and shows no text. Proof: for each chapter, the last `endMs` is within 50 ms of `durationMs`, and each `startMs` lands on the start of that sentence when you listen.
- **R2. Reader on the web.** After R1.
- **R3. Reader on the iPhone.** After R1.
- **R4. Transcript in the feed.** After R1. The API builds one WebVTT file for the book file from the timing files and the chapter durations, and the feed item gets a `podcast:transcript` tag.

### V. Review

A stop between extraction and narration. The user sees the chapters, unticks some, corrects text, and then starts narration.

First principles: this is the only moment when a change costs no narration time. So Review is the home of each choice that changes the audio: the chapters, the text, and the voice (lane `S`).

- Review is a choice at add time, off by default. A link stays one tap. The old roadmap said "files only". That limit is gone, because Voice sample needs the same stop for a link.
- New job state `Review`, between `Running` (extracting) and `Queued` (for narration). `claim` does not take a job in `Review`.
- `PUT /api/episodes/:id/document` stores the edited Document. Only in `Review`.
- `POST /api/episodes/:id/start` moves the job to `Queued`. Chapters that are not ticked are removed from the Document at this point, so the rule from `F` holds.
- "Remove a header that repeats on each page" is not part of Review. The PDF extractor already does it (see "Already in Fama"). A text correction covers what is left.

Units: **V1** core (API, contract, worker), then **V2** web and **V3** iPhone.

### S. Voice sample

In Review, each voice reads the first paragraph of your Document. You choose by ear.

First principles: a sample is `(text, voice)` to a short clip. The text must come from the Document, so the sample comes after extraction, not before the add as the old roadmap said. This matters most for Icelandic, where the choice is between Piper voices.

- A sample is not an episode job. It is a second kind of work: `claim` returns `Narrate` or `Sample`. Sample work is claimed first.
- `POST /api/episodes/:id/samples` asks for clips for the voices of the Document's language. The worker uploads each clip to `episodes/<episodeId>/samples/<voice>.m4a`. `GET /api/episodes/:id/samples` lists them.
- Limit: a worker that narrates another episode finishes that job first. With one Mac worker, a sample can wait.

Units: **S1** core (worker, API, contract) after `F`. **S2** web and **S3** iPhone add the samples to the Review screen, so they come after `V2` and `V3`.

### N. Narrate again

When the text, the voice or the speed of a chapter changes, the worker narrates only the chapters that changed and builds the book file again.

First principles: a chapter's audio is stale when its inputs differ from the inputs that made it. One rule covers an edited chapter, a new voice and a new speed. It also replaces `completedChapters`.

- Each uploaded chapter stores `inputHash`: a hash of the chapter text, the voice and the speed.
- `ClaimedJob.completedChapters` becomes `chapters: [{ index, inputHash }]`. The worker skips a chapter whose hash matches.
- `PUT /api/episodes/:id/document` also works on a `Ready` or `Failed` episode, for chapter text only. The number of chapters cannot change. `PUT /api/episodes/:id/voice` changes the voice and the speed. Both put the job back to `Queued`.
- While the job runs again, the old audio of a stale chapter stays playable until the new upload replaces it.

Units: **N1** core after `V1` (it extends the same route and the claim), then **N2** web and **N3** iPhone.

### E. Time left

The episode row shows the time left while the job runs, not only `Narrating n/m`.

- The worker knows the characters left and its speed. `ProgressRequest` and `JobState.Running` gain `remainingMs: number | null`.
- One unit: worker, API, contract, the row on the web and on the iPhone.

### M. Add many files

Pick many files, or a folder, and get one episode for each.

- Clients only. The queue already handles many jobs.
- One unit for the web add bar and the iPhone Add screen. It lands before `V2` and `V3`, which add the Review switch to the same screens.

### X. Extraction

All work inside `worker/src/fama_worker/extract/` and `normalize.py`. One unit at a time, because the units share `pdf.py`.

- **X1. Replace PyMuPDF** (AGPL) with `pypdfium2`. Needed before we charge for a managed service. It goes first, because OCR builds on the PDF code.
- **X2. OCR for scanned PDFs.** A scanned PDF has no text to extract. On the Mac, Apple Vision OCR works offline. Check its Icelandic support first. Seen in: abogen (on its roadmap).
- **X3. LLM pass to fix text, for Icelandic only.** This fixes Icelandic numbers ("3 bækur" must be read as "þrjár bækur"), which the rules in `normalize.py` do not handle. Optional, with a local model or an API model. Seen in: abogen.

## Files

A unit may edit the files in its row. Other files get connecting lines only (rule 3).

| Unit | Its own files | Migration |
|---|---|---|
| F | `contracts/src/document.ts`, `apps/api/src/routes/document.ts`, `worker/.../work.py` (the split of `process`) | `0002_document.sql` |
| R1 | `contracts/src/timing.ts`, `apps/api/src/routes/timing.ts`, `worker/.../pipeline.py`, `worker/.../chunk.py` | `0003_timing.sql` |
| R2 | `apps/web/src/reader/` | |
| R3 | `apps/mobile/src/reader/` | |
| R4 | `apps/api/src/feed.ts`, `apps/api/src/transcript.ts` | |
| V1 | `contracts/src/review.ts`, `apps/api/src/routes/review.ts`, `apps/api/src/job.ts` | `0004_review.sql` |
| V2, V3 | `apps/web/src/review/`, `apps/mobile/src/review/` | |
| S1 | `contracts/src/sample.ts`, `apps/api/src/routes/sample.ts`, `apps/api/src/sample-repo.ts`, `worker/.../sample.py` | `0005_samples.sql` |
| S2, S3 | `apps/web/src/review/samples.ts`, `apps/mobile/src/review/Samples.tsx` | |
| N1 | `contracts/src/stale.ts`, `apps/api/src/routes/review.ts`, `worker/.../pipeline.py` (the skip rule) | `0006_input_hash.sql` |
| N2, N3 | `apps/web/src/review/`, `apps/mobile/src/review/` | |
| E | `worker/.../work.py` (`Progress`), `apps/web/src/view/library.ts`, `apps/mobile/src/components/EpisodeRow.tsx` | `0007_remaining.sql` |
| M | `apps/web/src/view/addBar.ts`, `apps/mobile/src/app/(tabs)/add/index.tsx` | |
| X | `worker/.../extract/`, `worker/.../normalize.py` | |

Known shared points, and who goes first:

- `worker/.../work.py`: `F` and `E`. `E` touches only `Progress` and the heartbeat. `F` touches only `process`.
- `worker/.../pipeline.py`: `R1` (the plan and the render), then `N1` (the skip rule). `N1` starts after `R1` is on `main`.
- `claim` in `job.ts` and `episode-repo.ts`: `F`, then `V1` and `S1`, then `N1`. `V1` and `S1` each add their own branch to the claim. The second one to merge rebases.
- `JobState.Running`: `E` adds a field, `V1` adds a state next to it. Either order works.

## Open choices

Each has a default. A unit follows the default unless the owner says no.

1. **Read-along narrates one sentence for each call.** `R1` measures the cost first. Default: accept up to 20% slower narration when the sound is the same to the ear.
2. **Review is for all sources, off by default.** The old roadmap said files only.
3. **Voice samples exist only in Review.** No sample before the add, and none for an episode that already narrates.
4. **Unticked chapters are removed at Start.** You cannot tick them again later.
5. **Narrate again also covers a new voice and a new speed.** The old roadmap had only edited text.

## Already in Fama

- M4B book file with chapters, title, author and cover.
- Chapter 1 plays while the worker narrates the other chapters.
- After a stop, a job continues and keeps its finished chapters.
- Each job keeps its own voice and narration speed.
- Chapters come from Markdown headings in text.
- Cover, copyright and contents pages are skipped.
- Repeated PDF page headers, footers and page numbers are removed (`extract/pdf.py`, tested in `test_extract.py`). The old roadmap listed this as missing. If a real PDF still reads its header, add that file as a test case in lane `X`.
- Project Gutenberg license text is removed from pasted text and from EPUB files (`extract/plain.py`, `extract/epub.py`, tested). The old roadmap listed this as missing too.

## Not planned

- **Mix Kokoro voices.** Kokoro has no Icelandic voices, and this feature brings little value for a single user.
- **Send to Audiobookshelf.** The private feed already does this job.
- **Export MP3 for each chapter, or WAV, FLAC or Opus.** The apps and the feed play the M4B, and `Download` gives you the file.
- **Narrate subtitle files or text with timestamps.** These are for video voiceovers, not for listening.
- **GPU or CPU choice, offline model download.** The worker manages these by itself.

## Before charging for a managed service

- `X1`: replace PyMuPDF (AGPL) or change the license.
- Measure the GPU cost per hour of audio on Modal. The price depends on it.
- Design: [design/two-paths.md](design/two-paths.md).
