# Alchemy v2 (2.0.0-beta.87) for Fama: research report

Scope: inspect only. No repo file changed. No Cloudflare API called.

Sources: shallow clone of `alchemy-run/alchemy` at
`/private/tmp/claude-501/-Users-numisteinn-Developer-fama/3f77f49e-a727-4d1c-bf3f-68ea9d1d95e1/scratchpad/alchemy-src`
(main `60d1eab`, 2026-11-19), plus the tag `v2.0.0-beta.87` fetched for a diff. The files cited below
are the same in beta.87 and main, or the diff does not touch the cited logic. The exceptions:
`DEFAULT_COMPATIBILITY_DATE` is `2026-08-31` in beta.87 (Fama sets its own date, so it does not
matter), and small `protect`-policy hardening in `Plan.ts`. Paths are relative to the clone.
Docs paths are `website/src/content/docs/...`. These pages are the source of https://alchemy.run.

Fama today (`apps/api/wrangler.jsonc`): Worker `fama`, `main: src/worker.ts`, compatibility date
`2026-11-18`, no flags, observability with traces, assets `../web/dist` with SPA fallback and
`run_worker_first: ["/api/*","/feed/*","/media/*"]`, D1 `DB` → `fama` (id `9ff2868d-…`,
`migrations_dir: migrations`, one file `0001_init.sql`), R2 `MEDIA` → `fama-media`, a `Data` rule for
`**/*.png` (`src/http.ts` does `import cover from "./cover.png"`). `src/worker.ts` is a plain
`export default { fetch }` that reads bindings through `import { env } from "cloudflare:workers"`
and builds an Effect `HttpRouter` web handler. `Env` comes from `wrangler types`
(`worker-configuration.d.ts`, which lists `FAMA_API_TOKEN` and `FAMA_FEED_TOKEN`).

---

## Short answers

| # | Question | Answer |
|---|---|---|
| 1 | Deploy `src/worker.ts` as is? | **Yes.** Alchemy has an "async Worker" form: `main: "./src/worker.ts"` plus `env: { DB, MEDIA, ... }`. No rewrite needed. The Effect form (`Cloudflare.Worker(id, props, Effect.gen(...))`) is optional. |
| 2 | Resource declarations | All expressible: `assets.{directory, notFoundHandling, runWorkerFirst}`, `D1.Database({ name, primaryLocationHint, migrations })`, `R2.Bucket({ name, locationHint })`, `observability`, `compatibility.date`, `workersDev`, `rules: [{ type: "Data", globs }]`. Snippet below. |
| 3 | Adoption | No per-resource id prop. Alchemy finds resources **by name**. D1 and R2 are adopted silently (no flag). The Worker reads as "Unowned" and needs `--adopt` once. Secrets set by wrangler stay in place if they are not declared in `env`. |
| 4 | State | Default `.alchemy/` local files (git-ignore). Or `Cloudflare.state()`: a state-store Worker + Durable Object + Secrets Store **that Alchemy creates in the account on first run**, even on `plan`. Stages isolate state and generated names. |
| 5 | Commands | `alchemy plan`, `alchemy deploy`, `alchemy destroy`, `alchemy dev`, with `--stage`, `--adopt`, `--yes`. Node works: `>=22.22.3 <23`, `>=24.11.1 <25`, or `>=25.1.0`. mise pins Node 24.18.0, which passes. Bun is not needed. |
| 6 | Local dev | Keep `wrangler dev` if you keep `wrangler.jsonc`. Alchemy does **not** emit a wrangler config. `alchemy dev` is its own workerd-based local runtime with D1/R2 simulators. It is a replacement, not a wrapper around wrangler. |
| 7 | Auth | Yes. If `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` are both set, they win over any profile, in CI or not. |
| 8 | Risks | See section 8. Top three: stage name collision silently adopts prod D1/R2 into a dev stage; D1 migration bookkeeping moves one way from `d1_migrations` to `__alchemy_migrations`; Alchemy adds `new_module_registry` and `ALCHEMY_*` vars to the Worker. |

---

## 1. Existing Worker entry as is, or rewrite?

**As is works.** `website/src/content/docs/cloudflare/compute/workers.mdx`, section "Async Workers":

