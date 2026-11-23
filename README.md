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

The first run copies `apps/api/.dev.vars.example` to `apps/api/.dev.vars`. That file holds the worker token (`FAMA_WORKER_TOKEN=dev-worker-token`). Each run also seeds a dev user into local D1, with the client token `dev-api-token` and the feed token `dev-feed-token`.

Open http://localhost:8787, open Settings, and enter the client token `dev-api-token`.

If `pnpm dev` says `no such table: users`, your local D1 has the schema from before users. Delete `apps/api/.wrangler/state/v3/d1` (local test data only) and run it again.

## iPhone app

Build and install the app as `apps/mobile/README.md` says. In the app, open Settings:

- Server: `http://localhost:8787` on the simulator. On a phone on the same Wi-Fi, the Mac's LAN address, for example `http://192.168.0.5:8787`. `wrangler dev` prints it at start.
- API token: `dev-api-token`.

## Deploy

The API and web app run as one Cloudflare Worker with D1 and R2. To deploy your own:

```sh
cd apps/api
npx wrangler d1 create fama            # put the id in wrangler.jsonc
npx wrangler r2 bucket create fama-media
npx wrangler d1 migrations apply DB --remote
pnpm --filter @fama/web build
npx wrangler deploy --secrets-file <file>   # JSON: {"FAMA_WORKER_TOKEN": "<random secret>"}
node scripts/create-user.ts -- --remote     # prints the user id, client token and feed token once
```

Enter the client token in the apps. Then point the Mac worker at it with the worker token:

```sh
cd worker && uv run fama work --api https://<your-worker>.workers.dev --token <FAMA_WORKER_TOKEN>
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
