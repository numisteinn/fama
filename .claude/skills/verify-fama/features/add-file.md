# Add a file

A user attaches a PDF, EPUB, Markdown, plain text or HTML file. Fama uploads it, and the worker splits it into chapters by the table of contents (EPUB nav, PDF outline), skips front matter and licence pages, takes the title and author from the file's metadata, and narrates each chapter.

## Sub-features

- `file-web-pick` attaches a file with `Attach file` on the web.
- `file-web-drop` attaches a file by dropping it on the page (overlay `Drop to add`).
- `file-ios-pick` picks a file with `Choose file` on the iPhone (document picker).
- `file-ios-share` shares a PDF or EPUB to Fama from another app.
- `file-epub` makes one chapter for each nav entry, with the book's title and author.
- `file-pdf` makes one chapter for each outline entry, without running headers and page numbers.
- `file-remove` removes an attached file before submit (`Remove file`).

## How to get to it (user POV)

- Web: choose `Attach file` (or drop a file on the page), check the file name in the add bar, then choose `Add`.
- iPhone: tab `Add`, mode `File`, `Choose file`, pick the file in the document picker, then `Create`.
- iPhone: share a file from Files or Books to `Fama`, then `Add` in the confirm sheet.

## Driving it with preview tools and agent-device

Preconditions:

- Baseline from `README.md`.
- Fixtures exist in `.claude/skills/verify-fama/fixtures/`: `harbour-days.epub`, `harbour-notes.pdf`, `harbour.md`.
- iPhone only: the fixture file is in the simulator's Files app. Nothing in this skill puts it there yet. See Gotchas.

- **Web, attach.** Run `preview_act {action: "upload", selector: "input[type=file]", paths: ["<repo>/.claude/skills/verify-fama/fixtures/harbour-days.epub"]}`. The add bar shows `harbour-days.epub` and button `Remove file`. Button `Add` is enabled.
- **Web, remove.** Choose `Remove file`. The textbox `Link or text` returns and `Add` is disabled. Attach the file again.
- **Web, submit.** Choose `Add`. The preview network log has `POST /api/episodes/upload` with status 201. A row with status `Queued` appears.
- **EPUB chapters.** Run `preview_wait_for {locator: 'role=button[name="Play Harbour Days"]', timeoutMs: 60000}`, then `fama-verify wait <id>`. The output starts with `Ready`, with title `Harbour Days`, chapters `Morning` and `Evening` in that order, and a `bookUrl`.
- **PDF chapters.** Upload `harbour-notes.pdf` the same way. `fama-verify wait <id>` shows title `Harbour Notes` and chapters `Part One` and `Part Two`.
- **Markdown.** Upload `harbour.md`. `fama-verify wait <id>` shows title `Harbour Note` and one chapter.
- **iPhone, pick.** Run `$AD press 'label="Add"'`, `$AD press 'label="File"'`, `$AD press 'label="Choose file"'`, pick `harbour-days.epub` in the picker, check that the button now reads `File harbour-days.epub. Choose another`, then `$AD press 'label="Create"' --settle`. The app goes to `Library`, and `fama-verify wait <id>` shows the same chapters as on the web.
- **Proof.** Web: `preview_snapshot {save: true}` with the file attached and again with the ready row, copied to `$EVIDENCE/file-web/`. Save each `wait` line to `$EVIDENCE/file-web/<fixture>.txt`.

## Gotchas

- The web `<input type=file>` is hidden and has no accessible name. Target it with the selector `input[type=file]`, not with the `Attach file` button. The button opens a native picker that the preview tools cannot answer.
- `Attach file` is a `<label for="file-input">` with role `button`, so the browser opens the picker inside the click (Safari refuses a picker opened later). Enter and Space open it too. Check it with `preview_evaluate`: the element with `aria-label="Attach file"` is a `LABEL` whose `htmlFor` is `file-input`.
- The worker drops EPUB chapters under 40 words and treats a short first section as front matter. A fixture with tiny chapters loses them. `make-fixtures.py` keeps each chapter long enough.
- The upload limit is 100 MB, and the API reads the whole upload into memory.
- `file-ios-pick` needs the fixture in the simulator's Files app first. `agent-device` cannot add files, and `simctl addmedia` only adds photos and videos. Until a way to seed Files is written down here, report `file-ios-pick` and `file-ios-share` as not driven, with this precondition as the reason.
