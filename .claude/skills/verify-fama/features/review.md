# Review before narration

Review lets the owner correct a Document and choose which chapters to keep before the worker makes audio. When Review is off, the worker starts narration after extraction.

## Sub-features

- Opt in when adding a link, text or file.
- Read the extracted title, author, language, voice and Document while the job waits in Review.
- Edit the Document. Start narration with only the kept chapters.

## How to get to it (user POV)

Use the client API with the episode owner's token. The web and iPhone show Review in the Library. Editing and Start use the API.

## Driving it with preview tools and agent-device

Use the API for this recipe. Start the local stack with `fama-verify up` and check it with `fama-verify doctor`. Set `FAMA_VERIFY_API_PORT`, `FAMA_VERIFY_FIXTURE_PORT` and `FAMA_VERIFY_STATE` to unused values when another run is active.

1. Send `POST /api/episodes/upload` with `file=@.claude/skills/verify-fama/fixtures/harbour-days.epub` and `review=true` as multipart fields. Save the response and its episode ID.
2. Read `GET /api/episodes/<id>` until the job is `Review`. Save the response. Check title `Harbour Days`, author `Fama Fixtures`, language `en`, a voice, zero audio chapters and a null book URL.
3. Read `GET /api/episodes/<id>/document` and save the two-chapter Document. Change the text of `Evening` to `The red lantern shines across the harbour.` Send the edited Document to `PUT /api/episodes/<id>/document` and read it back.
4. Remove `Morning`. Wrap the remaining Document in `{ "document": ... }` and send it to `POST /api/episodes/<id>/start`. Save the response. Run `fama-verify wait <id>` and save a fresh episode read in `Ready`. Check that `Evening` is the only audio chapter and has index 0.
5. Fetch that chapter's `timingUrl` from the same server. Save the Timing file and check its Segments for the edited sentence. Fetch a byte range of the chapter audio and check that the API returns `206`.
6. Add the `article.html` fixture URL with `POST /api/episodes`, using a `Url` Source, a null voice and speed 1. Omit `review`. Wait for `Ready` without a Start request and save the final episode read.
7. Run `fama-verify down`. In the saved worker log, check that the EPUB ID has one extraction, a stop for Review, then a read of the stored one-chapter Document.

## Gotchas

- Send the full Document to Start with the kept chapters in playback order. Both edit and Start return `400` for an empty chapter list.
- The old lease ends at Review. A second Start returns `409` and leaves the first selection in place.
- Use the fixture port in the article URL and the API port in the media URLs.
