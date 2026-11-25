# Review on iPhone

Turn on Review when adding a Source. The Episode waits after extraction. Choose the chapters to narrate and correct their text before Start. Since S3, Review also plays each Voice sample and starts narration with the Voice picked by ear.

## Sub-features

- Link, Text and File share the Review switch. It starts off.
- Save stores chapter text and keeps every chapter. Start drops unticked chapters.
- Remove repeated header removes an identical first line from every chapter after confirmation.
- Delete is available in Review.
- Voice samples: opening Review asks for every registered Voice of the Document's language, polls while clips are made, and lists them under "VOICE SAMPLES". Play/Pause plays one clip at a time through the local FamaPlayer module; the selection (a check mark, initialized from the Episode's Voice) passes to Start, so the Ready Episode narrates with the chosen Voice.

## How to get to it (user POV)

In Add, choose File, attach the EPUB, turn on Review and tap Create. In the Library, tap the Episode when its row shows Review. Tap a check mark to change the selection. Tap a chapter title to edit its text. Save, then tap Start with the chapter count. To choose a Voice, tap Play on a sample row, listen, tap another row's name to select it, then tap Start.

## Driving it with preview tools and agent-device

1. Export `FAMA_VERIFY_API_PORT=8911 FAMA_VERIFY_FIXTURE_PORT=8912 FAMA_VERIFY_STATE=/tmp/fama-verify-v3`. Run `fama-verify up` and `fama-verify doctor`. Start this checkout's Metro on port 8885.
2. Open the iPhone 18 Pro with the T3 device tool. Use its agent-device command to open `dev.fama.app --relaunch --metro-port 8885`. Check the Review switch in Add. Record the Server URL in Settings. Set it to `http://localhost:8911`, save and check for Connected.
3. Use the Files procedure in [Add a file](./add-file.md) to attach `harbour-year.epub`. Turn on Review, save the Add screenshot and tap Create.
4. Tap the Library row `Review Harbour Year`. Untick Winter. Save the list screenshot with Start showing three chapters.
5. Open Edit Spring. Change the first sentence to “The red lantern shines across the harbour.” Keep the rest. Save an editor screenshot and tap Save.
6. Tap Start. Check the return to Library. Use `fama-verify api GET /api/episodes` to find the ID, then `fama-verify wait <id>`. The Ready Episode has Spring, Summer and Autumn at indexes 0 through 2. Open the Episode and capture the result.
7. Read the Episode with `fama-verify api GET /api/episodes/<id>`. Pass its first chapter's timingUrl to `fama-verify api GET`. Check the changed sentence in the Segments.
8. Restore the previous Server URL and save. Remove any fixture you copied. Stop this Metro, close the device and run `fama-verify down`.

## Voice samples (S3, iPhone 18 Pro, 2026-11-25)

Isolated stack: `FAMA_VERIFY_API_PORT=8951 FAMA_VERIFY_FIXTURE_PORT=8952 FAMA_VERIFY_STATE=/tmp/fama-verify-s3`, Metro on 8082, evidence `verify/20261125-205131/s3-iphone/`. Proven with `grein.html` (Icelandic, four piper voices).

1. In Add, `fill 'value="https://"' "http://localhost:8952/grein.html"` (the Link cell and the field share the label `Link`; `fill` by value or ref). Tap the Review switch by ref: `label="Review"` matches the switch and its text. Save the Add screenshot, tap Create.
2. Tap the Library row `Review <title>` (the row's name is `Review <title>`, not the title). The Review screen opens and shows `VOICE SAMPLES` with one row per Voice: buttons `Play sample, <name>`, `Choose <name>` (the Episode's current Voice starts `[selected]`), and `Retry sample, <name>` on a Failed clip.
3. Play proves itself by the button flip: `Play sample, Steinn` becomes `Pause sample, Steinn` (the native `onSampleStatus` event). Playing `Salka` flips Steinn back to Play: one clip at a time. Pause, then tap `Choose Salka`.
4. Tap `Start · <n> chapters`. `fama-verify api GET /api/episodes/<id>` after `wait` must show the chosen Voice (for this run `piper:is_IS-salka-medium`).
5. Save `GET /api/episodes/<id>/samples`, `curl -H 'Range: bytes=0-31'` one clip URL (206, AAC) and `ffprobe` it (5 to 40 s). Play the Ready Episode: two elapsed reads a few seconds apart prove the episode player still works after sample playback.
6. Cleanup as above. The dev client needs a rebuild when `modules/fama-player` changes (see `apps/mobile/README.md`).

## Gotchas

Use the switch ref from the snapshot if its text label also matches. The picker may open in Recents. Browse to On My iPhone. Save edits before leaving the editor. A new visit to Review selects all chapters until Start commits the selection.

For voice samples: the dev client must contain the `playSample`/`pauseSample`/`stopSample` native calls, so reinstall the app after any change to the Swift module. Sample playback pauses narration, like a navigation prompt. `fill` by value or ref for the Link field, whose label matches the Link cell.
