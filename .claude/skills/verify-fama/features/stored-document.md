# Stored Document

The worker extracts a source one time. It uploads the result, the Document (title, author, language, chapters with their text), and the API stores it with the episode. Each later attempt at the job narrates from the stored Document. So when a job fails after extraction and the user chooses `Retry`, the worker does not download and extract the source again, and the book file keeps its cover. No screen shows the Document yet. The proof is the client route, the worker log and the API log.

## Sub-features

- `document-store` stores the Document after the first extraction. `GET /api/episodes/:id/document` returns `{ title, author, language, chapters: [{ title, text }] }`.
- `document-chapters` keeps the order: audio chapter `i` of the episode narrates Document chapter `i`, with the same title.
- `document-retry` narrates a retried job from the stored Document. The worker log has one `extracted the source` line and one `read the stored Document` line for the episode.
- `document-cover` reads the stored cover back on a retry, so the book file has the cover.
- `document-private` gives another user `404`, a client token `401` on the worker routes, and a wrong lease token `409`.
- `document-delete` deletes the Document with the episode.

## How to get to it (user POV)

- Add any source that the worker can extract (see [Add a file](./add-file.md) and [Add a link](./add-link.md)). The Document exists as soon as the row leaves `Reading`.
- When a job fails after extraction, choose `Retry` on the row (web or iPhone).

## Driving it with preview tools and agent-device

Preconditions:

- Baseline from `README.md`, with one more variable set before `fama-verify up`: `export FAMA_CACHE_DIR="$STATE/chunk-cache"`, where `$STATE` is the state dir (`$TMPDIR/fama-verify`, or `FAMA_VERIFY_STATE`). The worker then keeps its chunk cache there, and the steps below can break it.
- This feature has no screen. Add the episodes on the web as in [Add a file](./add-file.md), or with `fama-verify api POST /api/episodes/upload -F "file=@<fixture>;type=<mime>"`.

- **Store.** Add `harbour-days.epub`. Run `fama-verify wait <id>`: it starts with `Ready` and lists chapters `Morning` and `Evening`. Run `fama-verify api GET /api/episodes/<id>/document`. The answer has exactly the keys `title`, `author`, `language`, `chapters`: title `Harbour Days`, author `Fama Fixtures`, language `en`, and chapters `Morning` and `Evening` in the same order as the audio chapters, each with its text.
- **Fail after extraction.** Break the chunk cache: `mv "$STATE/chunk-cache" "$STATE/chunk-cache.ok" && touch "$STATE/chunk-cache"`. Add `harbour-notes.pdf`. `fama-verify wait <id>` starts with `Failed`, with the reason `NotADirectoryError: ...chunk-cache/...`, the real title `Harbour Notes` and no chapters. `GET /api/episodes/<id>/document` already returns chapters `Part One` and `Part Two`. Save the answer.
- **Retry.** Repair the cache: `rm "$STATE/chunk-cache" && mv "$STATE/chunk-cache.ok" "$STATE/chunk-cache"`. Choose `Retry` on the row, or run `fama-verify api POST /api/episodes/<id>/retry`. `fama-verify wait <id>` starts with `Ready`, with chapters `Part One` and `Part Two`. The Document is byte for byte the saved answer (`cmp`).
- **No second extraction.** Run `grep <id> "$STATE/worker.log"`. The lines are, in order: `claimed`, `extracted the source, stored the Document (2 chapters)`, `failed: NotADirectoryError...`, `claimed`, `read the stored Document (2 chapters), no extraction`, `uploaded chapter 0`, `uploaded chapter 1`, `ready`. `grep <id> "$STATE/api.log"` has one `GET /api/worker/jobs/<id>/source`, one `PUT /api/worker/jobs/<id>/document`, and after the `retry` one `GET /api/worker/jobs/<id>/document`.
- **Same audio.** Add the same fixture again with the cache in order. Its chapter durations in `fama-verify wait` equal the durations of the retried episode.
- **Cover.** No fixture has a cover. Make an EPUB with one: copy `harbour-days.epub`, add a PNG as `OEBPS/cover.png`, and add `<item id="img" href="cover.png" media-type="image/png" properties="cover-image"/>` to the manifest. Run the fail and retry steps with it. The API log has one `PUT .../cover`, and after the retry one `GET /api/worker/jobs/<id>/cover`. Download the book file and run `ffprobe -show_entries stream=codec_name:stream_disposition=attached_pic -of compact <book.m4b>`: one stream is `png` with `attached_pic=1`.
- **Proof.** Save the `wait` lines, the Document answers, and the `grep` output of both logs to `$EVIDENCE/stored-document/`.

## Gotchas

- The broken cache fails the job at the first synthesized chunk, which is after extraction. The worker reads `FAMA_CACHE_DIR` for each job, so the repair needs no worker restart. Without `FAMA_CACHE_DIR`, the cache is `~/.cache/fama/chunks`, which other runs share: do not break that one.
- A job that fails in extraction (for example `missing.html`) has no Document. Its retry extracts again, and `GET /api/episodes/<id>/document` gets `404` with error `NotStored`.
- A short fixture can leave `Reading` before the first read, so a `404` for the Document of a new episode is hard to catch. The API tests prove it (`apps/api/src/routes/document.test.ts`).
- `document-private` and `document-delete` are proven by the API tests, and the retry with a cover also by the worker tests (`worker/tests/test_stored_document.py`).
- When other runs use the default ports, set `FAMA_VERIFY_API_PORT`, `FAMA_VERIFY_FIXTURE_PORT` and `FAMA_VERIFY_STATE` for every `fama-verify` call.
