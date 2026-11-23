# Roadmap

Features we plan to add. Most come from two similar projects, [abogen](https://github.com/denizsafak/abogen) and [pdf-narrator](https://github.com/mateogon/pdf-narrator). Both have open licenses, so read their code before you build the same feature.

When a feature ships, remove it from this file and add its recipe to `.claude/skills/verify-fama/features/`.

## Next

Do these in this order.

### 1. Read-along text

The app highlights the current sentence while the audio plays. A tap on a sentence moves playback to it.

- The worker narrates one chunk at a time and knows the duration of each chunk. Sentence timing costs nothing extra, for Kokoro and for Piper.
- The worker uploads one timing file for each chapter, next to the chapter audio.
- The web app and the iPhone app show the text and follow the audio.
- The feed can also give the text as a transcript (the `podcast:transcript` tag).
- Seen in: abogen (subtitles and sentence highlighting), pdf-narrator (its Cadence reader).

### 2. Voice sample from your own document

Before you choose a voice, you hear each voice read a paragraph from your document.

- This matters most for Icelandic, because you must choose between Piper voices.
- The worker needs a short job type for samples.
- Seen in: both.

### 3. Check chapters before narration (files only)

After extraction, the user can untick chapters, correct their text, and remove a header that repeats on each PDF page. Then narration starts.

- This step is optional, and it is for files only. A link stays one tap.
- Today the worker extracts and narrates in one step, so this adds a new job state.
- Seen in: pdf-narrator.

### 4. Narrate one chapter again

When you edit a chapter's text, the worker narrates only that chapter again and builds the book file again.

- This depends on 3. The chapter cache and the chapter uploads already exist.
- Seen in: pdf-narrator.

## Small fixes

You can do these at any time.

- **Remove repeated PDF page headers and footers.** Today the narration reads the running header on each page. `extract/pdf.py` has no rule for it.
- **Remove Project Gutenberg license text.** `extract/common.py` skips the cover, copyright and contents pages, but it has no Gutenberg rule.
- **Show the time left while an episode is narrated.** Today the row shows `Narrating n/m` only. The worker knows its narration speed and can send an estimate.

## Later

- **OCR for scanned PDFs.** A scanned PDF has no text to extract. On the Mac, Apple Vision OCR works offline. Check its Icelandic support first. Seen in: abogen (on its roadmap).
- **LLM pass to fix text, for Icelandic only.** This can fix Icelandic numbers ("3 bækur" must be read as "þrjár bækur"), which the rules in `normalize.py` do not handle. Make it optional, with a local model or an API model. Seen in: abogen.
- **Add many files at once, or a folder.** The job queue already handles many jobs. Only the add bar and the Add screen change. Seen in: both.

## Already in Fama

- M4B book file with chapters, title, author and cover.
- Chapter 1 plays while the worker narrates the other chapters.
- After a stop, a job continues and keeps its finished chapters.
- Each job keeps its own voice and narration speed.
- Chapters come from Markdown headings in text.
- Cover, copyright and contents pages are skipped.

## Not planned

- **Mix Kokoro voices.** Kokoro has no Icelandic voices, and this feature brings little value for a single user.
- **Send to Audiobookshelf.** The private feed already does this job.
- **Export MP3 for each chapter, or WAV, FLAC or Opus.** The apps and the feed play the M4B, and `Download` gives you the file.
- **Narrate subtitle files or text with timestamps.** These are for video voiceovers, not for listening.
- **GPU or CPU choice, offline model download.** The worker manages these by itself.

## Before charging for a managed service

- Replace PyMuPDF (AGPL) or change the license. `pypdfium2` is the candidate.
- Measure the GPU cost per hour of audio on Modal. The price depends on it.
- Design: [design/two-paths.md](design/two-paths.md).
