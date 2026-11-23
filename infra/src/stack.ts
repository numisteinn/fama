// The Fama stack program. `alchemy.run.ts` wraps it with providers and state.
import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Alchemy from "alchemy"
import { RemovalPolicy, Stack } from "alchemy"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import { isProd, resourceNames } from "./names.ts"
import {
  ASSETS,
  COMPATIBILITY_DATE,
  D1_MIGRATIONS,
  MODULE_RULES,
  OBSERVABILITY,
  WORKER_MAIN,
} from "./worker-config.ts"

export const STACK_NAME = "Fama"

export const famaProgram = Effect.gen(function* () {
  const { stage } = yield* Stack
  const names = resourceNames(stage)
  const protect = RemovalPolicy.protect(isProd(stage))

  const db = yield* Cloudflare.D1.Database("DB", {
    name: names.database,
    migrations: D1_MIGRATIONS,
  }).pipe(protect)

  // `alchemy destroy` empties the bucket on any stage but prod, so teardown removes the media too.
  const media = yield* Cloudflare.R2.Bucket("Media", { name: names.bucket, forceDestroy: !isProd(stage) }).pipe(protect)

  // Generated once, kept in state. The Python worker sends it on /api/worker/*.
  const workerToken = yield* Alchemy.Random("WorkerToken")

  // Optional wake hook (D5). Read from the environment or infra/.env on every
  // deploy: a deploy without them removes them from the Worker.
  const wakeUrl = yield* Config.option(Config.String("WORKER_WAKE_URL"))
  const wakeSecret = yield* Config.option(Config.Redacted("WORKER_WAKE_SECRET"))
  if (Option.isSome(wakeUrl) !== Option.isSome(wakeSecret)) {
    return yield* Effect.die(new Error("Set both WORKER_WAKE_URL and WORKER_WAKE_SECRET, or neither."))
  }
  const wake =
    Option.isSome(wakeUrl) && Option.isSome(wakeSecret)
      ? { WORKER_WAKE_URL: Redacted.make(wakeUrl.value), WORKER_WAKE_SECRET: wakeSecret.value }
      : {}

  const worker = yield* Cloudflare.Worker("Api", {
    name: names.worker,
    main: WORKER_MAIN,
    // Keep the module registry wrangler uses, so the deployed Worker runs as it does under `wrangler dev`.
    compatibility: { date: COMPATIBILITY_DATE, flags: ["legacy_module_registry"] },
    observability: OBSERVABILITY,
    assets: {
      directory: ASSETS.directory,
      notFoundHandling: ASSETS.notFoundHandling,
      runWorkerFirst: [...ASSETS.runWorkerFirst],
    },
    rules: MODULE_RULES.map((rule) => ({ type: rule.type, globs: [...rule.globs] })),
    env: {
      DB: db,
      MEDIA: media,
      FAMA_WORKER_TOKEN: workerToken.text,
      ...wake,
    },
  }).pipe(protect)

  return {
    url: worker.url.as<string>(),
    accountId: db.accountId,
    databaseId: db.databaseId,
    workerToken: workerToken.text,
  }
})
