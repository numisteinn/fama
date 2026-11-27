# Playback

A user plays an episode. All chapters play as one timeline with one scrubber. The user can pause, skip back 15 s and forward 30 s, scrub, change speed, jump to a chapter and download the book file. On the iPhone, a mini player stays above the tab bar, downloaded chapters play offline, and the lock screen and AirPlay work through the native player. The position of each episode is saved and synced between devices: see [Progress sync](./progress-sync.md).

## Sub-features

- `play-web-start` starts and pauses an episode from its library row and from the player bar.
- `play-web-skip` moves the position by -15 s and +30 s, and by scrubbing.
- `play-web-speed` changes the playback rate (`Playback speed: <rate>`).
- `play-web-chapters` lists chapters and jumps to one.
- `play-web-download` downloads the book file (`Download` link).
- `play-ios-start` opens the player from a library row and starts playback.
- `play-ios-mini` shows the mini player after `Close player`, with play and pause.
- `play-ios-resume` resumes at the saved position after a relaunch (the newer of the phone's and the server's).
- `play-ios-download` downloads the chapters (`Download`, then `Downloaded`).
- `play-ios-airplay` opens the AirPlay route picker.
- `play-while-running` plays chapter 0 while the job is still `Running`.

## How to get to it (user POV)

- Web: choose `Play <title>` in the library. The player bar appears at the bottom.
- iPhone: tap the episode in `Library`. The player opens as a modal and starts playing. `Close player` leaves the mini player above the tab bar.

## Driving it with preview tools and agent-device

Preconditions:

- Baseline from `README.md`.
- At least one Ready episode with two chapters. Make one with [Add a file](./add-file.md) and `harbour-days.epub` (chapters `Morning`, `Evening`, about 46 s).

- **Web, start.** Choose `Play Harbour Days`. Run `preview_act {action: "click", locator: 'role=button[name="Play Harbour Days"]'}`. The row button becomes `Pause Harbour Days`. The player bar shows `Harbour Days` and `Morning`, and button `Pause`. The network log has a `206` for `.../chapters/000.m4a`.
- **Web, moving clock.** Run `preview_snapshot` twice, about 3 s apart. The range input inside group `Position` has a larger `aria-valuenow` (exact ms) the second time, and the elapsed text left of it changes. The text right of it is the total length.
- **Web, skip.** Choose `Forward 30 seconds`. The position jumps by about 30000 ms and the chapter text changes to `Evening` (because `Morning` is about 27 s). Choose `Back 15 seconds`. The position drops by about 15000 ms.
- **Web, ended.** Play to the end of the last chapter (or `Forward 30 seconds` until the slider is at its max and the player shows `Play`). `localStorage["fama.progress.<id>"]` holds the total length, not 0. Choose `Forward 30 seconds`, then `Play`. Playback starts again from `Morning` at 0:00, not from the start of the last chapter.
- **Web, speed.** Choose `Playback speed: 1×` and pick another rate. The button label changes, and the clock moves faster in the next two snapshots.
- **Web, chapters.** Choose `Chapters`, then the item `2 Evening` (items are named `<n> <title>`; typing `2` also highlights it). The chapter text shows `Evening`, and playback starts.
- **Web, menu over the library.** With `Chapters` open, a click on a library row closes the menu and starts nothing (`document.elementFromPoint` over the row is the menu backdrop `div.fixed.inset-0`).
- **Web, download.** Read the href of link `Download`. `curl -s -D - -o /dev/null http://localhost:8788<href>` returns `200` or `206` with `audio/x-m4a`.
- **Web, pause.** Choose `Pause`. Two snapshots show the same slider value.
- **iPhone, start.** Run `$AD press 'label="Harbour Days"' --settle`, then `$AD snapshot -i`. The player shows `Close player`, the title, `Pause`, the elapsed text (for example `0:14`) and the remaining text (for example `-0:16`).
- **iPhone, moving clock.** Run `$AD snapshot -i` twice, a few seconds apart. The elapsed text grows.
- **iPhone, mini player.** Run `$AD press 'label="Close player"' --settle`. `Library` shows `Open player, Harbour Days`, `Pause` and `Forward 30 seconds`.
- **iPhone, download.** In the player, run `$AD press 'label="Download"'`. The label becomes `Downloading`, then `Downloaded`. Take the phone offline (or stop the local API) and force a fresh native player load — relaunch (`$AD open dev.fama.app --relaunch --metro-port 8081`) or switch to another episode and back — then open `Harbour Days`, jump to `Evening`, and check that playback advances from disk.
- **iPhone, resume.** Pause at a known position, then `$AD open dev.fama.app --relaunch --metro-port 8081`. The mini player is there, paused, and `Open player` shows the same elapsed time.
- **Proof.** Web: two `preview_snapshot {save: true}` images a few seconds apart, copied to `$EVIDENCE/playback-web/`. iPhone: `$AD screenshot $EVIDENCE/playback-ios/player-1.png`, wait, then `player-2.png`.

## Gotchas

- The web player uses a detached `new Audio()`. There is no `<audio>` element in the DOM, so read the position from the `Position` slider, not from `document.querySelector("audio")`.
- The web library row play button is disabled until chapter 0 exists. Its name is `Play <title>` before the title is real, so wait for the real title first.
- The iPhone player starts playing as soon as it opens. Pause it before cleanup, or the simulator keeps playing audio.
- The Expo dev client shows a floating gear button on the right edge. It covers part of the screen in screenshots. It is not part of the app.
- The lock screen, AirPlay to a real device, and headphone controls cannot be proven on the simulator. `play-ios-airplay` only proves that the picker opens. Report the rest as needing a real iPhone.
- Short fixtures end fast. A jump of 30 s in a 34 s episode ends playback, so use the 46 s EPUB for skip tests.
