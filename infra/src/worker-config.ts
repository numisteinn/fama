/**
 * Worker settings shared with `apps/api/wrangler.jsonc`, which local dev and
 * verify-fama still use. `worker-config.test.ts` fails when the two drift apart.
 * Paths are relative to `infra/`, the directory Alchemy runs in.
 */
export const COMPATIBILITY_DATE = "2026-11-18"

export const WORKER_MAIN = "../apps/api/src/worker.ts"

export const D1_MIGRATIONS = "../apps/api/migrations"

export const ASSETS = {
  directory: "../apps/web/dist",
  notFoundHandling: "single-page-application",
  runWorkerFirst: ["/api/*", "/feed/*", "/media/*"],
} as const

export const OBSERVABILITY = { enabled: true, traces: { enabled: true } } as const

/** `src/http.ts` imports `./cover.png`. Upload it as a binary module. */
export const MODULE_RULES = [{ type: "Data", globs: ["**/*.png"] }] as const