> A Worker doesn't have to be an Effect program. Point `main` at a plain module, a classic
> `async fetch` handler or a prebuilt bundle from another tool, and declare bindings with the `env`
> prop. `InferEnv` derives the handler's env type from them.

```ts
export const Worker = Cloudflare.Worker("Worker", {
  main: "./src/worker.ts",
  env: { Uploads, DB },
});
export type WorkerEnv = Cloudflare.InferEnv<typeof Worker>;
```

Live example: `examples/cloudflare-worker-async/alchemy.run.ts` (async Worker with assets, D1, R2,
a `Config.Redacted` secret, a Queue and a DO).

Points that matter for Fama:

- `main` is bundled with **rolldown**, not esbuild (`Worker.ts` prop docs for `main` and `build`).
  `cloudflare:*` imports stay external
  (`packages/cloudflare-runtime/src/rolldown/plugins/cloudflare-externals.ts:15`,
  `filter: { id: /^cloudflare:/ }`). So `import { env } from "cloudflare:workers"` keeps working.
- The env key is the binding name. `env: { DB: db, MEDIA: media }` gives the same `DB` and `MEDIA`
  bindings that `bindings.ts` reads today.
- `Env` typing: keep `wrangler types` (needs `wrangler.jsonc` to stay), or switch to
  `Cloudflare.InferEnv<typeof Worker>`. `InferEnv` only lists what `env` declares. Secrets that
  stay unmanaged (see 3) would be missing from it.

**Effect form: what it buys.** `Cloudflare.Worker("Api", { main: import.meta.url }, Effect.gen(...))`
returns `{ fetch: HttpEffect }`. Bindings become Effect services declared where used:
`yield* Cloudflare.R2.ReadWriteBucket(Media)` with typed `R2Error`,
`yield* Cloudflare.D1.QueryDatabase(DB)`, `yield* Config.Redacted("FAMA_API_TOKEN")` for secrets
(`cloudflare/data/d1.mdx`, `cloudflare/security/secrets-env.mdx`).
`Cloudflare.Telemetry()` turns on traces and mirrors `Effect.withSpan` into the Cloudflare trace view
(`workers.mdx`, "Configure the Worker"). The HttpRouter app plugs in through
`HttpRouter.toHttpEffect` (`cloudflare/apis/effect-http-api.mdx`).

**Effect form: what it costs.** Rewrite `worker.ts`, `bindings.ts`, `episode-repo.ts` and
`media-store.ts` onto Alchemy's clients. The Worker code then depends on the Alchemy runtime bridge.
The Construction phase runs at plan time as well as at runtime, so it must stay pure. Alchemy
forces compatibility flags on Effect Workers (`Compatibility.ts`: refuses
`no_handle_cross_request_promise_resolution` and `disable_ctx_exports`). The vitest tests that build
`Bindings` by hand would change. Infra and app code become one program, so a beta break in Alchemy
reaches runtime code, not only deploy code.

**Recommendation:** adopt with the async form first. It changes no runtime code. Treat the Effect
form as a separate, later decision.

---

## 2. Resource declarations

Prop names verified in `packages/cloudflare/src/Workers/Worker.ts` (WorkerProps ~575–1070),
`Workers/Assets.ts:21–66`, `D1/Database.ts:39–126`, `R2/Bucket.ts:188–290` and `:675`.

