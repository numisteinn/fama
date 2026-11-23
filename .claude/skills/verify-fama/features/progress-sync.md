# Progress sync

A listener's position in an episode follows them between the web app and the iPhone. Each client keeps `{ positionMs, updatedAt }` per episode, sends it to `PUT /api/episodes/:id/progress` when the listener pauses, skips, plays about 5 s more, hides the page or sends the app to the background, and takes the server's newer entry on every library load. The newest `updatedAt` wins. A finished episode stores its total length and plays again from 0. Loading an episode without playing it sends nothing.

## Sub-features

- `sync-web-push` a pause on the web stores the position on the server (`progress` on `GET /api/episodes/<id>`), with the same stamp as the tab's `fama.progress.<id>`.
- `sync-web-resume` a second web storage (another profile, or the entry removed) resumes at the server's position.
- `sync-web-passive` a web library load takes the server entry with the server's stamp and sends no `/progress` request.
- `sync-web-foreground` a Play pressed while the web tab loads the library (it just came back to the front, or a poll is out) waits for the requests that were out at the press, then starts at the newer of the tab's and the server's position. The tab sends nothing from its old position. The `Play` button shows a spinner while it waits. The Play starts on the list of the newest of those requests, or of a request sent later. A later request that fails (a poll that gets a 503) starts nothing. When each of those requests has failed, the Play starts from the tab's position; so does a second Play. A Pause key, a skip or a seek takes the waiting Play back. The waiting Play starts the episode as the answer lists it: with its new chapters, and from 0:00 when the job is now Ready and the other device finished it. An episode the answer no longer lists does not play. The overlap of two requests is in unit tests only (the web `Play while the library refreshes` stories, `awaitedAfter` in `packages/contracts/src/progress.test.ts`).
- `sync-finished` the end of an episode stores the total length, not 0, and the next Play starts at 0:00. When the last chapter ends while the job still encodes the book, the web stores the total length when the job is Ready. A position in the last 3 s of a Ready episode counts as the end on every device. On the web, each Play at such a position starts at 0:00: from the row, on a loaded player that took the entry from the server, and after the listener's own pause there. The web player keeps no "ended" state: each Play decides from the position, and from the chapters and the job in the newest list (`playStart` in the contract).
- `sync-growing` the end of the chapters made so far is not the end of the episode while the job is Queued or Running. A Play there waits (spinner), plays no audio and sends nothing. When a later list has the next chapter, playback goes on at the start of that chapter, never at 0:00. This is true for a Play from the row, a Play on a loaded player, a held Play, and a wait the listener paused. On the iPhone, the native player learns from each list whether the job still makes chapters: a Play at the end of its queue then waits, and new chapters for a paused player go on from where it was. The web stories and both sequence checks cover this rule. The iPhone rule is also in Swift (`EpisodePlayer.play`, `EpisodePlayer.updateTracks`); drive it with a job whose chapter uploads can be held.
- `sync-ios-push` a pause on the iPhone stores its position on the server.
- `sync-ios-passive` an app relaunch restores the last episode paused and sends no `PUT`.
- `sync-ios-resume` after the web moves an episode, an iPhone relaunch restores it at the web's position.
- `sync-ios-follow` a loaded, paused episode on the iPhone moves to a newer server position when the app comes back to the front.
- `sync-ios-foreground` a Play tapped while the iPhone app loads the library (it just came to the front) waits for the requests that were out at the tap, then starts at the newer of the phone's and the server's position. The rule is the web's: a later request that fails (a pull to refresh that gets a 503) starts nothing, and when each awaited request has failed the Play starts from the phone's position; so does a second tap. A pause, a skip or a seek takes the waiting Play back. The waiting Play starts the episode as the answer lists it, as on the web; a deleted episode takes its waiting Play back. Unit tests only (`apps/mobile/src/player/core.test.ts` and `sequence.test.ts`): it needs a real foreground, as `sync-ios-follow` does.
- `sync-offline` an entry the server never got (offline listening) goes out on the next library load. Unit tests only (`apps/mobile/src/player/progressRules.test.ts`, the web `progress sync` stories).

