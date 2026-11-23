# Fama iOS app

Expo SDK 58, React Native 0.88, expo-router. Dark only, DM Sans, one accent. Bundle id `dev.fama.app`.

Screens: Library (tab), Add (tab), Settings (tab), Player (modal), share confirm (`fama://expo-sharing`, form sheet). The mini player sits in the native tab bar's bottom accessory (iOS 26+).

## Run on the simulator

Start the stack from the repo root with `pnpm dev` (API on port 8787, see the root README). Then:

```sh
cd apps/mobile
npx expo prebuild --platform ios    # writes ios/ (git-ignored)
xcodebuild -workspace ios/Fama.xcworkspace -scheme Fama -sdk iphonesimulator \
  -destination id=<simulator-udid> -derivedDataPath ios/build build
xcrun simctl install <simulator-udid> ios/build/Build/Products/Debug-iphonesimulator/Fama.app
pnpm start                 # Metro for the dev client
```

In the app, open Settings and enter `http://localhost:8787` and the dev client token `dev-api-token` (`pnpm dev` seeds it). On a phone, use the Mac's LAN address instead, for example `http://192.168.0.5:8787`.

`pnpm typecheck` runs `tsc`. `pnpm test` runs the pure modules (`*.test.ts`) in Vitest.

## Connect with a QR code

`pnpm fama setup` prints a QR code for `fama://connect?server=<url>&token=<client token>` (D7). The iOS Camera opens it in the app. Manual entry in Settings stays.

- `src/app/+native-intent.tsx` takes the link before the router (`routeSystemPath` in `src/lib/pairing.ts`). The token never goes into navigation state or history. The parsed link waits in memory until `PairingHandler` takes it, once.
- The link is parsed by `parseConnectLink` in `@fama/contracts`, the same module that builds it for `fama setup`. The server must be `https`, or `http` on a local host: `localhost`, loopback, private and link-local IPv4, the Tailscale range `100.64.0.0/10`, IPv6 loopback and unique-local, a single-label name, `.local` or `.home.arpa`. No user name, query or fragment.
- `PairingHandler` (`src/lib/PairingHandler.tsx`) calls `GET /api/me` on that server with that token. Only on success does it save the server, the token and the user, and open the Library, which loads that user's episodes.
- Nothing connected, or the same server and user: it connects at once. Another server or user: it asks once, "Switch account?". Cancel keeps the current connection.
- A bad link or a refused token shows "Could not connect" with the reason. The current connection stays. The app never logs the link or the token.
- When the link launches the app cold, the router opens `/` (the Library) and the check runs once settings are read. This is unit tested only: in a debug dev client the dev launcher takes the launch URL, so test with the app already running.

To try it on the simulator: `xcrun simctl openurl booted 'fama://connect?server=http%3A%2F%2Flocalhost%3A8787&token=dev-api-token'`.

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
- `src/lib`: API client (decodes with `@fama/contracts`), settings (server URL and token in `expo-secure-store`), pairing (QR connect link), library provider (polls every 3 s while a job is Queued or Running, caches the last list of each account for offline), downloads (`expo-file-system`, `Documents/accounts/<account>/episodes/<id>/<index>.m4a`). An account is a server plus the user from `GET /api/me`, so two accounts on one server never share a cache or a download.
- `src/player`: native binding, store, sync with the library.
- `src/components`: rows, mini player, scrubber, artwork, pickers.
