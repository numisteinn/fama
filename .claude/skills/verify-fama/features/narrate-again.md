# Narrate again

After an Episode is Ready or Failed, its owner can change Chapter text or select a Voice and speed. Published Chapters remain playable while the Worker makes replacements. The Worker reuses Chapters with matching inputs and builds the Book file again.

## Sub-features

- Change the text of one Chapter. Only that Chapter gets new audio and a new timing URL.
- Change the speed. All Chapters get new audio and timing URLs.
- The Book file and feed transcript use the new Chapters. Saved progress stays in the same Chapter as its duration changes.

## How to get to it (user POV)

The API supports these edits for the owner of a Ready or Failed Episode. Use the API for this core feature. The review screens and downloaded media on the iPhone have their own verification paths.

## Driving it with preview tools and agent-device

Use the local API. To run beside other journeys, export these settings before every helper call.

```sh
export FAMA_VERIFY_API_PORT=8921 FAMA_VERIFY_FIXTURE_PORT=8922 FAMA_VERIFY_STATE=/tmp/fama-verify-n1
verify=.claude/skills/verify-fama/scripts/fama-verify
"$verify" up
"$verify" doctor
api=http://localhost:$FAMA_VERIFY_API_PORT
fixture=.claude/skills/verify-fama/fixtures/harbour-year.epub
curl -fsS -H 'Authorization: Bearer dev-api-token' \
  -F "file=@$fixture;type=application/epub+zip" -F "voice=kokoro:af_heart" \
  "$api/api/episodes/upload"
```

1. Copy `id` from the response. Run `fama-verify wait "$id" 420`. Save the Episode JSON. For Chapters 0 through 3, record the SHA-256 of the bytes at each `url` and the JSON at each `timingUrl`. Also save the Book file hash, the duration from `ffprobe`, and the WebVTT served at the transcript URL in the feed from `fama-verify feed`. This first request primes the transcript cache.
2. Get `/api/episodes/$id/document`. Replace only `chapters[2].text` with `Orange lanterns guide the last ship home.`. Send the whole Document back with `PUT /api/episodes/$id/document` and `Content-Type: application/json`. Expect `204`. Wait for Ready again and collect the same artifacts.
3. In the Worker log, check for `uploaded chapter 2` and `reused chapter` for 0, 1 and 3. Check that 0, 1 and 3 have the first audio hashes and timing URLs. Chapter 2 must have new audio bytes, a new timing URL, and the edited text in its timing JSON. The Book file URL, hash and duration must change. The feed transcript must contain the edit.
4. Send `{"voice":"kokoro:af_heart","speed":1.31}` with `PUT /api/episodes/$id/voice`. Expect `204`. Wait for Ready again and collect the same artifacts. The Worker log must show uploads for all four Chapters. The audio hashes and timing URLs must all change and the Book file must be shorter.
5. Run `fama-verify down` to stop the local run and save its logs.

## Gotchas

- Indices start at zero. Keep the four Chapter titles in their original order and keep Document metadata as it was.
- Both edit routes return `409` while the Job is Queued or Running. A chapter hash match reuses the published audio, even if this Worker has an empty synthesis cache.
- Compare the new `timingUrl` values from the Episode JSON. An older URL can still read the older bytes. This recipe checks the URLs and files served by the API.
