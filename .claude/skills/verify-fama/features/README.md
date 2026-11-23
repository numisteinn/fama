# Fama verification map

This directory is the maintained source for verifying the user-facing behavior of Fama. Read the index before you drive the app, then use the matching feature file as the recipe. `../SKILL.md` has the launch, doctor, handles and cleanup.

## Baseline preconditions

- Run `fama-verify up` from the repo root. Each run starts from an empty library on `http://localhost:8788`, owned by the seeded user `dev-user` (client token `dev-api-token`, feed token `dev-feed-token`). The worker uses `dev-worker-token`.
- Run `fama-verify doctor`. It must print `healthy`, and the build commit must match the current commit.
- Web: a T3 preview tab you opened on port 8788, with `dev-api-token` saved in Settings.
- iPhone: `fama-verify metro`, `dev.fama.app` opened with `agent-device`, `Server URL` set to `http://localhost:8788` (old value recorded), status `Connected`.
- Sources come from the fixture server (`http://localhost:8790/...`) or from `.claude/skills/verify-fama/fixtures/`. Never use the deployed server, and never the user's instance on 8787.

## Driving conventions

- Web actions go through `preview_act` with role and accessible-name locators. iPhone actions go through the `agent-device` path from `device_open`, with `label="…"` selectors or `@eN` refs from the last `snapshot -i`.
- On iPhone, never use `fill` on a text field. It opens the Expo developer menu and the text does not change. Focus the field with `press`, delete with `press 'label="delete"' --count <n>`, and append with `type`.
- Wait on a visible state (`preview_wait_for` with a locator, or `fama-verify wait <id>`), never a fixed sleep.
- Each journey adds its own episodes. Do not delete episodes another journey needs. `down` throws away the whole state.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- Every mutation gets a second, read-only view: `fama-verify api GET /api/episodes/<id>` or `fama-verify wait <id>`, saved to the evidence dir.
- Audio proof is real bytes: a `206` with `Content-Type: audio/x-m4a` for the chapter or book URL, and `ffprobe` reading a duration.
- Record the feature ID, the surface (web or iPhone) and the entry point with every artifact.
- When a path cannot be reached (for example, no file in the simulator's Files app), report the attempted command and the unmet precondition. Do not report it as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph that describes the user-visible behavior. It then has exactly four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with preview tools and agent-device`, `Gotchas`.

## Features

- [Add a link](./add-link.md): paste a web article link on the web or the iPhone, and get a narrated episode with the real title, the detected language and the default voice.
- [Add a file](./add-file.md): attach a PDF, EPUB, Markdown or text file, and get one chapter for each table-of-contents entry.
- [Playback](./playback.md): play an episode on the web or the iPhone, skip, scrub, change speed, change chapters, download.
- [Private feed](./private-feed.md): the feed URL from Settings serves RSS with one item for each ready episode and streamable book files.
- [Worker makes an episode](./worker-episode.md): the job moves from Queued through Running to Ready, chapters appear while it runs, and failures show a plain reason with Retry.
