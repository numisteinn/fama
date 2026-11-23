# infra

The [Alchemy](https://alchemy.run) v2 stack that puts Fama on a Cloudflare account, and `fama setup`, which deploys it. Design: decision D6 in `../docs/design/two-paths.md`. Alchemy background: `../.audit/alchemy-research.md`.

Alchemy is pinned to `2.0.0-beta.87`. Read its `CHANGELOG.md` before a bump: the state format carries a version, and a newer one locks out older CLIs.

## What one stage makes

One stage is one deployment.

| Resource | Alchemy id | Name on stage `home` | Name on stage `prod` |
|---|---|---|---|
| Worker: API, feed, media, web build as static assets | `Api` | `fama-home` | `fama` |
| D1 database, migrations from `apps/api/migrations` | `DB` | `fama-home` | `fama` |
| R2 bucket | `Media` | `fama-home-media` | `fama-media` |
| Worker token, 32 random bytes as hex | `WorkerToken` | (state only) | (state only) |

- `prod` keeps the names of the deployment made before Alchemy, so Alchemy adopts it in place. All three `prod` resources have `RemovalPolicy.protect`: a plan that would replace or delete one fails before it changes anything.
- Every other stage puts the stage in each name. So a stage never adopts another stage's database or bucket.
- `alchemy destroy` empties the bucket on every stage except `prod`.
- The Worker settings in `src/worker-config.ts` mirror `apps/api/wrangler.jsonc`. `src/worker-config.test.ts` fails when they drift apart.

Worker secrets:

- `FAMA_WORKER_TOKEN`: the `WorkerToken` value. It is made once and stays the same on every rerun.
- `WORKER_WAKE_URL` and `WORKER_WAKE_SECRET` (optional, D5): read from the environment or `infra/.env` on each deploy. Set both or neither. A deploy without them removes them from the Worker, so keep them in `infra/.env` (git-ignored).

## State

The stack keeps its state in a Cloudflare state store in the same account (`Cloudflare.state()`). Secrets in it are encrypted at rest. So the worker token never lands in a local file, and a rerun from another machine finds the same deployment.

The first plan or deploy on an account creates the store, once: a Worker `alchemy-state-store` with a Durable Object, and a Secrets Store with its key and bearer token. Every stage and stack on the account shares it. Alchemy caches the bearer token in `~/.alchemy/profiles/<profile>/state-stores/cloudflare.json`.

## Commands

Run from the repo root:

```sh
pnpm --filter @fama/infra exec alchemy profile edit --add Cloudflare   # log in once
pnpm fama setup --stage <name>             # build web, deploy, make the user, print tokens and QR
pnpm fama setup --stage <name> --yes       # same, without the approval prompt
pnpm --filter @fama/infra plan:offline     # plan with local providers and in-memory state: no account, no changes
pnpm --filter @fama/infra exec alchemy plan --stage <name>      # read-only plan against the account
pnpm --filter @fama/infra exec alchemy destroy --stage <name>   # delete the stage and its data
```

Instead of a profile, Alchemy also takes `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` from the environment or `infra/.env`.

`fama setup` steps, all safe to rerun:

1. Build `apps/web`.
2. Plan the stage, show the plan, and ask to apply it (no prompt when nothing changes). Alchemy applies the D1 migrations as part of the deploy. It keeps its own history table, `__alchemy_migrations`.
3. Count the users in D1. With none, make one (the SQL from `apps/api/scripts/create-user.ts`) and print the server URL, the client token, the worker token, the worker start command and a `fama://connect?server=<url>&token=<client token>` QR code. With one or more, print the server URL and the worker start command, and no token.

Tokens go to stdout only. `fama setup` writes no log file. The plain `alchemy` CLI writes run logs to `infra/.alchemy/log/` (git-ignored).

## Rules

- `apps/api/wrangler.jsonc` stays for `pnpm dev` and verify-fama. Never run `wrangler deploy` or `wrangler d1 migrations apply --remote` against a stage Alchemy manages. Wrangler does not see `__alchemy_migrations` and could run migrations again.
- `alchemy dev` does not work with this stack yet. Its workerd supports compatibility dates up to `2026-11-02`, and the Worker uses `2026-11-18`. Use `pnpm dev`.
- Never run `alchemy dev --stage prod`. A switch between local and live plans a replacement.

## First deploy: runbook for the owner

Each step that changes the account needs the owner's approval.

### 1. A fresh stage

```sh
pnpm install
pnpm --filter @fama/infra exec alchemy profile edit --add Cloudflare
pnpm fama setup --stage trial
```

Expect a plan with 4 creates (`DB`, `Media`, `WorkerToken`, `Api`). On the first run on the account, the state store is created first. Then:

- Open the server URL. Enter the client token in Settings.
- Run a worker with the printed command and make an episode.
- Run `pnpm fama setup --stage trial` again. Expect "no changes", "The user exists" and no token.
- Remove the stage when done: `pnpm --filter @fama/infra exec alchemy destroy --stage trial`.

### 2. Adopt prod

The prod D1 still has the schema from before users, and `0001_init.sql` has changed since prod applied it. Adoption therefore resets prod's data (D6). Prod holds test data only, but the reset needs the owner's approval.

1. Read-only checks with `cf`: the location, CORS, lifecycle rules and custom domains of R2 `fama-media`; the location of D1 `fama`; the bindings, flags and secrets of the Worker `fama`. The stack declares no location hints, CORS, lifecycle rules or domains. A real value for any of these shows as a change or a replace in step 3.
2. Reset prod D1 `fama` (destructive): drop every table, `d1_migrations` included. Leave the database, so its id stays. Old R2 objects outside `users/` are unreachable after the switch. Delete them or leave them.
3. Plan, read-only:

   ```sh
   pnpm --filter @fama/web build
   cd infra && pnpm exec alchemy plan --stage prod --adopt
   ```

   Expect `DB`, `Media` and `Api` as adopted updates and `WorkerToken` as a create (it is state only). Any other create, any delete and any replace is a stop.
4. Deploy and make the user:

   ```sh
   pnpm fama setup --stage prod --adopt
   ```

   The Worker gets a new `FAMA_WORKER_TOKEN` (the printed worker token). Restart the Mac worker with it. Secrets set earlier with `wrangler secret put` that the stack does not declare stay bound. Delete them with `cf` if you no longer want them.

After the first prod deploy, the Worker carries Alchemy's tags. Later deploys need no `--adopt`.
