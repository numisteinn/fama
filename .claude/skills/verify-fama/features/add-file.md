# Add a file

A user attaches one or many PDF, EPUB, Markdown, plain text or HTML files, or drops a folder of them on the web. Each file is one upload and one episode, sent one at a time with the voice and speed chosen at Add. A failed file keeps its reason and a Retry button. A file of another type is named with `Unsupported type` and never sent. For each file Fama uploads it, and the worker splits it into chapters by the table of contents (EPUB nav, PDF outline), skips front matter and licence pages, takes the title and author from the file's metadata, and narrates each chapter.

## Sub-features

- `file-web-pick` attaches one or many files with `Attach file` on the web.
- `file-web-drop` attaches files by dropping them on the page (overlay `Drop to add`).
- `file-web-folder` attaches the files of a dropped folder and its folders, by name, without hidden files.
- `file-batch-refused` names a file of another type with `Unsupported type` and sends the others.
- `file-batch-retry` keeps a failed file with its reason and sends it again with `Retry <name>`.
- `file-ios-pick` picks one or many files with `Choose files` on the iPhone (document picker).
- `file-ios-share` shares a PDF or EPUB to Fama from another app.
- `file-epub` makes one chapter for each nav entry, with the book's title and author.
- `file-pdf` makes one chapter for each outline entry, without running headers and page numbers.
- `file-remove` removes a file before submit, or a failed or refused file after (`Remove <name>`).

## How to get to it (user POV)

- Web: choose `Attach file` and pick files (or drop files or a folder on the page), check the file rows in the add bar, then choose `Add`.
- iPhone: tab `Add`, mode `File`, `Choose files`, tick the files in the document picker, `Open`, then `Create`. The app goes to `Library` when every file was sent.
- iPhone: share a file from Files or Books to `Fama`, then `Add` in the confirm sheet.

## Driving it with preview tools and agent-device

Preconditions:

- Baseline from `README.md`.
- Fixtures exist in `.claude/skills/verify-fama/fixtures/`: `harbour-days.epub`, `harbour-notes.pdf`, `harbour.md`.
- iPhone only: the fixture files are in the simulator's Files app. Copy them into `On My iPhone` (see Gotchas), and delete them in cleanup.

- **Web, attach many.** Run `preview_act {action: "upload", locator: "input[type=file]", paths: [<fixtures>/harbour-notes.pdf, <fixtures>/harbour-days.epub, <fixtures>/harbour.md]}`. The add bar shows one row for each file, each with button `Remove <name>`. Button `Add` is enabled.
- **Web, remove.** Choose `Remove harbour.md`. Its row goes. When the last row goes, the textbox `Link or text` returns. Attach the file again.
- **Web, submit.** Choose `Add`. The preview network log has one `POST /api/episodes/upload` with status 201 for each file, one after the other. The add bar empties and one row for each file appears in the library.
- **Web, refused type.** Attach `harbour.md`, a `cover.png` you made in the scratchpad, and `harbour-notes.pdf` in one upload. The `cover.png` row shows `role=alert` `Unsupported type`. Choose `Add`. Two `POST /api/episodes/upload` go, the `cover.png` row stays, and `Add` is disabled. `GET /api/episodes` has no `cover.png`.
- **Web, drop.** The preview tools cannot drop OS files. Dispatch a synthetic drop with `preview_evaluate`: build a `DataTransfer`, `items.add(new File([...], "dropped-one.md"))` for each file, then `window.dispatchEvent(new DragEvent("drop", {dataTransfer, bubbles: true, cancelable: true}))`. The add bar shows one row for each file.
- **EPUB chapters.** Run `preview_wait_for {locator: 'role=button[name="Play Harbour Days"]', timeoutMs: 60000}`, then `fama-verify wait <id>`. The output starts with `Ready`, with title `Harbour Days`, chapters `Morning` and `Evening` in that order, and a `bookUrl`.
- **PDF chapters.** Upload `harbour-notes.pdf` the same way. `fama-verify wait <id>` shows title `Harbour Notes` and chapters `Part One` and `Part Two`.
- **Markdown.** Upload `harbour.md`. `fama-verify wait <id>` shows title `Harbour Note` and one chapter.
- **iPhone, pick many.** Run `$AD press 'label="Add"'`, `$AD press 'label="File"'`, `$AD press 'label="Choose files"'`. In the picker choose `Browse` if it opens on `Recents`, then press the cells `harbour-days.epub, epub, …` and `harbour-notes, pdf, …` (the cell labels carry the time and size, so read them from `snapshot -i`). Each gets a tick. Press `Open` (see Gotchas). The Add screen shows `Remove harbour-days.epub` and `Remove harbour-notes.pdf`. `$AD press 'label="Create"'`. The app goes to `Library` with both episodes, and `fama-verify wait <id>` shows the same chapters as on the web.
- **Proof.** Web: `preview_snapshot {save: true}` with the files attached, with the ready rows, and with the refused row, copied to `$EVIDENCE/file-web-batch/`. iPhone: `$AD screenshot` of the ticked picker, the attached rows and the Library, in `$EVIDENCE/file-ios-batch/`. Save each `wait` line next to them.

## Gotchas

- The web `<input type=file>` is hidden, has no accessible name, and takes many files (`multiple`). Target it with the locator `input[type=file]`, not with the `Attach file` button. The button opens a native picker that the preview tools cannot answer.
- `Attach file` is a `<label for="file-input">` with role `button`, so the browser opens the picker inside the click (Safari refuses a picker opened later). Enter and Space open it too. Check it with `preview_evaluate`: the element with `aria-label="Attach file"` is a `LABEL` whose `htmlFor` is `file-input`.
- The worker drops EPUB chapters under 40 words and treats a short first section as front matter. A fixture with tiny chapters loses them. `make-fixtures.py` keeps each chapter long enough.
- The upload limit is 100 MB, and the API reads the whole upload into memory.
- Seed the simulator's Files app by copying files into its `On My iPhone` folder: `xcrun simctl get_app_container <udid> com.apple.DocumentsApp groups` prints the `group.com.apple.FileProvider.LocalStorage` path, and files copied into its `File Provider Storage/` folder show in the picker under `Browse`, `On My iPhone`. Delete them in cleanup.
- The Expo dev client's floating gear covers the right half of the picker's `Open` button. A press on `label="Open"` opens the Expo dev menu instead. Close the menu, then press the left part of `Open` by coordinates (about `330 100` on an iPhone 18 Pro).
- `file-web-folder` is not driven: a synthetic `DataTransfer` has no folder entries. A real folder drop in a browser is the only proof.
- If port 8081 belongs to the user's own Metro (for example `expo run:ios` from the main checkout), it serves the old code. Start Metro from your checkout on another port (`./node_modules/.bin/expo start --dev-client --port <port>` in `apps/mobile`), open the app with `--metro-port <port>`, stop it in cleanup, and say so in the report.
