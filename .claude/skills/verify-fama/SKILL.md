---
name: verify-fama
description: Drive the real Fama app to prove behavior. Web app in a T3 preview tab, iPhone app on the iOS Simulator, the Mac worker making episodes, and the private podcast feed, all against a fresh local wrangler dev instance on port 8788 (never the deployed server). Use to verify a change, reproduce a bug, or prove a feature works, before claiming it does.
---

# Verify Fama

Fama turns links, files and text into narrated audio. A user adds a **Source** on the web or the iPhone, the **Worker** on the Mac narrates it, and the **Episode** plays in the app or in a podcast app through the **Feed**. Terms: `CONTEXT.md`. HTTP contract: `docs/api.md`.

This skill starts its own instance. It never drives the deployed server (`*.workers.dev`), and never the user's `pnpm dev` on port 8787.

| Part | Where |
|---|---|
| API + web app (wrangler dev, local D1 and R2) | `http://localhost:8788`, state in `$TMPDIR/fama-verify/wrangler`, empty on every `up` |
| Fixture server (articles, EPUB, PDF, Markdown) | `http://localhost:8790`, files in `fixtures/` |
| Mac worker | `uv run fama work`, worker id `verify-<RUN_ID>` |
| Metro (iPhone only) | `:8081` |
| Tokens | `up` seeds one user, `dev-user`, into the empty D1: client token `dev-api-token` (the web and iPhone `API token`), feed token `dev-feed-token`. The worker uses `FAMA_WORKER_TOKEN=dev-worker-token` from `apps/api/.dev.vars`. Each token opens only its own routes. |
| Evidence | `~/Developer/fama-shots/verify/<RUN_ID>/`, kept after cleanup |

The helper is `.claude/skills/verify-fama/scripts/fama-verify`. Run it from the repo root. It needs `pnpm install` and `(cd worker && uv sync)` done once, and the mise tools on `PATH` (in a non-interactive shell: `export PATH="$HOME/.local/share/mise/shims:$PATH"`).

## Launch

```sh
.claude/skills/verify-fama/scripts/fama-verify up            # API + web + fixtures + worker
.claude/skills/verify-fama/scripts/fama-verify up --no-worker # to watch the Queued state, then: fama-verify worker
```

`up` builds `apps/web/dist`, applies the D1 migrations to an empty state dir, seeds the dev user with `apps/api/scripts/create-user.ts`, starts wrangler dev on 127.0.0.1:8788, the fixture server and the worker, each in its own process group. It returns when the API answers `GET /api/episodes` with the token and the worker has registered its voices (`GET /api/voices` is not empty). That takes about 5 s with warm caches. It prints `RUN_ID`, `WEB`, `TOKEN`, `WORKER_TOKEN`, `FIXTURES` and `EVIDENCE`.

`up` refuses when an instance is already up or when port 8788 or 8790 belongs to another process. It never kills what it did not start.

