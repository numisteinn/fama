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

The foundation, Read-along, Review, Voice sample, Narrate again, links that the phone fetches, and OCR for scanned PDFs are built. What is left from v1 is the optional Icelandic LLM text pass (`X3`).

Wave 1 adds daily-listening UX, UI polish, and quality-of-life improvements (`P`, `O`, `T`, `Q`). Tags/folders, Up Next queue (`U`), and Bookmarks (`B`) wait for a later wave.

```
Round 1 (now) ──┬── P1 Voice previews (API + worker) ──┬── P2 Web voice preview
                │                                       └── P3 iPhone voice preview
                ├── O1 Organize API (archive + rename) ─┬── O2 Web library UX
                │                                       └── O3 iPhone library UX
                ├── T1 Web sleep timer ──────────────────── Q1 Web shortcuts + scrubber marks
                ├── T2 iPhone sleep timer
                ├── Q2 iPhone offline hot-swap + reader resume
                └── X3 LLM text fix (Icelandic)
```

Six units can start now: `P1`, `O1`, `T1`, `T2`, `Q2`, and `X3`. Once Round 1 lands on `main`, Round 2 (`P2`, `P3`, `O2`, `O3`, `Q1`) runs in parallel with disjoint files.

## Rules for parallel work

1. **One unit is one branch and one PR.** The branch name is `roadmap/<id>`, for example `roadmap/r1`. An open PR or branch with that name means the unit is taken. Look with `gh pr list` and `git branch -r` before you start. There is no status table to edit.
2. **A unit starts only when the units before it are on `main`.** The graph above gives the order.
3. **New code goes in new files.** The table in "Files" gives each unit its own files. In a shared file, a unit adds only the lines that connect its new file (one export, one route layer, one message case). Put such a line in alphabetical order with its neighbors, not at the end of the list. Two units that both add a line at the end get a merge conflict.
4. **The shapes in this file are the seams.** A unit that must change a shape another unit uses changes this file in the same PR, and says so in the PR title.
5. **Each unit owns one migration file.** Numbers are reserved in "Files". Do not edit another unit's migration.
6. **API routes and their tests go in their own files.** A route file imports its guards from `apps/api/src/routes/kit.ts`. Its test uses `apps/api/src/test-app.ts`, which applies each migration file. A unit that adds a table adds its name to `TABLES` there.
7. **Each unit ends with its proof.** Tests, a verify-fama run, and a recipe in `.claude/skills/verify-fama/features/`. The PR updates `CONTEXT.md` and `docs/api.md` for its own terms and routes. It does not edit this file. The one who merges the PR removes the unit here. When each unit edited the graph in this file, each PR had a merge conflict.

## Lanes

### R. Read-along

The app shows the text and marks the sentence the voice reads now. A tap on a sentence moves playback to it.

First principles: the mark must never be on the wrong sentence. So each marked unit needs a real start time, not an estimate.

- Built: the **timing file**. For each chapter the worker uploads its Segments with their times next to the audio, and `Chapter.timingUrl` points to the file. An old episode has `null` and shows no text. `docs/api.md` ("Timing file") has the shape and the rules a reader needs.
- A **Segment** is the text of one synthesis call: one sentence, or a few short ones (a sentence under 20 characters joins the next one). It keeps the text as the Document has it ("3 bækur"), not the text the engine reads. The spoken title is a Segment too.
- `startMs` is where the voice starts the sentence, so a tap on a sentence can seek to it. The worker makes one call for each sentence, because only then does it know that time. An estimate from the sentence's share of the characters of a packed chunk was wrong by 0.41 s (median) and 1.49 s (90th percentile).
- Cost: open choice 1 has the numbers.

All four units are built: the timing file, the reader on the web and on the iPhone, and the transcript in the feed (`docs/api.md`, "Feed and transcript").

### V. Review

A stop between extraction and narration. The user sees the chapters, unticks some, corrects text, and then starts narration.

First principles: this is the only moment when a change costs no narration time. So Review is the home of each choice that changes the audio: the chapters, the text, and the voice (lane `S`).

- Review is a choice at add time, off by default. A link stays one tap. The old roadmap said "files only". That limit is gone, because Voice sample needs the same stop for a link.
- New job state `Review`, between `Running` (extracting) and `Queued` (for narration). `claim` does not take a job in `Review`.
- `PUT /api/episodes/:id/document` stores the edited Document. Only in `Review`.
- `POST /api/episodes/:id/start` moves the job to `Queued`. Chapters that are not ticked are removed from the Document at this point, so the rule from `F` holds.
- "Remove a header that repeats on each page" is not part of Review. The PDF extractor already does it (see "Already in Fama"). A text correction covers what is left.

