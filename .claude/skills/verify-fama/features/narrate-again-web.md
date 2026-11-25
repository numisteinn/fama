# Narrate again on the web

A Ready or Failed Episode has a Narrate again action in its Library row. The owner can edit Chapter text or change the Voice and speed. Each submit queues narration, closes the editor, and refreshes the Library. The audio player and Read-along reader load replacement media URLs without a reload.

## Sub-features

- Edit Chapter text only. Document metadata, Chapter titles, count, and order stay fixed.
- Submit text with **Narrate chapter edits**. Submit Voice and speed separately with **Change voice & speed**. The two routes never run together, so the second cannot get an unexpected `409 NotEditable`.
- A legacy Episode with no stored Document says so and still allows Voice and speed edits.
- Only a changed Chapter gets new audio and timing URLs after a text edit. A Voice or speed change replaces every Chapter.
- An open audio player loads a replacement Chapter URL at the same position. An open reader fetches a replacement timing URL and shows its new text.

## How to get to it (user POV)

Add a file and wait until its Episode is Ready. Click **Narrate again &lt;title&gt;** in its Library row. Expand a Chapter to edit its text, or use the Voice and Speed controls. Use the submit button for the one change you want. The app returns to the Library with the Job queued. To keep the reader open behind the editor, start playback before opening Narrate again, then click **Text** in the player bar.

## Driving it with preview tools and agent-device

Use isolated ports and save all artifacts under `$EVIDENCE/narrate-again-web/`.

```sh
export FAMA_VERIFY_API_PORT=8961 FAMA_VERIFY_FIXTURE_PORT=8962 FAMA_VERIFY_STATE=/tmp/fama-verify-n2
verify=.claude/skills/verify-fama/scripts/fama-verify
"$verify" up
"$verify" doctor
```

1. Open a new preview tab on port 8961. Save `dev-api-token` in Settings. Through the add bar, upload `harbour-days.epub` with `preview_act` action `upload` on `input[type=file]`, then click **Add**. Save the Episode JSON before edits and wait for Ready with `fama-verify wait`.
2. Click **Narrate again Harbour Days**. Expand **2 Evening**, append `Orange lanterns guide the last ship home.`, and capture the editor before and after the edit. Click **Narrate chapter edits**. Wait for the Library row to return, then for Ready. Compare the before and after Episode JSON: Chapter 0 keeps its audio and timing URLs; Chapter 1 gets new ones.
3. Start playback. Open Narrate again again, then click **Text** in the player bar so the reader stays open behind the editor. Select another registered Voice and speed `1.3×`. Click **Change voice & speed**. Wait for `#reader` to show and for Ready. Check that the reader contains the edited sentence and that the browser resource list contains the new timing URLs and the current Chapter's new audio URL.
4. Save the final Episode JSON. Fetch a current Chapter with `Range: bytes=0-`, expect `206`, read its duration with `ffprobe`, and fetch its timing JSON to check the edited sentence. Close the preview tab and run `fama-verify down`.

## Gotchas

- A fresh browser profile fetches Voices at boot before it has a token. After saving the first token, reload once if the Voice list is empty.
- The editor offers no title input, Chapter-title input, checkbox, or remove action. Send the full stored Document with only Chapter text changed.
- A `404` Document response opens the Voice editor with a not-stored message. Other fetch failures show **Try again**.
- Compare resource URLs from the final Episode JSON. The old media URLs can remain readable after replacements arrive.