## How to get to it (user POV)

- Web: play an episode from its row, pause it, then open Fama in another browser or profile and play the same episode.
- iPhone: play an episode, pause it, then open Fama on the web; or move it on the web and relaunch the app.

## Driving it with preview tools and agent-device

Preconditions:

- Baseline from `README.md`.
- One Ready episode with two chapters: [Add a file](./add-file.md) with `harbour-days.epub` (46 525 ms). Keep its id from `fama-verify api GET /api/episodes`.

Steps:

- **Second view.** Save `fama-verify api GET /api/episodes/<id>` to `$EVIDENCE/progress-sync/` before and after each step. `progress` is `null` until the first save.
- **Web, push.** In tab A, choose `Play Harbour Days`, wait until the `Position` slider passes about 10000, choose `Pause` in `contentinfo`. Read `localStorage["fama.progress.<id>"]` with `preview_evaluate`. The API `progress` has the same `positionMs` and `updatedAt`.
- **Web, second tab.** Open tab B with `preview_open {profileId: "incognito", reuseExistingTab: false}`. Its storage is its own (its other keys differ from tab A's). After its first library load it already holds the server entry with the server stamp. To prove the resume comes from the server, remove `fama.progress.<id>` and reload; then `performance.getEntriesByType("resource")` has no `/progress` entry. Remove the entry again and choose `Play Harbour Days`: the first slider value is at the synced position, not 0.
- **Web, finished.** Choose `Forward 30 seconds` until the slider is at its max. The local entry and the API `progress` are `46525`. Choose `Play`: the chapter text is `Morning` and the slider starts near 0.
- **Other device.** A newer entry from another device is `fama-verify api PUT /api/episodes/<id>/progress -H 'Content-Type: application/json' -d '{"positionMs":<ms>,"updatedAt":"<now, ISO>"}'`. A tab loads the library when it comes to the front: `preview_evaluate` with `document.dispatchEvent(new Event("visibilitychange"))`, and return `document.visibilityState` from the same call. It must be `visible`.
- **Web, finished on another device.** With the episode loaded and paused in tab A, store `20000` as the other device and load the library: the slider is at 20000. Store `45000` and load the library again. The slider is at 45000, `fama.progress.<id>` holds the server entry with its stamp, and no `/progress` request went out. Choose `Play`: the chapter text is `Morning`, the slider starts near 0, and only now a `/progress` request goes out.
- **Web, Play during a library load.** Hold the library answer in the tab: in `preview_evaluate`, wrap `Response.prototype.json`, `text` and `arrayBuffer` so that a response whose `url` ends in `/api/episodes` waits 2000 ms before the original runs. With the player paused at 8000, store `30000` as the other device. In one `preview_evaluate`: dispatch `visibilitychange`, click `Play` 400 ms later, then sample the slider, the `Play`/`Pause` name, `fama.progress.<id>` and `performance.getEntriesByType("resource")` for about 9 s. While the answer is held, the name stays `Play`, the button holds a `.animate-spin` icon, the slider stays at 8000 and no request goes out. After the answer, the stored entry is the server's `30000`, the chapter text is `Evening`, the slider moves on from about 30000, and the first `/progress` request carries a position after 30000. No request carries a position near 8000.
- **iPhone, push.** Point the app at 8788 (record the old `Server URL`). Tap `Harbour Days`, let it play, tap `Pause`. The API `progress.positionMs` matches the elapsed text (`0:30` is about 30 000).
- **iPhone, passive.** Note the count of `PUT /api/episodes` lines in `$TMPDIR/fama-verify/api.log`. Run `$AD open dev.fama.app --relaunch --metro-port 8081`. The mini player shows `Open player, Harbour Days` and `Play`. The log has a new `GET /api/episodes`, the `PUT` count is the same, and the API stamp is unchanged.
- **iPhone, resume from the web.** In a web tab, play, skip, pause. Run the relaunch again, then `Open player, Harbour Days`: the elapsed text is the web's position.
- **Proof.** Web: `preview_snapshot {save: true}` of both tabs. iPhone: `$AD screenshot $EVIDENCE/progress-sync/<name>.png` after each step. Copy the `PUT` and `GET /api/episodes` lines of `api.log` to the evidence dir before `down`.

## Gotchas

- Both preview tabs in the default profile share one localStorage. Use the `incognito` profile, or remove `fama.progress.<id>`, for a second device.
- A web library load writes the server entry to localStorage before you look. That is the passive adopt, not a save: its `updatedAt` is the server's.
- The pause click lands a few seconds after the read that triggered it. Compare the API with the tab's stored entry, not with the planned position.
- `fama.position.<id>` keys from older builds are ignored. Only `fama.progress.<id>` counts.
- `document.visibilityState` in a preview tab follows the T3 window and cannot be redefined. When it is `hidden`, the `visibilitychange` event saves the position and loads nothing: check the value in the same call, and repeat the step when it was `hidden`.
- The web app keeps its own reference to `fetch`, so a wrapped `window.fetch` holds nothing. Wrap the `Response.prototype` readers. Dispatching `visibilitychange` and clicking `Play` in the same tick proves nothing either: the click reaches the app before the library request goes out.
- On the simulator, `$AD home` then `$AD open dev.fama.app` reloads the JS bundle in a second runtime (a second `Running "main"` in `$AD logs path`), and the old screen stays frozen. So `sync-ios-follow` cannot be driven this way; use a relaunch for server-to-phone checks, and report `sync-ios-follow` as needing a real foreground.
- The iPhone sends while playing only after 5 s of movement. A pause sends at once.

## Playback decision and regression checks

Both clients keep listener intent and player facts in state. One decision step derives playback and progress writes. Web audio commands are absolute Play and Pause. On the phone, the newest chapters and job reach the native player before Play. A paused player keeps the saved position, including the end; only Play decides whether to start again at 0.

A paused, held or waiting player takes newer server progress without a new stamp. If the saved position is past the available audio, keep that entry until the chapters reach it. Do not stamp the shorter position where the audio must wait. A listener can cancel a wait with Pause. When a finished episode runs out of audio, its Play intent ends.

Additional real-app recipes:

- Repeat **Web, Play during a library load**, but give the other device the same position with a newer stamp. After the answer, the clock must move and keep moving. No second command may pause it.
- For a growing job, hold the worker after chapter 1. Play to the end. Check the spinner, then Pause, then Play. Upload chapter 2. The clock must continue at chapter 2, not 0. Finish the job. After the episode ends, Play must start at 0.
- Repeat with a one-chapter job. Pause at the waiting end, then Play, then make the job Ready without adding a chapter. The pending Play must start at 0 and the clock must move.
- For a job with one available chapter, save a position past that chapter through the API. Play the Episode on the web, then play a different Episode while the first waits. Read the first Episode from the API again. Its position and stamp must stay the same.
- On iPhone, play a chapter to the end while the Job still makes the next one. Pause with a headphone control during the wait. Save a position in the next chapter from the web. When the iPhone gets the new chapter and position, it must stay paused there. Repeat with Pause in the app as the new chapter arrives.

The bounded checks run in `pnpm test`: `apps/web/src/sequence.test.ts` drives the real web update, and `apps/mobile/src/player/sequence.test.ts` drives the pure phone core with a model of the native queue. `FAMA_SEQUENCE_DEPTH` selects a deeper run. These checks do not replace a native build and simulator run.

Verification on 2026-11-23: all numbered web and iPhone recipes above ran on local port 8788. The same-position web case and both growing-job phone cases also passed. The iPhone 14 Pro simulator ran a rebuilt dev client and worktree Metro on 8082. Evidence: `~/Developer/fama-shots/verify/20261123-172925/`.

NOT VERIFIED on a real foreground transition: `sync-ios-follow` and `sync-ios-foreground`. The simulator reloads its JavaScript runtime on the home/open path. Relaunch checks passed; the pure-core tests cover request ordering. Offline sync and overlapping failed requests remain unit/model checks.
