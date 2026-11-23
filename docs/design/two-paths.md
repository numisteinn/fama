# Two paths: DIY and managed

Status: proposed, 2026-11-23. Under review.

## Goal

Fama serves two kinds of users from one codebase.

- **DIY.** A technical user runs everything on their own infrastructure. One command deploys the open-source stack to their Cloudflare account. Phone and web sync through it.
- **Managed.** A paying user gets a hosted service. An episode shows up on the phone with no setup. Listening progress syncs between phone and web.

The managed service is the DIY stack, run by us, plus accounts, billing and a cloud worker fleet. The business logic has no `if (managed)` branch. The two paths differ only at the auth boundary (how a request becomes a user) and in deploy config.

We build both paths now. We do not ship the managed path yet. There are no users, so breaking changes to the schema, the contract and stored data are allowed.

## Decisions

### D1. Every row has an owner

- New table `users (id, created_at)`.
- `episodes.user_id` is NOT NULL. Every query in `episode-repo.ts` filters by it.
- R2 keys start with `users/<userId>/`.
- A DIY server has exactly one user, made at setup.

### D2. Credentials live in the database, not in env secrets

- New table `tokens (hash, user_id, kind, created_at)`, `kind` in `client | feed`. Only the SHA-256 hash is stored.
- The auth boundary is one function: bearer token to `userId`. `/feed/<token>/...` and `/media/<token>/...` resolve a `feed` token to a `userId` the same way.
- DIY: setup creates the user and both tokens and prints them once (and as a QR code for the phone).
- Managed (later): a sign-in flow mints a `client` token per device. Nothing else changes.
- `FAMA_API_TOKEN` and `FAMA_FEED_TOKEN` env secrets go away. Local dev seeds the dev tokens into local D1.

### D3. Workers get their own credential

- Today the worker uses the user's `FAMA_API_TOKEN`. A managed worker fleet serves all users, so it must not hold a user credential.
- `/api/worker/*` checks `FAMA_WORKER_TOKEN` (env secret). Workers claim jobs across all users.
- The job queue stays one D1 table. `claim` stays oldest-first. Per-user fairness and quotas come later, with billing.

### D4. Progress sync

- New table `progress (user_id, episode_id, position_ms, updated_at, PRIMARY KEY (user_id, episode_id))`.
- `PUT /api/episodes/:id/progress` with `{ positionMs, updatedAt }`. `updatedAt` is the device clock at the time of listening.
- The newest `updatedAt` wins. The server clamps a future `updatedAt` to its own clock. An older write is dropped and the response returns the stored value.
- `Episode` gains `progress: { positionMs, updatedAt } | null`, so the library list carries it. No separate fetch.
- Clients keep their local copy for offline use. They send while playing (every 5 s of movement, on pause, on background) and merge by `updatedAt` when the library loads.

### D5. Cloud worker, woken by the API

- The worker stays pull-based. `fama work --once` already drains the queue and stops.
- Optional env `WORKER_WAKE_URL` (plus a secret). When an episode becomes `Queued` (create or retry), the API calls it in `ctx.waitUntil`. A failed wake is logged, not an error for the client.
- `worker/modal_app.py`: a Modal app with a GPU function that runs `fama work --once`, a web endpoint that spawns it, and a cron every 5 minutes as the fallback. Scales to zero.
- DIY users pick: Mac worker, Docker, or their own Modal app. All run the same package.

### D6. Infra as code with Alchemy

- `infra/` holds an Alchemy v2 stack: Worker, D1, R2, secrets. One stage per deployment.
- `pnpm fama setup` (DIY): deploy, run migrations, create the user and tokens, print the QR code.
- `wrangler.jsonc` stays for local dev (`wrangler dev`) and for verify-fama.
- The existing production deployment is adopted (`alchemy plan --stage prod --adopt` first). That first deploy is one way and needs the owner's approval.

### D7. One phone app, two ways in

- Default: sign in to the managed service (later).
- "Use your own server": scan the setup QR code or paste URL and token. This is what the app does today.

## Deferred (managed only, needs decisions or a paid Apple account)

- Sign-in method. Default when built: Sign in with Apple plus email link.
- Billing, quotas, per-user fairness in the queue.
- Push notification on Ready and background download. Until then the app refreshes on open, and the private feed in Apple Podcasts auto-downloads.
- PyMuPDF is AGPL. Replace it (for example `pypdfium2`) or relicense before charging.
- GPU cost per hour of audio is not measured. Measure on Modal before pricing.
- Copyright exposure of hosting narrated uploads. Needs legal advice before launch.

## Build order

1. Schema and auth: `users`, `tokens`, `user_id`, worker token (D1, D2, D3). One migration, contract and `docs/api.md` together.
2. Progress sync in API, web and mobile (D4).
3. Worker wake hook and the Modal app (D5).
4. Alchemy stack and `fama setup` (D6).
5. QR pairing in the phone app (D7).

Each step ends with tests and a verify-fama run on the local server. Nothing touches production without approval.

## Alternatives rejected

- **One Durable Object per user.** Clean isolation and live sync, but the job queue is global, so it needs a second store anyway. D1 with `user_id` is the smaller change.
- **Keep env tokens for DIY, add accounts only for managed.** Two auth paths to test, and the fork leaks into every handler.
- **Push jobs to workers.** A Mac behind NAT cannot take a push. Pull plus a wake call covers both.
