# Voice Samples

A Sample lets the User hear a Voice read the first body paragraph of their stored Document. Each Voice reads the same passage at the Episode’s speed. The API queues Samples before new narration Jobs.

## Sub-features

- Ask for all registered Voices of the Document’s language, or ask for specific Voices.
- List the Sample state and play Ready clips through private media URLs with byte ranges.
- Ask again while the Samples are Requested or Ready. The API creates no new work for those Samples.

## How to get to it (user POV)

Add a Source. Once the Episode has a stored Document, request Samples with `POST /api/episodes/:id/samples` and list them with `GET /api/episodes/:id/samples`. The apps will expose this in Review in S2 and S3.

## Driving it with preview tools and agent-device

Drive this feature through the API. Use the verify-fama stack and the real Mac Worker.

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
- The local stack uses its own stored Documents, media and tokens.
