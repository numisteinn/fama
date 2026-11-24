# Add a link

A user pastes a link to a web article. Fama adds an episode with a provisional title (the URL host and path). The worker replaces the title with the article's real title, detects the language, and narrates the article with the default voice for that language, or with the voice the user picked.

## Sub-features

- `link-web` adds a link from the web add bar.
- `link-ios` fetches the page from the iPhone Add screen. Fama sends the final URL and the HTML, PDF, or EPUB bytes. If the fetch fails, Fama sends the original link alone.
- `link-paste` fills the iPhone Link field from the clipboard with the system `Paste` button, with no iOS paste prompt. The button shows only while the field is empty.
- `link-language` picks the default voice by detected language: English `kokoro:af_heart`, Icelandic `piper:is_IS-steinn-medium`.
- `link-voice` uses the voice and speed picked in the add bar or the Add screen.
- `link-share` adds a link from the iOS share sheet (Safari, Share, Fama).
- `link-invalid` refuses text that is not a link on iPhone (`Create` stays disabled). On the web, such text becomes a Text episode instead.

## How to get to it (user POV)

- Web: paste the link into `Link or text` and press Enter or choose `Add`.
- iPhone: tab `Add`, mode `Link`, type or paste into `Link`, choose `Create`. The button shows `Create…` while Fama fetches and sends the Source. The app then goes to `Library`.
- iPhone: in Safari, Share, then `Fama`. A confirm sheet with voice and speed opens in the app. Choose `Add`.

## Driving it with preview tools and agent-device

Preconditions:

- Baseline from `README.md`. The fixture server serves `http://localhost:8790/article.html` and `http://localhost:8790/grein.html`.
- The library has no episode titled `The Quiet Harbour` or `Höfnin hljóða`.

- **Web, add.** Type into textbox `Link or text` and press Enter. Run `preview_act {action: "type", locator: 'role=textbox[name="Link or text"]', text: "http://localhost:8790/article.html"}` and `preview_act {action: "press", key: "Enter"}`. A row with button `Play localhost:8790/article.html` (disabled) and status `Queued` appears at the top, and the textbox is empty.
- **Web, real title.** Run `preview_wait_for {locator: 'role=button[name="Play The Quiet Harbour"]', timeoutMs: 60000}`. The row shows the real title and a duration.
- **Web, stored episode.** Run `fama-verify api GET /api/episodes > $EVIDENCE/link-web/episodes.json`, then `fama-verify wait <id>`. The output starts with `Ready`, with `"language": "en"`, `"voice": "kokoro:af_heart"`, one chapter titled `The Quiet Harbour` of about 34000 ms, and a `bookUrl`.
- **Web, audio exists.** Run `curl -s -D - -o $EVIDENCE/link-web/book.m4b -H 'Range: bytes=0-' http://localhost:8788<bookUrl>` and `ffprobe -v error -show_entries format=duration -of csv=p=0 $EVIDENCE/link-web/book.m4b`. The headers say `206 Partial Content` and `audio/x-m4a`. The duration is about 34 s.
- **iPhone, add.** Run `$AD press 'label="Add"'`, `$AD press 'label="Link" editable=true'`, `$AD type "http://localhost:8790/grein.html"`, `$AD press 'label="Create"' --settle`. The app goes to `Library`, and a row for the new episode is at the top.
- **iPhone, language.** Find the episode id in `fama-verify api GET /api/episodes` (source URL ends in `grein.html`) and run `fama-verify wait <id>`. The output starts with `Ready`, with `"language": "is"`, `"voice": "piper:is_IS-steinn-medium"` and title `Höfnin hljóða`. `$AD snapshot -i` shows button `Höfnin hljóða`.
- **iPhone, uploaded bytes.** Match the episode ID across the API and worker logs. The API logs `Stored upload with url for episode <id>`. The worker logs `read uploaded page from the API, no web fetch`. The fixture access log has one GET for the page. The API lists a Url Source with the page URL.
- **iPhone, fallback.** After the fixture episode is Ready, stop the fixture server for this run. Add its other article URL. Check that the API log shows `POST /api/episodes 201`, and that the worker marks the new Url episode Failed with `Could not fetch the page`. Save the Library screen and the failure reason.
- **iPhone, public page.** Add a public article from the simulator. Check that the API stores the upload, the worker reads the bytes, and the episode reaches Ready with the article title.
- **Voice picked by the user.** Web: choose button `Voice: Auto`, choose a voice in the menu, then add `article.html` again. iPhone: `$AD press 'label="Voice, Auto"'` and pick a voice. `fama-verify wait <id>` shows that voice, not the default.
- **Share sheet.** With the fixture server running, Run `$AD open com.apple.mobilesafari http://localhost:8790/article.html`, press the Safari share button, choose `Fama`, then `Add` in the confirm sheet. `fama-verify api GET /api/episodes` gains a Url episode for `article.html`.
- **Proof.** Web: `preview_snapshot {save: true}` after the title changes, copied to `$EVIDENCE/link-web/`. iPhone: `$AD screenshot $EVIDENCE/link-ios/library.png`. Keep the `wait` output and the `ffprobe` output next to them.

## Gotchas

- The provisional title is `host/path` without the scheme. Wait for the real title before you assert it.
- The iPhone app never reads the clipboard by itself. Put a link there with `$AD clipboard write <url>`, then press button `Paste`. The field gets the clipboard text and `Create` turns on.
- Never `fill` on the iPhone. See `README.md`.
- On iPhone, `Create` stays disabled until the text looks like `http(s)://host.tld...`. `http://localhost:8790/...` passes because of the dot in the path.
- On the web, input with a space, or without `http(s)://`, is sent as a Text source, not a link. That is expected behavior, not a link failure.
- The iPhone follows redirects and limits the fetch to 10 seconds and 10 MiB. The limit bounds memory use during download and multipart upload. The worker fetches links sent without bytes, including links from the web app.
- `link-paste` was driven on 2026-11-24 on the iPhone 18 Pro Simulator: `Paste` filled the field with no prompt, and the clear button left it empty with `Paste` back. `link-share` was not yet driven in a recorded run.
