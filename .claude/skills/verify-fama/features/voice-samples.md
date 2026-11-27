# Voice Samples

A Sample lets the User hear a Voice read the first body paragraph of their stored Document. Each Voice reads the same passage at the Episode’s speed. In web Review, the User can generate and play Samples for the Document’s language, compare voices by ear, and pick the narration Voice before starting.

## Sub-features

- Ask for all registered Voices of the Document’s language, or ask for specific Voices.
- List the Sample state and play Ready clips through private media URLs with byte ranges.
- Ask again while the Samples are Requested or Ready. The API creates no new work for those Samples.
- In web Review, list available voices for the Document's language (`role="radiogroup"` named `Voice`), highlight the current voice, request all language samples with `Hear voices`, show `Generating…`, `Play`/`Pause`, or failure reason + `Retry` per voice, play clips inline without colliding with main episode playback, persist the chosen voice (`PUT /api/episodes/:id/voice`) at app scope so leaving Review does not cancel the write, offer `Retry saving voice` if the voice write fails, and apply the chosen voice on `Start`.

## How to get to it (user POV)

On the web, turn on `Review` in the add bar and add a link or file (for example `grein.html`). When extraction stops in `Review`, open the episode, click `Hear voices` in the `Voice` section, listen to `Play <name> sample` clips as they become ready, select the preferred voice, and click `Start`.

Through the API directly, once an Episode has a stored Document, request Samples with `POST /api/episodes/:id/samples` and list them with `GET /api/episodes/:id/samples`. The iPhone app will expose this in Review in S3.

## Driving it with preview tools and agent-device

### Web Review (T3 preview tab)

1. Start an isolated stack (`FAMA_VERIFY_API_PORT=8941 FAMA_VERIFY_FIXTURE_PORT=8942 FAMA_VERIFY_STATE=/tmp/fama-verify-s2`), run `fama-verify up` and `fama-verify doctor`.
2. Open a T3 preview tab (`preview_open` with `target: {kind: "environment-port", port: 8941}`, `reuseExistingTab: false`) and sign in with `dev-api-token` if Settings opens.
3. Click `role=switch[name="Review"]`, enter `http://localhost:8942/grein.html` into `role=textbox[name="Link or text"]`, and click `role=button[name="Add"]`.
4. Wait for `role=button[name="Review Höfnin hljóða"]` and click it. Wait for `role=button[name="Hear voices"]` and confirm `role=radio[name="Steinn"]` is checked. Capture a before screenshot.
5. Click `role=button[name="Hear voices"]`. Confirm `Generating…` indicators appear while polling `GET /api/episodes/:id/samples`, then wait for all four voices (`Búi`, `Salka`, `Steinn`, `Ugla`) to show `Play <name> sample`.
6. Click `role=button[name="Play Salka sample"]`. Confirm it switches to `role=button[name="Pause Salka sample"]`, the preview network log records a `206` for Salka's `.m4a` sample clip, and `ffprobe` confirms AAC audio. Capture a screenshot while playing.
7. Click `role=radio[name="Salka"]` and confirm `aria-checked="true"`. Verify `GET /api/episodes/<id>` shows `voice: "piper:is_IS-salka-medium"` while `job._tag === "Review"`. Capture a 390 px mobile screenshot. If `PUT /api/episodes/<id>/voice` fails, confirm an alert and `role=button[name="Retry saving voice"]` appear and clicking it re-sends the selected voice.
8. Click `role=button[name="Start · 1 chapter"]`, wait for `role=button[name="Play Höfnin hljóða"]` and `fama-verify wait <id>`. Confirm `GET /api/episodes/<id>` shows `job._tag === "Ready"` with `voice: "piper:is_IS-salka-medium"` and a valid `.m4b` book file (`206`, AAC via `ffprobe`).
9. Close the preview tab (`t3_preview_close`) and run `fama-verify down`.

### API and Worker priority

1. Set `FAMA_VERIFY_API_PORT=8861`, `FAMA_VERIFY_FIXTURE_PORT=8862`, and `FAMA_VERIFY_STATE=/tmp/fama-verify-s1` in the shell. Run `fama-verify down`, `up`, and `doctor` through `mise exec --`. For a fresh chunk cache, set `FAMA_CACHE_DIR="$FAMA_VERIFY_STATE/chunk-cache"` before `up`.
2. Send `POST /api/episodes` with `{"source":{"_tag":"Url","url":"http://127.0.0.1:8862/grein.html"},"speed":1,"voice":null}`. Record its ID. Poll `GET /api/episodes/:id/document` until `200`. Check that `language` is `is` and the first paragraph starts with “Höfnin vaknar á undan bænum.”
3. Start a timer before you send `POST /api/episodes/:id/samples` with `{}`. Compare the returned Voice IDs with the Icelandic entries in `GET /api/voices`. Poll `GET /api/episodes/:id/samples` until all four Samples are Ready. Record the elapsed time and the time to the first Sample claim from the Worker log. To measure the full idle delay, wait until an idle claim returns `204` just before you submit the POST.
4. For each Ready URL, request `Range: bytes=0-31`. Check for `206`, `Content-Type: audio/mp4`, and 32 bytes. Download the whole clip and run `ffprobe -v error -show_entries stream=codec_name,duration -of json <clip>`. Check for AAC and a duration of 5 to 40 seconds. Check that the SHA-256 hashes differ for all four clips.
5. Send the same POST again. It must return the same Ready Samples and the Worker must make no new Sample claims for this Episode.
6. Repeat with a new copy of the fixture. Wait for its narration to finish. On this isolated stack, pause the Worker group from `$FAMA_VERIFY_STATE/run.env` with `kill -STOP -- "-$WORKER_PID"`. Add a long text Episode and check that its Job is `Queued`. Request Samples twice for the fixture and check for the same Requested states. Always resume the group with `kill -CONT -- "-$WORKER_PID"`. Check the Worker log for all four Sample uploads before the first claim of the earlier Queued narration.
7. Save the Document, Sample list, clips, hashes, timings, and claim order in the run’s evidence directory. Run `fama-verify down` with the same environment.

## Gotchas

- A Worker finishes any narration it already started before it claims Samples. Queue both requests before its next claim to test priority.
- The media URL has `%3A` for the colon in the Voice ID. Use the returned path as-is.
- Playing a sample in web Review pauses any active main episode playback, and leaving Review or resuming main playback stops the sample clip.
- The local stack uses its own stored Documents, media and tokens.
