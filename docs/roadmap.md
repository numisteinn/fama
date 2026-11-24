# Roadmap

Features we plan to add, and how to build many of them at the same time. Most come from two similar projects, [abogen](https://github.com/denizsafak/abogen) and [pdf-narrator](https://github.com/mateogon/pdf-narrator). Both have open licenses, so read their code before you build the same feature.

## The shape of the work

The worker stores the Document with the API after extraction (unit `F`, done). Three of the four main features need that stored Document, and a stop between extraction and narration. That is one foundation, not three features that each build it.

| Feature | Needs the stored Document | Needs the stop before narration |
|---|---|---|
| Read-along | no | no |
| Review | yes | yes |
| Voice sample | yes | yes (the worker must be free) |
| Narrate again | yes | no |

The foundation and the timing file are built. The lanes fan out from them.

```
now ──┬─ V1 Review core ──┬─ V2 Review web ─────┬─ S2 Sample web
      │                   ├─ V3 Review iPhone ──┴─ S3 Sample iPhone
      │                   └─ N1 Narrate again core ──┬─ N2 web
      │                                              └─ N3 iPhone
      ├─ S1  Sample core
      ├─ R2  Reader web
      ├─ R3  Reader iPhone
      ├─ R4  Feed transcript
      └─ X   Extraction (OCR, PDF library)
```

Six units can start now: `V1`, `S1`, `R2`, `R3`, `R4`, `X`.

## Rules for parallel work

1. **One unit is one branch and one PR.** The branch name is `roadmap/<id>`, for example `roadmap/r1`. An open PR or branch with that name means the unit is taken. Look with `gh pr list` and `git branch -r` before you start. There is no status table to edit.
2. **A unit starts only when the units before it are on `main`.** The graph above gives the order.
3. **New code goes in new files.** The table in "Files" gives each unit its own files. In a shared file, a unit adds only the lines that connect its new file (one export, one route layer, one message case). Put such a line in alphabetical order with its neighbors, not at the end of the list. Two units that both add a line at the end get a merge conflict.
4. **The shapes in this file are the seams.** A unit that must change a shape another unit uses changes this file in the same PR, and says so in the PR title.
5. **Each unit owns one migration file.** Numbers are reserved in "Files". Do not edit another unit's migration.
6. **API routes and their tests go in their own files.** A route file imports its guards from `apps/api/src/routes/kit.ts`. Its test uses `apps/api/src/test-app.ts`, which applies each migration file. A unit that adds a table adds its name to `TABLES` there.
7. **Each unit ends with its proof.** Tests, a verify-fama run, and a recipe in `.claude/skills/verify-fama/features/`. The PR also removes the unit from this file and updates `CONTEXT.md` and `docs/api.md` for its own terms and routes.

## Lanes

### R. Read-along

The app shows the text and marks the sentence the voice reads now. A tap on a sentence moves playback to it.

First principles: the mark must never be on the wrong sentence. So each marked unit needs a real start time, not an estimate.

- Built: the **timing file**. For each chapter the worker uploads its Segments with their times next to the audio, and `Chapter.timingUrl` points to the file. An old episode has `null` and shows no text. `docs/api.md` ("Timing file") has the shape and the rules a reader needs.
- A **Segment** is the text of one synthesis call: one sentence, or a few short ones (a sentence under 20 characters joins the next one). It keeps the text as the Document has it ("3 bækur"), not the text the engine reads. The spoken title is a Segment too.
- `startMs` is where the voice starts the sentence, so a tap on a sentence can seek to it. The worker makes one call for each sentence, because only then does it know that time. An estimate from the sentence's share of the characters of a packed chunk was wrong by 0.41 s (median) and 1.49 s (90th percentile).
- Cost: open choice 1 has the numbers.

Units:

- **R2. Reader on the web.**
- **R3. Reader on the iPhone.**
- **R4. Transcript in the feed.** The API builds one WebVTT file for the book file from the timing files and the chapter durations, and the feed item gets a `podcast:transcript` tag.

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


### X. Extraction

All work inside `worker/src/fama_worker/extract/` and `normalize.py`. One unit at a time, because the units share `pdf.py`.

- **X1. Replace PyMuPDF** (AGPL) with `pypdfium2`. Needed before we charge for a managed service. It goes first, because OCR builds on the PDF code.
- **X2. OCR for scanned PDFs.** A scanned PDF has no text to extract. On the Mac, Apple Vision OCR works offline. Check its Icelandic support first. Seen in: abogen (on its roadmap).
- **X3. LLM pass to fix text, for Icelandic only.** This fixes Icelandic numbers ("3 bækur" must be read as "þrjár bækur"), which the rules in `normalize.py` do not handle. Optional, with a local model or an API model. Seen in: abogen.

## Files

A unit may edit the files in its row. Other files get connecting lines only (rule 3).

| Unit | Its own files | Migration |
|---|---|---|
| R2 | `apps/web/src/reader/` | |
| R3 | `apps/mobile/src/reader/` | |
| R4 | `apps/api/src/feed.ts`, `apps/api/src/transcript.ts` | |
| V1 | `contracts/src/review.ts`, `apps/api/src/routes/review.ts`, `apps/api/src/job.ts` | `0004_review.sql` |
| V2, V3 | `apps/web/src/review/`, `apps/mobile/src/review/` | |
| S1 | `contracts/src/sample.ts`, `apps/api/src/routes/sample.ts`, `apps/api/src/sample-repo.ts`, `worker/.../sample.py` | `0005_samples.sql` |
| S2, S3 | `apps/web/src/review/samples.ts`, `apps/mobile/src/review/Samples.tsx` | |
| N1 | `contracts/src/stale.ts`, `apps/api/src/routes/review.ts`, `worker/.../pipeline.py` (the skip rule) | `0006_input_hash.sql` |
| N2, N3 | `apps/web/src/review/`, `apps/mobile/src/review/` | |
| X | `worker/.../extract/`, `worker/.../normalize.py` | |

Known shared points, and who goes first:

- `claim` in `job.ts` and `episode-repo.ts`: `F`, then `V1` and `S1`, then `N1`. `V1` and `S1` each add their own branch to the claim. The second one to merge rebases.

## Open choices

Each has a default. A unit follows the default unless the owner says no.

1. **Read-along narrates one sentence for each call.** Decided by measurement on 2026-11-24 (Apple M5 Pro, median of 7 runs, a new process for each run, `worker/BAKEOFF.md`). The limit was 20% slower narration with the same sound.
   - Kokoro (`af_heart`, MPS): 31.0x real time packed and 26.6x by sentence on article prose, 14% slower. On fiction 31.0x and 27.4x, 12% slower. The limiter is a fixed cost of 90 to 120 ms for each call, so text with many short sentences in long paragraphs costs most (about 20%, computed).
   - Piper (`is_IS-steinn-medium`, CPU): 69.7x and 69.5x, no measurable difference. Piper already synthesizes each sentence alone.
   - Both engines use one call for each sentence. No engine needed the other path (sentence times from the engine's own word timestamps), which Kokoro has for English voices only.
   - Sound: the pause between sentences is as before, because a Segment that continues a paragraph drops the silence its call opens with. The owner should still listen: `~/Developer/fama-samples/read-along/`.
2. **Review is for all sources, off by default.** The old roadmap said files only.
3. **Voice samples exist only in Review.** No sample before the add, and none for an episode that already narrates.
4. **Unticked chapters are removed at Start.** You cannot tick them again later.
5. **Narrate again also covers a new voice and a new speed.** The old roadmap had only edited text.

## Already in Fama

- M4B book file with chapters, title, author and cover.
- The stored Document (unit `F`). The worker uploads the Document after extraction, and each later attempt narrates from the stored one. The shape and the routes are in `docs/api.md` ("Document"). The rule that no unit may break: audio chapter `i` narrates Document chapter `i`. A new route file builds on `apps/api/src/routes/kit.ts`, and its tests on `apps/api/src/test-app.ts`.
- Chapter 1 plays while the worker narrates the other chapters.
- After a stop, a job continues and keeps its finished chapters.
- Each job keeps its own voice and narration speed.
- Chapters come from Markdown headings in text.
- Many files, or a dropped folder on the web, make one episode each.
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
