# Review on iPhone

Turn on Review when adding a Source. The Episode waits after extraction. Choose the chapters to narrate and correct their text before Start.

## Sub-features

- Link, Text and File share the Review switch. It starts off.
- Save stores chapter text and keeps every chapter. Start drops unticked chapters.
- Remove repeated header removes an identical first line from every chapter after confirmation.
- Delete is available in Review.

## How to get to it (user POV)

In Add, choose File, attach the EPUB, turn on Review and tap Create. In the Library, tap the Episode when its row shows Review. Tap a check mark to change the selection. Tap a chapter title to edit its text. Save, then tap Start with the chapter count.

## Driving it with preview tools and agent-device

1. Export `FAMA_VERIFY_API_PORT=8911 FAMA_VERIFY_FIXTURE_PORT=8912 FAMA_VERIFY_STATE=/tmp/fama-verify-v3`. Run `fama-verify up` and `fama-verify doctor`. Start this checkout's Metro on port 8885.
2. Open the iPhone 18 Pro with the T3 device tool. Use its agent-device command to open `dev.fama.app --relaunch --metro-port 8885`. Check the Review switch in Add. Record the Server URL in Settings. Set it to `http://localhost:8911`, save and check for Connected.
3. Use the Files procedure in [Add a file](./add-file.md) to attach `harbour-year.epub`. Turn on Review, save the Add screenshot and tap Create.
4. Tap the Library row `Review Harbour Year`. Untick Winter. Save the list screenshot with Start showing three chapters.
5. Open Edit Spring. Change the first sentence to “The red lantern shines across the harbour.” Keep the rest. Save an editor screenshot and tap Save.
6. Tap Start. Check the return to Library. Use `fama-verify api GET /api/episodes` to find the ID, then `fama-verify wait <id>`. The Ready Episode has Spring, Summer and Autumn at indexes 0 through 2. Open the Episode and capture the result.
7. Read the Episode with `fama-verify api GET /api/episodes/<id>`. Pass its first chapter's timingUrl to `fama-verify api GET`. Check the changed sentence in the Segments.
8. Restore the previous Server URL and save. Remove any fixture you copied. Stop this Metro, close the device and run `fama-verify down`.

## Gotchas

Use the switch ref from the snapshot if its text label also matches. The picker may open in Recents. Browse to On My iPhone. Save edits before leaving the editor. A new visit to Review selects all chapters until Start commits the selection.
