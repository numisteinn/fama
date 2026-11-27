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

## Self-host

Put Fama on your own Cloudflare account: one Worker (API, feed and web app), one D1 database and one R2 bucket. `infra/` holds the [Alchemy](https://alchemy.run) stack. `infra/README.md` has the details.

You need a Cloudflare account and [mise](https://mise.jdx.dev).

```sh
mise install
pnpm install
pnpm --filter @fama/infra exec alchemy profile edit --add Cloudflare   # log in once
pnpm fama setup --stage home
```

`--stage` names the deployment. Use lowercase letters, digits and hyphens, and use the same name each time. Setup shows the plan and asks before it changes anything.

The first run prints the server URL, the client token, the worker token, the worker start command and a QR code. Scan the QR code with the iPhone camera to connect the app, or enter the server URL and client token in Settings. Copy the tokens: setup does not show them again. Run `pnpm fama setup --stage home` again after a pull to update the deployment. A rerun keeps the user and the tokens.

Start a worker with the worker token. On a Mac:

```sh
cd worker && uv sync
uv run fama work --api <server URL> --token <worker token>
```

For Docker or Modal, see `worker/README.md`.

To remove the deployment and all its data:

```sh
pnpm --filter @fama/infra exec alchemy destroy --stage home
```

## Parts

| Path | What |
|---|---|
| `packages/contracts` | The HTTP contract as Effect Schema. `docs/api.md` is the same contract in words. |
| `infra` | Alchemy stack and `fama setup` for a self-hosted deployment. |
| `apps/api` | Cloudflare Worker: API, D1, R2, RSS feed. |
| `apps/web` | Vite + Effect UI web app (The Elm Architecture on Effect). |
| `apps/mobile` | Expo iOS app. |
| `worker` | Python worker: extraction and TTS. |

`CONTEXT.md` defines the terms.
