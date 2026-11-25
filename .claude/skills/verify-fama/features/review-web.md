# Web review

Turn on Review in the add bar to inspect extracted chapters before narration starts. Untick chapters, edit the title or text, remove repeated header lines, and start narration with only the kept chapters.

## Sub-features

- Toggle the `Review` switch in the add bar (off by default) for links, text, and files.
- Open an episode waiting in `Review` from its Library row (`Review <title>`).
- Untick chapters (the Start button shows the kept count), expand one chapter at a time to edit its title or text, and remove any header line that repeats across chapters in one click.
- Save edits in place (`PUT /api/episodes/:id/document`) or Start narration (`POST /api/episodes/:id/start`) with only the kept chapters in playback order, returning to the Library while the worker narrates.

## How to get to it (user POV)

Turn on `Review` in the add bar, attach `harbour-year.epub`, and click `Add`. When extraction finishes, click `Review Harbour Year` in the Library. Untick a chapter, expand another chapter to edit a sentence, and click `Start · 3 of 4 chapters`.

## Driving it with preview tools and agent-device

1. Start the local verification stack with `fama-verify up` and check `fama-verify doctor`. Open a T3 preview tab on the verification API port and sign in with `dev-api-token` if Settings opens.
2. Click `role=switch[name="Review"]` and confirm `aria-checked="true"`. Upload `.claude/skills/verify-fama/fixtures/harbour-year.epub` into `#file-input` and click `role=button[name="Add"]`.
3. Wait for `role=button[name="Review Harbour Year"]` in the Library row. Capture a screenshot and confirm `GET /api/episodes` shows `job._tag === "Review"`.
4. Click `role=button[name="Review Harbour Year"]`. Wait for `role=button[name="Start · 4 chapters"]`.
5. Untick one chapter via `role=checkbox[name="Keep Autumn"]` and confirm the Start button reads `Start · 3 of 4 chapters`.
6. Expand a kept chapter (`role=button[name="2 Summer"]`), edit a sentence in `role=textbox[name="Text of Summer"]`, and capture screenshots at 1280 px and 390 px width.
7. Click `role=button[name="Start · 3 of 4 chapters"]`. Confirm the view returns to the Library and the episode moves out of `Review`.
8. Run `fama-verify wait <episodeId>`. Read `GET /api/episodes/<episodeId>` and verify `job._tag === "Ready"` with 3 chapters (`Spring`, `Summer`, `Winter`). Fetch `Summer`'s `timingUrl` and confirm its segments contain the edited sentence.
9. Close the preview tab and stop the stack with `fama-verify down`.

## Gotchas

- `harbour-year.epub` narrates for about a minute after Start; give `fama-verify wait` enough time (up to 180 s).
- Unticked chapters are dropped at Start and cannot be restored afterward; `Save` preserves all chapters while the job stays in `Review`.
- Only one chapter's text editor is mounted at a time so large books stay fast; clicking another chapter closes the previous editor.
