# Fama

Send a link, file or text from your iPhone or the web, and get narrated audio (English and Icelandic) to play offline or in your podcast app.

## Run it

You need [mise](https://mise.jdx.dev) and ffmpeg (`brew install ffmpeg`). `mise.toml` pins Node, pnpm and uv.

```sh
mise install
pnpm install
(cd worker && uv sync)
pnpm dev
```

`pnpm dev` starts three processes. Ctrl-C stops all of them.

- `api`: `wrangler dev` with local D1 and R2 on port 8787, on every network interface. It also serves the web app.
- `web`: the web build in watch mode.
- `worker`: `fama work`, the Mac worker. It pulls jobs from the API and narrates them.

The first run copies `apps/api/.dev.vars.example` to `apps/api/.dev.vars`. That file holds the API token (`dev-api-token`) and the feed token.

Open http://localhost:8787, open Settings, and enter the API token.

## iPhone app

Build and install the app as `apps/mobile/README.md` says. In the app, open Settings:

- Server: `http://localhost:8787` on the simulator. On a phone on the same Wi-Fi, the Mac's LAN address, for example `http://192.168.0.5:8787`. `wrangler dev` prints it at start.
- API token: `FAMA_API_TOKEN` from `apps/api/.dev.vars`.

## Deploy

The API and web app run as one Cloudflare Worker with D1 and R2. To deploy your own:

```sh
cd apps/api
npx wrangler d1 create fama            # put the id in wrangler.jsonc
npx wrangler r2 bucket create fama-media
npx wrangler d1 migrations apply DB --remote
pnpm --filter @fama/web build
npx wrangler deploy --secrets-file <file>   # JSON: {"FAMA_API_TOKEN": "...", "FAMA_FEED_TOKEN": "..."}
```

Then point the Mac worker at it:

```sh
cd worker && uv run fama work --api https://<your-worker>.workers.dev --token <FAMA_API_TOKEN>
```

## Parts

| Path | What |
|---|---|
| `packages/contracts` | The HTTP contract as Effect Schema. `docs/api.md` is the same contract in words. |
| `apps/api` | Cloudflare Worker: API, D1, R2, RSS feed. |
| `apps/web` | Vite + Foldkit web app (The Elm Architecture on Effect). |
| `apps/mobile` | Expo iOS app. |
| `worker` | Python worker: extraction and TTS. |

`CONTEXT.md` defines the terms.
