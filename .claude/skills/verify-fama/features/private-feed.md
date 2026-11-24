# Private feed

A user copies the private feed URL from Settings and adds it to a podcast app. The feed is RSS with the iTunes namespace, blocked from directories, and has one item for each of the user's Ready episodes, newest first. Each item's enclosure is the book file, which streams with HTTP Range. The feed token in the path is the only secret, because podcast apps cannot send headers. It opens only that user's feed and media, never the API.

## Sub-features

- `feed-url-web` shows the feed URL in the web Settings dialog and copies it (`Copy feed URL`, then `Copied`).
- `feed-url-ios` copies the feed URL on the iPhone (`Copy feed URL`, alert `Feed URL copied`) or opens Podcasts (`Add to Podcasts`).
- `feed-items` lists one item for each Ready episode and leaves out Queued, Running and Failed episodes.
- `feed-cover` shows open Ribbon + Fan Pan as the channel artwork.
- `feed-enclosure` serves each enclosure with `206` for a Range request, type `audio/x-m4a`, and a length that matches the bytes.
- `feed-transcript` gives an item a `podcast:transcript` tag when each chapter has a timing file. The tag points to a WebVTT transcript on the timeline of the book file: one cue for each Segment, the Document text, and each cue starts where the voice starts that text in the book file.
- `feed-private` refuses a wrong feed token, while the right token needs no header. The feed token gets `401` on `/api/*`, and a media path under `uploads/` gets `404`.
- `feed-rotate` (`POST /api/feed/rotate`, no UI yet) gives a new feed URL, and the old feed and media URLs get `401`.

## How to get to it (user POV)

- Web: button `Settings`. The `Podcast feed` row shows the URL, and `Copy feed URL` copies it.
- iPhone: tab `Settings`, then `Copy feed URL` or `Add to Podcasts`.
- Podcast app: paste the URL as a new show by URL.

## Driving it with preview tools and agent-device

Preconditions:

- Baseline from `README.md`.
- At least two Ready episodes, for example `The Quiet Harbour` ([Add a link](./add-link.md)) and `Harbour Days` ([Add a file](./add-file.md)), and one episode that is not Ready (add one with `fama-verify up --no-worker`, or add one and read the feed before the worker finishes).

- **Web, URL.** Choose `Settings`. The `Podcast feed` row shows `http://localhost:8788/feed/dev-feed-token/rss.xml`. Choose `Copy feed URL`. The button name becomes `Copied`, and goes back to `Copy feed URL` about 1.5 s later. Copy, close, reopen and copy again within 1.5 s: the second `Copied` still lasts its full 1.5 s.
- **URL from the API.** Run `fama-verify feed`. It prints the same URL.
- **Items.** Run `curl -s "$(fama-verify feed)" > $EVIDENCE/feed/feed.xml` and `grep -oE '<title>[^<]*</title>|<enclosure [^>]*>' $EVIDENCE/feed/feed.xml`. The channel title is `Fama`. There is one item for each Ready episode, newest first, each with an `<enclosure ... type="audio/x-m4a"/>`. No item exists for the episode that is not Ready.
- **XML is valid.** Run `python3 -c "import xml.dom.minidom,sys; xml.dom.minidom.parse(sys.argv[1])" $EVIDENCE/feed/feed.xml`. Exit code `0`.
- **Cover.** Read the channel's `itunes:image` URL from the RSS. Fetch that URL. It returns `200` and `image/jpeg`. Check for the 1400 × 1400 image of open Pan on spruce. The URL ends in `cover.jpg?v=ribbon-fan` so podcast apps can request the new artwork.
- **Transcript.** Add `harbour-year.epub` and wait for Ready (four chapters, so the cues of chapters 2 to 4 test the offsets). The feed declares `xmlns:podcast="https://podcastindex.org/namespace/1.0"`, and its item has `<podcast:transcript url=".../media/dev-feed-token/episodes/<id>/transcript.vtt" type="text/vtt" language="en"/>`. Read the tag with `getElementsByTagNameNS` of `xml.dom.minidom`, so the namespace is proven too.
  - `curl -s -D - -o transcript.vtt <url>`: `200`, `Content-Type: text/vtt; charset=utf-8`.
  - `uv run --with webvtt-py python -I check_vtt.py <dir>` reads the file with no error. Its cue count equals the Segments of the four timing files, each cue start is the Segment `startMs` plus the `durationMs` of the chapters before it, and these offsets equal the `start_time` of each chapter in `ffprobe -show_chapters -of json book.m4b`.
  - Pick one cue from each of three chapters after the first. Cut the book file at the cue start (`ffmpeg -ss <start> -i book.m4b -t 4 -ac 1 -ar 16000 cut.wav`) and transcribe it with `mlx_whisper` (`uv run --with mlx-whisper`, model `mlx-community/whisper-large-v3-turbo`, cached on this Mac). The heard text starts with the cue text. Compare two words: the voice reads `9` as `nine`. The 200 ms before the cue start are silent (RMS near 0), the 200 ms after are not.
  - Scripts from the R4 run: `~/Developer/fama-shots/verify/20261124-151428/transcript/check_vtt.py` and `check_audio.py`.
- **Enclosure streams.** For one enclosure URL, run `curl -s -D - -o /dev/null -H 'Range: bytes=0-99' <url>`. Status `206`, `Content-Range: bytes 0-99/<length>`, and `<length>` equals the enclosure `length` attribute.
- **Private.** Run `curl -s -o /dev/null -w '%{http_code}' http://localhost:8788/feed/wrong-token/rss.xml`. The status is `401`. Run `curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer dev-feed-token' http://localhost:8788/api/episodes`. The status is `401`.
- **Rotate.** Do this last: it changes the feed token for the rest of the run. Run `fama-verify api POST /api/feed/rotate`. It prints a new URL. The old URL and an old enclosure URL now get `401`, the new URL gets `200`, and `fama-verify api GET /api/episodes` shows media URLs with the new token. The web Settings dialog shows the new URL after it opens again.
- **iPhone, copy.** Run `$AD press 'label="Settings"'` and `$AD press 'label="Copy feed URL"'`. An alert `Feed URL copied` appears. Run `$AD alert accept`.
- **Proof.** Keep `feed.xml`, the `grep` output, and the curl headers in `$EVIDENCE/feed/`. Web: `preview_snapshot {save: true}` with the Settings dialog open.

## Gotchas

- The feed URL holds the feed token. Locally it is `dev-feed-token` until a rotate, which is fine to save as evidence. Never copy a deployed feed URL into evidence or logs.
- Enclosure URLs use the origin of the request. A feed read through `localhost` has `localhost` enclosures, which a phone on the LAN cannot reach.
- `Add to Podcasts` opens the Podcasts app on a real phone. On the simulator it may fall back to copying the URL, with alert `Podcasts did not open`. Both are expected.
- Apple Podcasts shows no transcripts for a private feed: "Because private RSS feeds are not processed in Apple Podcasts Connect, transcripts are not displayed for episodes that are not distributed to the Apple Podcasts catalog" (https://podcasters.apple.com/support/5316-transcripts-on-apple-podcasts). Other apps that read `podcast:transcript` (for example Pocket Casts, which takes VTT) can.
- An episode made before timing files has no transcript tag, and its transcript path is `404`.
- A podcast app caches the feed. A real-app check is not part of this map.
