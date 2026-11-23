# Two paths: DIY and managed

Status: accepted, 2026-11-23.

## Goal

Fama serves two kinds of users from one codebase.

- **DIY.** A technical user runs everything on their own infrastructure. One command deploys the open-source stack to their Cloudflare account. Phone and web sync through it.
- **Managed.** A paying user gets a hosted service. An episode shows up on the phone with no setup. Listening progress syncs between phone and web.

The managed service is the DIY stack, run by us, plus accounts, billing and a cloud worker fleet. The business logic has no `if (managed)` branch. The two paths differ only at the auth boundary (how a request becomes a user) and in deploy config.

We build both paths now. We do not ship the managed path yet. There are no users, so breaking changes to the schema, the contract and stored data are allowed.

## Decisions

Reviewed by two other model families on 2026-11-23 (Codex gpt-6.2-sol, Gemini 4 Argon). Both agreed with the direction and asked for the tighter rules that are now part of the text below.

### D1. Every row has an owner

- New table `users (id, feed_token UNIQUE, created_at)`.
- `episodes.user_id` is NOT NULL. Client and feed queries filter by it. The index becomes `(user_id, created_at DESC)`.
- Worker queries do not filter by user. They are scoped to the claimed episode and return its `user_id`, so the routes can build R2 keys.
- R2 keys start with `users/<userId>/`.
- Delete checks the owner in D1 before it removes any media.
- A DIY server has exactly one user, made at setup.

### D2. Credentials

- **Client tokens** live in `tokens (hash PRIMARY KEY, user_id, created_at)`. Only the SHA-256 hash of a high-entropy random token is stored. `Bearer` token to `{ userId }` is the one auth boundary for `/api/*` client routes.
- **Feed token** is a capability URL, so the server must be able to print it again. It is stored in plain text on `users.feed_token`. It opens only `/feed/<token>/...` and `/media/<token>/...`, never `/api/*`. `POST /api/feed/rotate` replaces it.
- `/media/<token>/<key>` reads only `users/<userId>/episodes/...`. It rejects `..` and `uploads/`.
- `GET /api/me` returns `{ userId, apiVersion }`. Clients key their caches, downloads and pending writes by server and user.
- DIY: setup creates the user and tokens and prints them once. Managed (later): a sign-in flow mints a client token per device.
- `FAMA_API_TOKEN` and `FAMA_FEED_TOKEN` env secrets go away. Local dev and verify-fama seed a dev user and dev tokens into local D1.

### D3. Workers get their own credential

- `/api/worker/*` has its own guard, `FAMA_WORKER_TOKEN` (env secret). Workers claim jobs across all users.
- `claim` returns a random `leaseToken` for that attempt. Every job route needs it, the source read included. `workerId` stays for diagnostics.
- The job queue stays one D1 table, oldest first. Fairness and quotas come later, with billing.

### D4. Progress sync

- New table `progress (user_id, episode_id REFERENCES episodes ON DELETE CASCADE, position_ms, updated_at, PRIMARY KEY (user_id, episode_id))`.
- `PUT /api/episodes/:id/progress` with `EpisodeProgress { positionMs, updatedAt }`. It returns `200 EpisodeProgress`, the stored value. The newest `updatedAt` wins. The server clamps a future `updatedAt` to its own clock. The client always adopts the response, so a clamped stamp does not stay on the device.
- `Episode` gains `progress: EpisodeProgress | null`.
- Positions are whole-episode milliseconds on every client. A finished episode stores the total length (not 0). `FINISHED_MARGIN_MS = 3000` lives in the contract. Replay of a finished episode starts at 0.
- Clients store `{ positionMs, updatedAt }` locally. On library load they push every local entry that is newer than the server's, so offline listening syncs without a replay.
- A passive load (app start, no play) does not stamp a new `updatedAt`.

### D5. Cloud worker, woken by the API

- The worker stays pull-based. `fama work --drain` loops until `claim` returns nothing. (`--once` stops after one job.)
- Optional env `WORKER_WAKE_URL` and `WORKER_WAKE_SECRET`. After a create, upload or retry commits, the API calls the URL through `ctx.waitUntil` with a short timeout. A failed wake is logged only.
- `worker/modal_app.py`: one dispatcher used by the wake endpoint and by a 5-minute cron. It caps concurrent runs and drains the queue. The cron also picks up expired leases.
- DIY users pick: Mac worker, Docker, or their own Modal app.

### D6. Infra as code with Alchemy

- `infra/` holds an Alchemy v2 stack: Worker, D1, R2, secrets. One stage per deployment.
- `pnpm fama setup` (DIY) is safe to rerun: provision storage, run migrations, create the one user only if none exists, publish the API, print the client token, the worker token and the worker start command, and show the QR code.
- `wrangler.jsonc` stays for local dev and verify-fama.
- Prove setup on a fresh stage first. The existing production deployment holds only test data in the old key layout, so adoption resets its data. That needs the owner's approval.

### D7. One phone app, two ways in

- "Use your own server": the setup QR code is `fama://connect?server=<url>&token=<token>`, which the iOS Camera opens. Manual entry stays. The app checks `GET /api/me` before it switches.
- Default sign-in to the managed service comes later.

## Deferred (managed only, needs decisions or a paid Apple account)

- Sign-in method. Default when built: Sign in with Apple plus email link.
- Billing, quotas, per-user fairness in the queue.
- Signed per-asset media URLs, upload keys per claim attempt, and a stable claim request ID (from the Codex review). They matter for a shared fleet with real users.
- Push notification on Ready and background download. Until then the app refreshes on open, and the private feed in Apple Podcasts auto-downloads.
- PyMuPDF is AGPL. Replace it (for example `pypdfium2`) or relicense before charging.
- GPU cost per hour of audio is not measured. Measure on Modal before pricing.
- Copyright exposure of hosting narrated uploads. Needs legal advice before launch.

## Build order

1. Ownership, credentials, leases and media keys together (D1, D2, D3), with the dev scripts, the smoke script and verify-fama in the same step.
2. Progress sync in API, web and mobile (D4).
3. Worker drain, wake hook and the Modal app (D5).
4. Alchemy stack and `fama setup` (D6), proven on a fresh stage.
5. QR pairing in the phone app (D7).

Each step ends with tests and a verify-fama run on the local server. Nothing touches production without approval.

## Alternatives rejected

- **One Durable Object per user.** Clean isolation and live sync, but the job queue is global, so it needs a second store anyway. D1 with `user_id` is the smaller change.
- **Keep env tokens for DIY, add accounts only for managed.** Two auth paths to test, and the fork leaks into every handler.
- **Push jobs to workers.** A Mac behind NAT cannot take a push. Pull plus a wake call covers both.
- **Progress conflicts by revision number, with a prompt to the listener.** Correct against bad clocks, but a prompt is heavy for one listener. The clamp plus adopting the server response covers the fast-clock case.