```ts
// apps/api/alchemy.run.ts  (sketch: not written to the repo)
import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { RemovalPolicy, Stack } from "alchemy";
import { localState } from "alchemy/State/LocalState"; // or Cloudflare.state()
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "Fama",
  { providers: Cloudflare.providers(), state: localState() },
  Effect.gen(function* () {
    const { stage } = yield* Stack;
    const prod = stage === "prod";

    // Explicit names ONLY in prod. Other stages get generated names (see risk 8.1).
    const db = yield* Cloudflare.D1.Database("DB", {
      name: prod ? "fama" : undefined,
      primaryLocationHint: "weur",
      migrations: "./migrations",
    }).pipe(RemovalPolicy.protect(prod));

    const media = yield* Cloudflare.R2.Bucket("Media", {
      name: prod ? "fama-media" : undefined,
      locationHint: "weur",
    }).pipe(RemovalPolicy.protect(prod));

    const worker = yield* Cloudflare.Worker("Api", {
      name: prod ? "fama" : undefined,
      main: "./src/worker.ts",
      compatibility: { date: "2026-11-18" /* , flags: ["legacy_module_registry"] see 8.4 */ },
      observability: { enabled: true, traces: { enabled: true } },
      assets: {
        directory: "../web/dist",
        notFoundHandling: "single-page-application",
        runWorkerFirst: ["/api/*", "/feed/*", "/media/*"],
      },
      workersDev: true, // default; keeps fama.fama-api.workers.dev
      rules: [{ type: "Data", globs: ["**/*.png"] }],
      env: {
        DB: db,
        MEDIA: media,
        // Secrets: leave out to keep the wrangler-set values (see 3),
        // or manage them: FAMA_API_TOKEN: Config.Redacted("FAMA_API_TOKEN"), ...
      },
    }).pipe(RemovalPolicy.protect(prod));

    return { url: worker.url };
  }),
);
```

Notes per item:

- **Assets.** `Assets.ts:42` `htmlHandling`, `:52` `notFoundHandling: "none" | "404-page" |
  "single-page-application"`, `:66` `runWorkerFirst?: boolean | string[]`. The directory resolves from
  the CWD where `alchemy` runs (`Assets.ts:249` comment), so run it from `apps/api`. Alchemy does not
  build `apps/web`. Run `pnpm --filter web build` before deploy, as today. (A
  `Cloudflare.Website.Vite` / `StaticSite` resource could run the build, but that is a bigger change.)
- **D1.** `migrations?: MigrationsInput` takes a directory path. `primaryLocationHint` is
  replace-on-change (`Database.ts:51–58`). There is **no `databaseId` prop**. Identity is the name
  (see 3). A `lookup({ databaseId })` exists on the provider (`Database.ts:417`) for references, not
  for declared resources.
- **R2.** `locationHint?: Bucket.Location` (`"weur"` is valid, `Bucket.ts:675`). Changing it is a
  **replace** (`Bucket.ts` diff: `olds.locationHint !== news.locationHint`). `forceDestroy` is false by
  default, so a non-empty bucket cannot be deleted by Alchemy.
- **Secrets.** `env` entries that are `Config.Redacted(...)` or `Redacted` upload as `secret_text`
  (`Worker.ts` `env` prop docs). Values come from `.env` by default, or from a stack `secrets` provider
  (Doppler, Infisical) (`cloudflare/security/secrets-env.mdx`).
- **Observability.** `WorkerObservability` is the Cloudflare `PutScriptRequest.metadata.observability`
  type (`Worker.ts:74`). If omitted, the default is logs on and **traces off**
  (`Worker.ts` `observability` doc). So pass it in full to keep traces on.
- **workers.dev.** `workersDev?: boolean | { enabled, previewsEnabled }`, default `true`
  (`Worker.ts:638`). The URL stays `https://fama.<account-subdomain>.workers.dev` because the
  name stays `fama`.
- **Compatibility date.** `compatibility.date`. See 8.4 for the flags Alchemy adds.
- **`*.png` Data rule.** `rules?: ModuleRule[]` mirrors wrangler `rules` (`Worker.ts:1049` doc):
  "When Alchemy bundles main, rules add to the built-in ones … an imported file that matches is
  uploaded as a module instead of bundled." Globs are relative to `main`'s directory. `fallthrough`
  has no equivalent and is not needed. Other option: inline the PNG as base64 in a `.ts` module and
  drop the rule.

---

## 3. Adoption

Doc: `website/src/content/docs/cli/adopting-resources.mdx`. Engine:
`packages/alchemy/src/Plan.ts:1683–1796`.

When a resource has no state row, the engine calls the provider's `read`:

| `read` returns | without `--adopt` | with `--adopt` |
|---|---|---|
| `undefined` | create | create |
| plain attrs (owned) | silent adopt | silent adopt |
| `Unowned(attrs)` | fail `OwnedBySomeoneElse` | take over |

What each Fama resource returns:

- **D1** (`D1/Database.ts:442–480`): with no state, it lists databases **by name** and returns
  plain attrs. → **silent adopt, no flag.** The id `9ff2868d-…` gets picked up from the listing. You
  cannot pin it.
