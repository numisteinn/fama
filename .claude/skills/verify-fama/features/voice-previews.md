# Voice previews

The Voice catalog gives clients a URL for each ready preview. The clip plays from public storage without an Episode, a token, or a running narration Worker.

## Sub-features

- Register Voices and list those that need a preview.
- Generate missing previews, regenerate one Voice, or regenerate the local catalog.
- Serve AAC clips with byte ranges, `HEAD`, and a cache revision.

## How to get to it (user POV)

Read `GET /api/voices` with the client token. Open the returned `previewUrl` at the server origin. A Voice with no preview has a `null` URL.

## Driving it with preview tools and agent-device

P1 provides the CLI and HTTP path. Use the commands below to test them on the disposable API.

1. Run `fama-verify up --no-worker` and use the evidence directory it prints.
2. From `worker/`, run `uv run fama previews --api http://localhost:8788 --token dev-worker-token --voice piper:is_IS-salka-medium`. Save the output.
3. Save `fama-verify api GET /api/voices` as JSON. Read Salka's `previewUrl`. Check that the other Voices have `null` URLs.
4. With no token, fetch the clip to a `.m4a` file and run `ffprobe` on it. Check the codec and duration. Save response headers for `GET`, `HEAD`, and `GET` with `Range: bytes=0-15`. The range must return `206`. The versioned URL must have a one-year immutable cache header. The URL without the query must have a 300-second cache header.
5. Run the same CLI command again. Check the catalog for a new revision. Run `fama-verify down`.

## Gotchas

- Use the encoded path from the catalog. Prefix the server origin.
- Use a Voice for which the local engine can load its model.
- An Episode Sample uses the Episode's Document. A Voice preview uses a fixed introduction.
