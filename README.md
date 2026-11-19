# Fama

Send a link, file or text from your iPhone or the web, and get narrated audio (English and Icelandic) to play offline or in your podcast app.

## Run it

You need Node 24, [uv](https://docs.astral.sh/uv/) and ffmpeg (`brew install ffmpeg`).

```sh
corepack pnpm install
(cd worker && uv sync)
corepack pnpm dev
```

`corepack pnpm dev` starts three processes. Ctrl-C stops all of them.

- `api`: `wrangler dev` with local D1 and R2 on port 8787, on every network interface. It also serves the web app.
- `web`: the web build in watch mode.
- `worker`: `fama work`, the Mac worker. It pulls jobs from the API and narrates them.

The first run copies `apps/api/.dev.vars.example` to `apps/api/.dev.vars`. That file holds the API token (`dev-api-token`) and the feed token.

Open http://localhost:8787, open Settings, and enter the API token.

## iPhone app

Build and install the app as `apps/mobile/README.md` says. In the app, open Settings:

- Server: `http://localhost:8787` on the simulator. On a phone on the same Wi-Fi, the Mac's LAN address, for example `http://192.168.0.5:8787`. `wrangler dev` prints it at start.
- API token: `FAMA_API_TOKEN` from `apps/api/.dev.vars`.

## Parts

| Path | What |
|---|---|
| `packages/contracts` | The HTTP contract as Effect Schema. `docs/api.md` is the same contract in words. |
| `apps/api` | Cloudflare Worker: API, D1, R2, RSS feed. |
| `apps/web` | Vite + React web app. |
| `apps/mobile` | Expo iOS app. |
| `worker` | Python worker: extraction and TTS. |

`CONTEXT.md` defines the terms.
