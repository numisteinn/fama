# Fama iOS app

Expo SDK 58, React Native 0.88, expo-router. Dark only, DM Sans, one accent. Bundle id `dev.fama.app`.

Screens: Library (tab), Add (tab), Settings (tab), Player (modal), share confirm (`fama://expo-sharing`, form sheet). The mini player sits in the native tab bar's bottom accessory (iOS 26+).

## Run on the simulator

Start the stack from the repo root with `corepack pnpm dev` (API on port 8787, see the root README). Then:

```sh
cd apps/mobile
npx expo prebuild --platform ios    # writes ios/ (git-ignored)
xcodebuild -workspace ios/Fama.xcworkspace -scheme Fama -sdk iphonesimulator \
  -destination id=<simulator-udid> -derivedDataPath ios/build build
xcrun simctl install <simulator-udid> ios/build/Build/Products/Debug-iphonesimulator/Fama.app
corepack pnpm start                 # Metro for the dev client
```

In the app, open Settings and enter `http://localhost:8787` and the `FAMA_API_TOKEN` from `apps/api/.dev.vars` (`dev-api-token` by default). On a phone, use the Mac's LAN address instead, for example `http://192.168.0.5:8787`.

`corepack pnpm typecheck` runs `tsc`.

## Audio: a local Swift module, not expo-audio or react-native-track-player

`modules/fama-player` is a small Expo module (`EpisodePlayer.swift`, `FamaPlayerModule.swift`). It plays an episode's chapters as one timeline on an `AVQueuePlayer`.

What was checked against SDK 58:

- **react-native-track-player**: last stable release 4.1.2 (August 2025); 5.0 is an alpha. Nothing released targets React Native 0.88 and the New Architecture only. Too risky for the core of the app.
- **expo-audio 58.0.11** (what t3code uses) is close. It has `AudioPlaylist` on `AVQueuePlayer`, lock-screen metadata and artwork, skip intervals, scrubbing, and `add()` for growing playlists. Three gaps decided it:
  - `setPlaybackRate` clamps to 2.0. Fama offers 0.75 to 3×.
  - The audio session uses mode `.default`. Spoken audio wants `.spokenAudio`, so navigation prompts pause the narration instead of talking over it.
  - The lock screen shows one chapter at a time. Fama shows the whole episode on one scrubber, with the chapter title and number.

The module does:

- Session: `.playback`, mode `.spokenAudio`, route-sharing policy `.longFormAudio` (the Podcasts and Books policy, good for AirPlay). `UIBackgroundModes: audio`.
- Seamless chapter-to-chapter playback; `AVQueuePlayer` preloads the next chapter.
- Positions in and out are episode seconds. Seeks across chapter boundaries rebuild the queue. Quick repeated skips build on the pending seek target, not on the stale clock.
- Chapters that arrive while the job runs append to the queue. When playback ran out of chapters, it resumes on the next one.
- Now Playing: chapter title, episode title, artwork (the cover, else a generated tile), episode-wide elapsed time and duration, chapter number and count, rate.
- Remote commands: play, pause, toggle, skip forward 30, skip back 15, scrub, rate. Headphone next and previous track map to the skips, like Podcasts.
- Interruptions resume when iOS says `shouldResume`. Unplugged headphones pause.
- Time pitch `.timeDomain`, which suits speech and stays cheap at 3×.
- `RouteButton`: the system `AVRoutePickerView` for AirPlay and Bluetooth.

JS side (`src/player`): one module-level store fed by the native `onStatus` event. It saves the position per episode to `positions.json` (every 5 s, on pause and at the end) and the speed and last episode to `player.json`. On launch the last episode loads paused, so the mini player is there. Downloaded chapters play from local files.

## Share extension: expo-sharing

`expo-sharing` 58 ships a share extension through its config plugin. It is first party, maintained for SDK 58, and what t3code uses. The extension saves the shared item to the App Group and opens `fama://expo-sharing`. The app shows the confirm sheet (`src/app/expo-sharing.tsx`) with voice and speed, then posts it.

The activation rule accepts links, plain text, PDF and EPUB only. `plugins/withShareExtensionDisplayName.cjs` names the extension "Fama" in the share sheet.

## Layout

- `src/app`: routes. `(tabs)` holds Library, Add and Settings, each in a native stack with a large title.
- `src/lib`: API client (decodes with `@fama/contracts`), settings (server URL and token in `expo-secure-store`), library provider (polls every 3 s while a job is Queued or Running, caches the last list for offline), downloads (`expo-file-system`, `Documents/episodes/<id>/<index>.m4a`).
- `src/player`: native binding, store, sync with the library.
- `src/components`: rows, mini player, scrubber, artwork, pickers.
