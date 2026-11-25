# Narrate again on iPhone

Open Narrate again for any Ready or Failed Episode to edit chapter text or choose a different voice and narration speed. Each submission queues a new narration job and returns to the Library, and replaced chapters reload their audio, download state, and Read along text.

## Sub-features

- Reach Narrate again from `Edit <title>` on a Ready or Failed Library row, or from `Narrate again` in the Player.
- Edit one or more chapters' text while keeping Document metadata, chapter count, and chapter titles read-only, then queue narration with `Save chapter text`. Leaving with unsaved text edits asks before discarding them.
- Pick a registered voice and narration speed (`0.75×` to `1.5×`) and queue narration with `Apply voice & speed` as a separate action so two writes never collide on `409 NotEditable`.
- Missing stored Documents (`404`) explain that chapter text is unavailable while keeping Voice & speed active.
- Re-narrated chapters with new `url` and `timingUrl` values invalidate downloaded chapter files, prune stale revisions on library load, and reload the Reader text.

## How to get to it (user POV)

In Library, tap `Edit <title>` beside a Ready or Failed Episode, or open the Episode in the Player and tap the pencil (`Narrate again`) button. Tap a chapter row to edit its text, tap `Done`, and tap `Save chapter text`; or choose a new `Voice` or `Speed` and tap `Apply voice & speed`.

## Driving it with preview tools and agent-device

1. Export isolated ports (`FAMA_VERIFY_API_PORT=8971 FAMA_VERIFY_FIXTURE_PORT=8972 FAMA_VERIFY_STATE=/tmp/fama-verify-n3`), run `fama-verify up` and `fama-verify doctor`, and start Metro on an unused port (for example `8083`).
2. Open the simulator with `device_open` and launch `dev.fama.app --relaunch --metro-port 8083` via its `agent-device` command. Record the current `Server URL` in `Settings`, change it to `http://localhost:8971`, tap `Save`, and confirm `Connected`.
3. In `Add`, submit `http://localhost:8972/article.html` (`The Quiet Harbour`) and run `fama-verify wait <id>`. Save the initial Episode JSON and capture `Library` showing `Edit The Quiet Harbour`.
4. Open `The Quiet Harbour`, pause playback, tap `Download` until `Downloaded`, and open `Read along` to prime both local downloads and the Reader. Capture the initial Reader screenshot.
5. Tap `Narrate again` in the Player (and check `Edit The Quiet Harbour` from Library). Open `Edit The Quiet Harbour`, focus `Chapter text`, append `" Red lanterns guide the last boat home. "` with `type`, tap `Done`, and capture the `Edited` badge. Tap Back (or swipe back) to confirm the `Discard unsaved text edits?` alert appears, choose `Keep editing`, then tap `Save chapter text` and confirm the screen dismisses back to `Library`.
6. Confirm navigation back to `Library`, run `fama-verify wait <id>`, and compare the Episode JSON to verify new `url`, `timingUrl`, and `bookUrl` values. Reopen `The Quiet Harbour` in the Player, check that `Downloaded` reverted to `Download`, and open `Read along` to confirm the updated sentence is shown.
7. Open `Narrate again`, choose another voice (for example `Bella (US) · en`) and speed (`1.25×`), capture the screen, and tap `Apply voice & speed`. Run `fama-verify wait <id>` and verify the updated `voice`, `speed`, shorter `durationMs`, and `206` Range response on `bookUrl`.
8. Restore the recorded `Server URL` in `Settings` and tap `Save`, stop Metro, call `device_close` without shutdown, and run `fama-verify down`.

## Gotchas

- Never use `fill` on iOS text inputs; focus with `press` and append with `type` or delete characters with `press 'label="delete"' --count <n>`.
- Both `PUT /api/episodes/:id/document` and `PUT /api/episodes/:id/voice` immediately move the Episode to `Queued`, so text edits and voice/speed changes are submitted as separate actions on separate `Ready`/`Failed` states.
- In `Settings`, the `Server URL` field exposes its current value in `snapshot -i`; target its `@eN` ref from the latest snapshot when restoring the URL.