For the iPhone, also run `fama-verify metro`. It starts Metro on 8081 and refuses if 8081 belongs to someone else (for example the user's own `pnpm start`). In that case, stop and ask, or use their Metro and say so in the report.

## Doctor

```sh
.claude/skills/verify-fama/scripts/fama-verify doctor
```

This check only reads. It confirms that the API process is alive, that the listener on 8788 is in this run's process group, that the client token gets 200, no token gets 401, the feed token gets 401 on `/api/*` and the client token gets 401 on `/api/worker/*`, that the web app and the fixtures are served, that the worker is alive with voices registered, and that Metro serves (when started). It also prints the commit the build came from and the current commit. If they differ, run `down` and `up` again before you trust a result. Run doctor first whenever anything looks wrong.

## Drive: web (T3 preview tab)

Load the tools with ToolSearch: `select:mcp__t3-code__preview_open,mcp__t3-code__preview_act,mcp__t3-code__preview_snapshot,mcp__t3-code__preview_evaluate,mcp__t3-code__preview_wait_for,mcp__t3-code__t3_preview_close`.

1. `preview_open` with `target: {kind: "environment-port", port: 8788}` and `reuseExistingTab: false`. Keep the returned `tabId` for every call.
2. When no token is stored (localStorage `fama.token`, per origin), the Settings dialog opens by itself. Type `dev-api-token` into textbox `API token`, then click button `Save`. Leave `Server` empty: the page's own origin is the API. The default preview profile keeps localStorage between tabs and runs, so the token is often already there: then the dialog does not open, and an empty library with no error message proves the token works. To test the first-run state, open the tab with `profileId: "incognito"`.
3. Act with `preview_act` and `locator: 'role=button[name="…"]'` or an `aria-ref` from the last `preview_snapshot`. Refs die on each new snapshot.

Stable handles (accessible names):

| Area | Handles |
|---|---|
| Header | button `Settings` |
| Add bar | textbox `Link or text`, button `Attach file`, hidden `input[type=file]` (selector), button `Voice: <name>`, button `Voice speed: <rate>`, button `Add` (Enter in the textbox also submits), `role=alert` for errors, one row for each attached file with button `Remove <name>` (and `Retry <name>` after a failed upload; a refused type shows `role=alert` `Unsupported type`). In an open menu, type-ahead highlights an item (`aria-activedescendant` on `role=menu`): keys within 750 ms make a prefix (`Ste` goes to `Steinn`), the same letter again goes to the next item that starts with it, a key with no match clears the prefix, and Space inside a prefix extends it (`The E` goes to `The End`) instead of selecting |
| Library row | button `Play <title>` / `Pause <title>` (disabled until chapter 0 exists; on failure the reason is text inside this disabled button, not an alert and not in its name), status text `Queued`, `Reading`, `Narrating n/m`, `Encoding`, `Uploading`, duration when ready rounded to minutes (`1 min`), button `Retry` on failure (no title in its name: with two failed rows, scope the locator to the row), button `Delete <title>` (two clicks: it arms, then a `Delete` button confirms; it disarms after about 3 s) |
| Player bar | landmark `contentinfo`; buttons `Back 15 seconds`, `Play`/`Pause`, `Forward 30 seconds`; group `Position` holding an unnamed `input[type=range]` (step 1000; `aria-valuenow` is the exact position in ms; the max is the duration rounded up to a whole second, and that last stop is the very end); the text right of the slider is the total length, not the time left; button `Playback speed: <rate>` (0.75× to 3×); button `Chapters` with items named `<n> <title>` (`1 Morning`, `2 Evening`; picking one also starts playback); link `Download` (href is the book file) |
| Settings dialog | textbox `API token`, textbox `Server`, button `Save`, button `Copy feed URL` (its name is `Copied` for about 1.5 s), button `Close` |

Voice speed in the add bar is 0.8× to 1.5×, and voice names repeat across languages (`Alex`, `Dora`, `Santa`). A wrong token shows the add-bar alert, which stays until the next submit or file change. A narrow layout has a second, hidden set of `Play`, `Back 15 seconds` and `Forward 30 seconds` buttons: use `>> nth=0` or a visible-only check.

The web app is Foldkit. It renders on animation frames, and a preview tab that is not visible gets about one frame per second. Wait for state with `preview_wait_for` and a locator, for example `role=button[name="Play The Quiet Harbour"]`, or wait about 2 s before a `preview_evaluate` read. Never trust a read taken right after an action. The library polls every 2 s while a job is Queued or Running. When the T3 window is hidden, `preview_snapshot` fails with "not producing screenshot frames": read the DOM with `preview_evaluate` and say so in the report.

## Drive: iPhone (iOS Simulator)

Load `select:mcp__t3-code__device_list,mcp__t3-code__device_open,mcp__t3-code__device_screenshot,mcp__t3-code__device_close`. Call `device_list`, then `device_open` with the booted iPhone's `hostId` and `id`. It returns an `agent-device` path bound to that device. Use that path for every launch, tap, text entry and screenshot. Do not use `xcrun simctl`, `idb` or scripts for UI actions. Below, `$AD` is that path.

The app (`dev.fama.app`) is a debug dev client and must already be installed on the simulator. If it is missing, build and install it as `apps/mobile/README.md` says (`simctl install` is allowed for installs).

1. `fama-verify metro`, then `$AD open dev.fama.app --relaunch --metro-port 8081`. Give it a few seconds to load the bundle, then `$AD snapshot -i`.
2. **Point the app at 8788, and record the old value.** Settings are shared with the user's own testing. Tap `$AD press 'label="Settings"'` and read the `Server URL` text field value from the snapshot. Write it down; cleanup puts it back. To change it, focus the field (`$AD press 'label="Server URL"'`), delete characters with `$AD press 'label="delete"' --count <n>`, append with `$AD type "<text>"`, then `$AD press 'label="Save"'`. The status text must read `Connected`. The token field is `API token` and also takes `dev-api-token`.
3. Tabs: buttons `Library`, `Add`, `Settings`.

Stable handles (accessibility labels):

| Screen | Handles |
|---|---|
| Add | cells `Link`, `Text`, `File` (mode tabs), text fields `Link`, `Title`, `Text`, button `Choose files`, one row for each picked file with `Remove <name>` (and `Retry <name>` after a failed upload), buttons `Voice, <name>`, `Speed, <rate>`, button `Create` (disabled until the input is valid) |
| Library | one button per episode, named by its title (opens the player and starts playback), button `Delete <title>`, button `Retry` |
| Player (modal) | `Close player`, `Chapters`/`Hide chapters`, `Position`, elapsed and remaining text (`0:14`, `-0:16`), `Pause`/`Play`, `Back 15 seconds`, `Forward 30 seconds`, `Playback speed <rate>`, `Download`/`Downloading`/`Downloaded`, `AirPlay` |
| Mini player | `Open player, <title>`, `Play`/`Pause`, `Forward 30 seconds` |
| Settings | text fields `Server URL`, `API token`, button `Save` (only while edited), status `Connected` or an error, buttons `Add to Podcasts`, `Copy feed URL` |

## Evidence

Put every artifact under `$EVIDENCE/<feature-id>/` (the path `up` printed). Proof standards:

- Drive the real user path: the add bar, the Add screen, the play buttons. Do not create episodes with `fama-verify api POST` when the feature under test is the UI. The `api` helper is for the second, read-only view.
- Capture the action and the resulting state: a snapshot or screenshot before and after, not only the final screen. Web: `preview_snapshot` with `save: true` gives a PNG path; copy it into the evidence dir. iPhone: `$AD screenshot $EVIDENCE/<feature>/<name>.png`.
- Prove the side effects too: `fama-verify api GET /api/episodes` saved to a JSON file (title, language, voice, chapters, job), and the media itself (`curl -H 'Range: bytes=0-' http://localhost:8788<bookUrl>` returns `206`, `ffprobe` reads a duration).
- Playback proof is a moving clock: two reads of the position (web slider value in ms, iPhone elapsed text) a few seconds apart, plus a `206` for a chapter in the preview network log.
- No mocks. The worker narrates for real. The only stand-in is the fixture server in place of a public website.

## Cleanup

1. Web: `t3_preview_close` the tab you opened.
2. iPhone: pause playback, put `Server URL` back to the value you recorded, save, then `device_close` (no shutdown, since the user may be using the simulator).
3. `fama-verify down`. It stops the worker, Metro, fixture server and API by process group (only the groups it started), copies the logs to `$EVIDENCE/logs/`, and deletes `$TMPDIR/fama-verify`. Evidence stays.

After a failed attempt, run `down` before the next `up`, so no ports or processes are left behind.

## Helpers

All subcommands of `scripts/fama-verify` (run from the repo root):

```sh
fama-verify up [--no-worker]   # fresh instance with the dev user, prints RUN_ID, WEB, TOKEN, WORKER_TOKEN, FIXTURES, EVIDENCE
fama-verify worker             # start the worker after `up --no-worker`
fama-verify metro              # Metro on :8081 for the simulator
fama-verify doctor             # read-only health check, exit 1 when unhealthy
fama-verify api GET /api/episodes          # any client API call with the client token (GET /api/me names the user)
fama-verify wait <episodeId> [seconds]     # block until Ready or Failed, print a one-line summary
fama-verify feed               # print the feed URL
fama-verify down               # stop what this run started, keep evidence
```

`scripts/make-fixtures.py` rewrites `fixtures/` (run `uv run --project worker python .claude/skills/verify-fama/scripts/make-fixtures.py`). The fixtures are short on purpose: each narrates in seconds.

| Fixture | Expect |
|---|---|
| `article.html` | English, title `The Quiet Harbour`, voice `kokoro:af_heart`, 1 chapter, about 34 s |
| `grein.html` | Icelandic, title `Höfnin hljóða`, voice `piper:is_IS-steinn-medium`, 1 chapter, about 30 s |
| `harbour-days.epub` | title `Harbour Days`, author `Fama Fixtures`, chapters `Morning`, `Evening` |
| `harbour-notes.pdf` | title `Harbour Notes`, chapters `Part One`, `Part Two` |
| `harbour.md` | title `Harbour Note`, 1 chapter |

## Feature map

`features/README.md` is the index. Each feature file is the recipe for one user-facing feature. Read it before you drive the feature, and update it in the same change when the feature changes. `/maintain-verification-skill` audits the map against the app.