- **R2** (`R2/Bucket.ts:1653–1680`): `getBucket` by name, plain attrs. → **silent adopt.**
- **Worker** (`Workers/WorkerProvider.ts:5482`):
  `return hasAlchemyWorkerTags(id, settings.tags ?? []) ? attrs : Unowned(attrs);`. The wrangler-made
  `fama` has no `alchemy:stack/stage/id` tags. → **needs `--adopt` once.** After that deploy it
  carries the tags (`WorkerProvider.ts:2096–2098`), and later deploys or a state rebuild adopt silently.
- `--adopt` covers the whole run (one `AdoptPolicy` layer). `adopt(true)` from `alchemy/AdoptPolicy`
  can also be piped onto one resource.

After adoption the engine forces an **update**, not a no-op (`Plan.ts:2016–2027`,
`forceUpdateAfterAdoption`). The adopted state carries `props: news`, so `olds = news` in the
provider `diff`. That is why the replace checks (name, jurisdiction, location hint) do not fire on
the first deploy, as long as the declared values match the real ones. So the first
`deploy --stage prod --adopt` will:

1. **D1:** run the update path, which converts migration history. It copies wrangler's
   `d1_migrations` rows into a new `__alchemy_migrations` table, then applies pending files
   (none today). The old table stays frozen (`sql/effect-sql/migrations.mdx` "Adopting an existing
   database", `packages/sql/src/Migrations/Convert.ts:69,153–168`). **This is one write to the prod
   database (a new table).**
2. **R2:** update to the declared config. Undeclared `domains`, `lifecycleRules` and `cors` are
   compared as "empty" (`Bucket.ts` diff). Fama has none today, so nothing changes. Confirm first
   with a read-only `cf` check.
3. **Worker:** upload a new version built by rolldown, with Alchemy ownership tags, the declared
   bindings, and Alchemy's default flags and vars (8.4). That version goes to 100% of traffic.

**Secrets on first deploy.** `WorkerProvider.ts:4198–4224`:

> Cloudflare keeps a secret binding that a script upload omits, even with an empty `keep_bindings`,
> so a secret dropped from `env` would stay bound. Delete the secrets an earlier deploy uploaded and
> this one did not; secrets set outside Alchemy (`wrangler secret put`, the dashboard) are left alone.

Alchemy only deletes names in its own `secretNames` state. On adoption that list is empty
(`output` is `undefined`; the read sets `secretNames: output?.secretNames`, `:5467`).
So **leave `FAMA_API_TOKEN` and `FAMA_FEED_TOKEN` out of `env`, and they stay as they are.** If you
declare them as `Config.Redacted(...)`, the deploy **overwrites** them with the values in `.env` or
the secret provider, and Alchemy owns them from then on. Check the binding list after the first
deploy with a read-only `cf` call to confirm both secrets are still there. This rests on
Alchemy's comment, not on a test run.

---

## 4. State

Doc: `website/src/content/docs/state-store/index.mdx`.

- **Local** (`localState()` from `alchemy/State/LocalState`): `.alchemy/state/<Stack>/<stage>/<id>.json`.
  The doc says to git-ignore `.alchemy/`. Fama's `.gitignore` does not list it yet. `.alchemy/` also
  holds local dev data (`.alchemy/local/r2`, …) and run logs (`.alchemy/log/`). Commit nothing from it.
- **Cloudflare** (`Cloudflare.state()`): a Worker named `alchemy-state-store` + a Durable Object
  with SQLite + a Secrets Store with a bearer token and an encryption key. **The first `deploy`,
  `plan` or `dev` creates these in the account** ("First-run bootstrap"). In CI (`CI=true`) it fails
  instead, and you run `alchemy state bootstrap` once. Cached credentials go to
  `~/.alchemy/profiles/<profile>/state-stores/cloudflare.json`. One store serves every stack and stage
  in the account. `Cloudflare.state({ accountId })` pins the account.
- Losing local state is cheap for Fama. D1 and R2 adopt by name again with no flag. The Worker, once
  tagged, adopts silently. `--adopt` is needed only before the first tagged deploy.
- Plain secrets in state: a `Random` or `Redacted` output in state is plaintext unless a
  `StateEncryption` layer is given (`passphraseEncryption()` with `ALCHEMY_STATE_PASSPHRASE`, or AWS
  KMS). If FAMA secrets stay unmanaged, state holds no secrets.

**Stages** (`environments/stages.mdx`): `--stage` > `$ALCHEMY_STAGE` > `live_$USER` (deploy, plan,
destroy) or `dev_$USER` (dev). Each stage has its own state and its own **generated** names
(`${app}-${stage}-${id}`). Explicit `name:` values are the same in every stage, which is the 8.1
hazard. PR previews: `alchemy deploy --stage pr-<n> --yes`, then `alchemy destroy --stage pr-<n> --yes`.
Separately, `Worker.preview.of` gives Cloudflare Worker Previews (private beta,
`cloudflare/compute/previews.mdx`).

For a single-operator self-host, **local state is enough**. Choose `Cloudflare.state()` only if CI
deploys. Creating the store needs the operator's approval (it is a new Cloudflare resource).

---

## 5. Commands and runtime

Doc: `website/src/content/docs/cli/index.mdx`, `cli/plan.mdx`, `cli/deploy.mdx`, `cli/dev.mdx`.

```sh
cd apps/api
pnpm exec alchemy plan   --stage prod --adopt            # read-only preview (see caveat)
pnpm exec alchemy plan   --stage prod --adopt --detailed # declared props as YAML
pnpm exec alchemy deploy --stage prod --adopt            # first deploy; later drop --adopt
pnpm exec alchemy deploy --stage prod --yes              # non-interactive
pnpm exec alchemy destroy --stage pr-12 --yes
pnpm exec alchemy dev                                    # stage dev_$USER, local workerd
pnpm exec alchemy drift --stage prod                     # detect drift
pnpm exec alchemy state list                             # inspect state
```

- `plan` = `deploy --dry-run`. Plan building does not write state (`Plan.ts:1704–1712`, issue #793).
  The adoption `read` calls are GETs. **Caveat:** with `Cloudflare.state()`, the first `plan` bootstraps
  the state store, which creates resources. With `localState()`, `plan` makes only read calls.
- With no TTY, or when `CLAUDECODE` is set, the CLI runs in plain mode. It prints the plan and
  fails without applying unless `--yes` is given (`cli/index.mdx`, "The interactive TUI"). So an
  agent cannot deploy by accident without `--yes`.
- **Runtime:** `packages/alchemy/bin/cli.js` is `#!/usr/bin/env node`. It runs under Bun only if
  started by Bun. The Node gate is
  `">=22.22.3 <23.0.0-0 || >=24.11.1 <25.0.0-0 || >=25.1.0"` (`bin/cli.js` ~line 82).
  Node 24.18.0 (mise) and Node 26 both pass. `alchemy dev` uses `node --watch` with type
  stripping on supported Node (`cli/dev.mdx`).
- **Packages** (npm, beta.87, `latest` tag): `alchemy`, `@alchemy.run/cloudflare`,
  `@effect/platform-node`. Peer `effect: ^4.1.4`. **Fama pins `effect: 4.1.3` in the pnpm catalog,
  so it must move to ≥ 4.1.4.** `alchemy` brings `rolldown 1.2.16`, and `@alchemy.run/cloudflare`
  brings `@effect/sql-d1`, `@distilled.cloud/*` and docker/acme packages.
- Telemetry: usage spans only. Turn off with `ALCHEMY_TELEMETRY_DISABLED=1` or `DO_NOT_TRACK=1`.

---

## 6. Local dev

- **Alchemy emits no wrangler config.** No source in `packages/cloudflare/src` or
  `packages/alchemy/src` writes a `wrangler.json`. Docs mention wrangler only to say it is not needed
  (`cloudflare/setup.mdx:55`, `cloudflare/frontend/vite.mdx:31`).
- **`wrangler dev` can stay**, as long as `apps/api/wrangler.jsonc` stays. Local `wrangler dev` and
  `wrangler d1 migrations apply --local` touch only `.wrangler/` or `--persist-to` state, never the
  cloud. So the `verify-fama` skill keeps working unchanged. Cost: two configs (wrangler.jsonc and
  alchemy.run.ts) that must agree. Strip deploy-only fields from wrangler.jsonc, or comment that it is
  for local dev only. **Never run `wrangler deploy` or `wrangler d1 migrations apply --remote` again**
  after the switch (see 8.2).
- **`alchemy dev`** (`cloudflare/local-development.mdx`, `cli/dev.mdx`) replaces it. It runs Workers in
  workerd with simulators for D1 (migrations applied on every reconcile), R2 and assets
  (`runWorkerFirst` applies). Port via `dev: { port: 8788 }`. Data lives under `.alchemy/local`, with
  no `--persist-to` equivalent in the docs. Stage `dev_$USER`. A switch would mean rewriting the
  `verify-fama` `up` script and `features/`. **Never run `alchemy dev --stage prod`**: switching a stage
  between local and live plans a **replacement** ("Switching a resource between local and live …
  plans a replacement", `local-development.mdx`). Protected resources would block it, but that is
  the only guard.

**Recommendation:** keep `wrangler dev` for local work and verify. Use Alchemy only for cloud
deploys.

---

## 7. Auth

`packages/alchemy/src/Auth/Resolve.ts:39–80` (`resolveProviderConfig`):

> Precedence: environment credentials (process environment plus `.env` / `--env-file`) whenever the
> provider's declared contract is fully present — CI or not, selected profile or not — then, in CI,
> the provider's environment resolution alone …, otherwise the selected profile.

Cloudflare contract (`packages/cloudflare/src/Auth/AuthProvider.ts:476–500, 776–790`):
`CLOUDFLARE_ACCOUNT_ID` (required) + `CLOUDFLARE_API_TOKEN`, or `CLOUDFLARE_API_KEY` +
`CLOUDFLARE_EMAIL`. So this works with no `alchemy profile`:

```sh
CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN="$(<cf CLI token>)" pnpm exec alchemy plan --stage prod --adopt
```

Not verified: whether the cf CLI OAuth access token works as a plain bearer `apiToken`. Alchemy
sends it as an API token. A cf OAuth token is a bearer token, so it should work if its scopes
cover Workers Scripts, D1, R2 and Workers subdomain (plus Secrets Store and DO if you use
`Cloudflare.state()`). OAuth tokens are short-lived, so fetch a fresh one per run. The other option
is `alchemy profile edit --add Cloudflare` (Alchemy's own OAuth, which refreshes itself).
`.env` is already git-ignored (`.env*`).

---

## 8. Risks

### 8.1 Stage collision silently adopts prod data (high)
D1 and R2 adopt **by name with no flag**. If `name: "fama"` / `"fama-media"` is set in every stage, a
bare `alchemy deploy` (stage `live_numisteinn`) or `alchemy dev` adopts the **prod** database and
bucket into that stage. A later `alchemy destroy` of that stage would then try to delete them. The
D1 delete is real. The R2 delete fails only if the bucket is non-empty. **Fix:** explicit names only
when `stage === "prod"`, and `RemovalPolicy.protect(prod)` on D1, R2 and the Worker
(`packages/alchemy/src/RemovalPolicy.ts:142`; protect makes plan/deploy/destroy fail before any apply
that would replace or delete).

### 8.2 D1 migration history moves one way (medium)
The first deploy copies `d1_migrations` into `__alchemy_migrations` and freezes the old table. After
that, `wrangler d1 migrations apply --remote` would see a stale table and could re-run files.
Alchemy also enforces linear, unedited history (`NonLinearMigrationHistoryError`,
`RewrittenMigrationHistoryError`; `D1/Database.ts:88–104`). Local wrangler migrations are not
affected.

### 8.3 Things that force a replace (high if hit)
- **D1:** change of `name`, `jurisdiction`, or a set `primaryLocationHint` (`Database.ts:337–364`). With
  an explicit name kept, the replace is **delete-first** (`deleteFirst: true`), so the data is lost.
- **R2:** change of `name`, `jurisdiction` or `locationHint`, or adding or removing `locationHint` later
  (`Bucket.ts` diff ~1335–1353).
- **Worker:** change of `name` or `namespace`. If `name` is omitted in prod, Alchemy makes a **new**
  Worker `fama-prod-…`. The old one is left alone, but the URL moves.
- **Any resource:** live ⇄ local mode switch (`alchemy dev --stage prod`).
- Account change on D1/R2.
→ `protect` turns all of these into a plan-time error.

### 8.4 What the first Worker upload changes vs wrangler (medium)
- **Flags:** `withDefaultFlags` adds `new_module_registry` unless `legacy_module_registry` is set
  (`packages/cloudflare-runtime/src/core/internal/constants.ts:37–40`). `nodejs_compat` is **not**
  added for dates ≥ `2026-08-04`. Wrangler adds no flags today. Pass
  `flags: ["legacy_module_registry"]` to match, or test the new registry first.
- **Extra plain-text vars:** `ALCHEMY_PHASE`, `ALCHEMY_WORKER_NAME`, `ALCHEMY_STACK_NAME`,
  `ALCHEMY_STAGE`, `ALCHEMY_CLOUDFLARE_ACCOUNT_ID` (`Worker.ts` `env` doc). They do no harm, but
  they show in `env` and in `wrangler types` drift.
- **Bundler:** rolldown instead of wrangler's esbuild. Output differs. Run tests and smoke
  (`scripts/smoke.ts`) against a non-prod stage first.
- **Ownership tags** added to the script settings.
- **Observability:** if omitted, traces turn off (default is logs on, traces off).
- **Preview URLs:** `workersDev: true` also turns on version preview URLs.

### 8.5 Beta churn (medium)
`latest` = `2.0.0-beta.87` (2026-11-12). Betas 70→87 took about 3.5 months (beta.70 2026-08-06,
beta.85 2026-11-02, beta.86 and 87 on the same day). `main` has already moved past the tag in
`Worker.ts`, `WorkerProvider.ts`, `R2/Bucket.ts` and `Plan.ts`. State formats carry versions, and
newer formats lock out older CLIs (`state-store/index.mdx`, "Encrypting secrets" and format records).
Pin the exact version, upgrade on purpose, and read `CHANGELOG.md` for each bump.

### 8.6 Version pin (low, required)
Peer `effect ^4.1.4` against Fama's `effect: 4.1.3`. `@effect/vitest` is pinned at 4.1.2 and may
need a matching bump.

### 8.7 Gaps between wrangler.jsonc and Alchemy
| wrangler.jsonc | Alchemy | Gap |
|---|---|---|
| `name`, `main`, `compatibility_date` | `name`, `main`, `compatibility.date` | flags differ (8.4) |
| `observability.traces` | `observability` | pass explicitly |
| `assets.*` | `assets.{directory,notFoundHandling,runWorkerFirst}` | none |
| `d1_databases[].database_id` | none; found by name | id cannot be pinned |
| `migrations_dir` | `migrations` | bookkeeping table changes (8.2) |
| `r2_buckets` | `R2.Bucket` + `env` | none |
| `rules` Data `**/*.png` | `rules` | no `fallthrough`, not needed |
| `dev.ip/port` | only under `alchemy dev` (`dev.port/host`) | n/a if wrangler dev stays |
| secrets (wrangler secret put) | unmanaged or `Config.Redacted` | choose (3) |
| D1/R2 location `weur` | `primaryLocationHint` / `locationHint` | must match real value, or replace |

---

## Suggested first run (for the operator; nothing done)

1. Bump `effect` to ≥ 4.1.4. Add `alchemy`, `@alchemy.run/cloudflare` and `@effect/platform-node`
   (exact `2.0.0-beta.87`) to `apps/api` devDependencies. Add `.alchemy/` to `.gitignore`.
2. Write `apps/api/alchemy.run.ts` as in section 2, with `localState()`, prod-only names and `protect`.
3. Read-only checks with `cf`: the R2 location, CORS, lifecycle and domains of `fama-media`; the D1
   location; the Worker's current bindings, flags and settings.
4. `pnpm --filter web build`, then
   `CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… pnpm exec alchemy plan --stage prod --adopt --detailed`.
   Expect: DB `~` (adopted), Media `~` (adopted), Api `~` (adopted). Any `+`, `-` or replace is a stop.
5. Optional: deploy a throwaway stage (`--stage pr-test`, generated names) to test the rolldown
   bundle and flags, then destroy it. This creates resources, so it needs approval.
6. With approval: `alchemy deploy --stage prod --adopt`. Then confirm with `cf` that the secrets
   are still bound, and run smoke against prod.