The Review API takes the full Document at Start. Send the corrected text and only the kept chapters, in order. See [the HTTP contract](./api.md#review).

Built on the web and the iPhone.

### S. Voice sample

In Review, each voice reads the first paragraph of your Document. You choose by ear.

The Sample API is in place. Once an Episode has a stored Document, use `POST /api/episodes/:id/samples` to ask for clips and `GET /api/episodes/:id/samples` to read the states and URLs. See [the Sample contract](api.md#samples). A Worker finishes any narration it already started before it claims Samples.

Built on the web and the iPhone.

### N. Narrate again

When the text, the voice or the speed of a chapter changes, the worker narrates only the chapters that changed and builds the book file again.

First principles: a chapter's audio is stale when its inputs differ from the inputs that made it. One rule covers an edited chapter, a new voice and a new speed. It also replaces `completedChapters`.

- Each uploaded chapter stores `inputHash`: a hash of the chapter text, the voice and the speed.
- `ClaimedJob.completedChapters` becomes `chapters: [{ index, inputHash }]`. The worker skips a chapter whose hash matches.
- `PUT /api/episodes/:id/document` also works on a `Ready` or `Failed` episode, for chapter text only. The number of chapters cannot change. `PUT /api/episodes/:id/voice` changes the voice and the speed. Both put the job back to `Queued`.
- While the job runs again, the old audio of a stale chapter stays playable until the new upload replaces it.
- The API keeps each Document version under its own key and the episode points at the current one (`documentKey` in `episode-repo.ts`). Read the Document through it, never through a fixed key.
- The API stores the feed transcript after the first request. When a chapter changes, delete the stored transcript.
- The timing file of a chapter changes with its audio. The readers keep timing files in memory and on the phone, so they must load them again.

Built across the API, worker, web, and iPhone.


### L. Links the phone fetches

Some sites block the cloud worker. mbl.is answers Modal's data-center address with a Cloudflare challenge (`403`, `cf-mitigated: challenge`) for any user agent, and the same page loads from a home address (measured 2026-11-24).

First principles: the device that has the link is on a network the site accepts, and it may be logged in. So the device fetches the page, and the worker reads what it got.

- **L1** (built). The iPhone app (the Add screen and the share sheet) downloads the page of a link and sends it with the link. `POST /api/episodes/upload` takes an optional `url` form field. With it, the episode's source stays `{_tag: "Url", url}`, the stored bytes are the page, and `ClaimedJob.sourcePath` is set for that `Url` job. The worker then reads the bytes and runs the web extractor with the link as its base URL, and does not fetch. When the phone cannot fetch, it sends the link alone, as today.
- The web app cannot do this: a browser may not read a page from another site. Links added on the web still go through the worker.

### X. Extraction

All work inside `worker/src/fama_worker/extract/` and `normalize.py`. One unit at a time, because the units share `pdf.py`.

- **X2** (built). **OCR for scanned PDFs.** Scanned and hybrid PDF pages with no text layer are read offline with `tesseract` (`isl+eng` when installed, keeping Icelandic letters intact) or Apple Vision on macOS as a fallback, then cleaned by `pdf.py`.
- **X3. LLM pass to fix text, for Icelandic only.** This fixes Icelandic numbers ("3 bækur" must be read as "þrjár bækur"), which the rules in `normalize.py` do not handle. Optional, with a local model or an API model. Seen in: abogen.

### P. Instant Voice Audio Previews

Every catalog Voice gets one short (~3 s) pre-generated `.m4a` clip in its native language, stored in R2 (`voices/<voiceId>.m4a`) and served publicly (`GET /voice-previews/:id`) with immutable caching. Picking a voice in the Add bar or Narrate Again plays immediately even when the worker is asleep. (Distinct from Review's per-Document `Sample` clips.)

- **P1.** Contract (`Voice.previewUrl`, `MissingVoicePreviews`), migration `0009_voice_previews.sql`, worker routes (`GET /api/worker/voices/missing-previews`, `PUT /api/worker/voices/:id/preview`), public media route (`GET`/`HEAD` `/voice-previews/:id`), and `fama previews` generator in `worker/`.
- **P2.** Inline ▶ / ⏹ preview button inside Web voice pickers (Add bar and Narrate Again).
- **P3.** Inline ▶ / ⏹ preview button on every voice row in iPhone Add and Narrate Again pickers.

### O. Library Organization, Progress & Search

Turns the flat chronological library into an organized daily listening inbox. Tags and folders wait for a later wave.

- **O1.** Contract (`Episode.archivedAt`, `UpdateEpisode`), migration `0008_organize.sql`, `PATCH /api/episodes/:id` to archive/unarchive and rename title/author; private RSS feed omits archived episodes. Mark Played/Unplayed reuses `PUT /api/episodes/:id/progress`.
- **O2.** Web library: row progress bars + remaining time/Played indicator + author subtitle, instant search, status filters (`Inbox` / `Listening` / `Finished` / `Archived`), sort (`Recently played`, `Newest`, `Shortest`), and row actions (Archive, Mark Played/Unplayed, Edit Title/Author).
- **O3.** iPhone library: matching row progress indicator + author subtitle, native search, status filters, sort menu, and swipe/context actions.

### T. Sleep Timer

100% client-side sleep timer with presets (`15m`, `30m`, `45m`, `60m`, `End of chapter`, `+5m`, `Off`) and a live countdown badge in the player.

- **T1.** Web sleep timer in `apps/web/src/playback/sleepTimer.ts` with 3 s volume fade-out before pausing.
- **T2.** iPhone sleep timer in `apps/mobile/src/player/sleepTimer.ts` and native `ActionSheetIOS` picker in `apps/mobile/src/app/player.tsx`.

### Q. Player & Read-Along Polish

- **Q1.** Web keyboard shortcuts (`[`/`]` speed, `R` Read-along, `/` search, `?` help) + chapter boundary tick marks and hover timestamp/chapter tooltip on the web scrubber.
- **Q2.** iPhone seamless offline hot-swap (rebuilding `EpisodePlayer`'s active `AVQueuePlayer` onto local `file://` URLs at the exact current position when a download completes) + Read-along "Back to now" button when scrolled away from the active sentence.

## Files

A unit may edit the files in its row. Other files get connecting lines only (rule 3).

| Unit | Its own files | Migration |
|---|---|---|
| O1 | `packages/contracts/src/organize.ts`, `apps/api/src/episode-organize.ts`, `apps/api/src/routes/organize.ts`, `apps/api/src/routes/organize.test.ts` | `0008_organize.sql` |
| O2 | `apps/web/src/core/libraryFilter.ts`, `apps/web/src/view/library.ts` | |
| O3 | `apps/mobile/src/lib/libraryFilter.ts`, `apps/mobile/src/app/(tabs)/library/index.tsx` | |
| P1 | `packages/contracts/src/voice-preview.ts`, `apps/api/src/voice-preview-repo.ts`, `apps/api/src/routes/voice-preview.ts`, `apps/api/src/routes/voice-preview.test.ts`, `worker/src/fama_worker/previews.py`, `worker/tests/test_previews.py` | `0009_voice_previews.sql` |
| P2 | `apps/web/src/ui/Picker.ts`, `apps/web/src/playback/voicePreview.ts` | |
| P3 | `apps/mobile/src/player/voicePreview.ts`, `apps/mobile/src/components/VoicePicker.tsx` | |
| Q1 | `apps/web/src/view/playerBar.ts`, `apps/web/src/subscription.ts` | |
| Q2 | `apps/mobile/modules/fama-player/ios/EpisodePlayer.swift`, `apps/mobile/src/player/core.ts`, `apps/mobile/src/reader/Reader.tsx` | |
| T1 | `apps/web/src/playback/sleepTimer.ts`, `apps/web/src/playback/sleepTimer.test.ts` | |
| T2 | `apps/mobile/src/player/sleepTimer.ts`, `apps/mobile/src/player/sleepTimer.test.ts`, `apps/mobile/src/app/player.tsx` | |
| X3 | `worker/.../extract/`, `worker/.../normalize.py` | |


## Open choices

Each has a default. A unit follows the default unless the owner says no.

1. **Read-along narrates one sentence for each call.** Decided by measurement on 2026-11-24 (Apple M5 Pro, median of 7 runs, a new process for each run, `worker/BAKEOFF.md`). The limit was 20% slower narration with the same sound.
   - Kokoro (`af_heart`, MPS): 31.0x real time packed and 26.6x by sentence on article prose, 14% slower. On fiction 31.0x and 27.4x, 12% slower. The limiter is a fixed cost of 90 to 120 ms for each call, so text with many short sentences in long paragraphs costs most (about 20%, computed).
   - Piper (`is_IS-steinn-medium`, CPU): 69.7x and 69.5x, no measurable difference. Piper already synthesizes each sentence alone.
   - Both engines use one call for each sentence. No engine needed the other path (sentence times from the engine's own word timestamps), which Kokoro has for English voices only.
   - Sound: the pause between sentences is as before, because a Segment that continues a paragraph drops the silence its call opens with. The owner should still listen: `~/Developer/fama-samples/read-along/`.
2. **Review is for all sources, off by default.** The old roadmap said files only.
3. **Apps show Samples in Review.** The API can make Samples for any Episode with a stored Document.
4. **Unticked chapters are removed at Start.** You cannot tick them again later.
5. **Narrate again also covers a new voice and a new speed.** The old roadmap had only edited text.

## Already in Fama

- M4B book file with chapters, title, author and cover.
- The stored Document (unit `F`). The worker uploads the Document after extraction, and each later attempt narrates from the stored one. The shape and the routes are in `docs/api.md` ("Document"). The rule that no unit may break: audio chapter `i` narrates Document chapter `i`. A new route file builds on `apps/api/src/routes/kit.ts`, and its tests on `apps/api/src/test-app.ts`.
- Chapter 1 plays while the worker narrates the other chapters.
- Read-along on the web and the iPhone: the text of the episode, with the sentence that plays marked. A click or tap on a sentence moves playback to it.
- A WebVTT transcript of each episode in the private feed.
- The time left while an episode is narrated.
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

- Measure the GPU cost per hour of audio on Modal. The price depends on it.
- Design: [design/two-paths.md](design/two-paths.md).
