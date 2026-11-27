import { readFileSync } from "node:fs"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { ASSETS, COMPATIBILITY_DATE, D1_MIGRATIONS, MODULE_RULES, OBSERVABILITY, WORKER_MAIN } from "./worker-config.ts"

// wrangler.jsonc (local dev, verify-fama) and the Alchemy stack must describe the same Worker.
const strings = Schema.Array(Schema.String)
const WranglerConfig = Schema.Struct({
  compatibility_date: Schema.String,
  main: Schema.String,
  assets: Schema.Struct({ directory: Schema.String, not_found_handling: Schema.String, run_worker_first: strings }),
  observability: Schema.Unknown,
  d1_databases: Schema.NonEmptyArray(Schema.Struct({ binding: Schema.String, migrations_dir: Schema.String })),
  r2_buckets: Schema.Array(Schema.Struct({ binding: Schema.String })),
  rules: Schema.Array(Schema.Struct({ type: Schema.String, globs: strings })),
})
const wrangler = Schema.decodeUnknownSync(WranglerConfig)(
  JSON.parse(readFileSync(new URL("../../apps/api/wrangler.jsonc", import.meta.url), "utf8")),
)
const fromInfra = (path: string) => new URL(`../${path}`, import.meta.url).href
const fromApi = (path: string) => new URL(`../../apps/api/${path}`, import.meta.url).href

describe("worker config", () => {
  it("matches wrangler.jsonc", () => {
    expect(COMPATIBILITY_DATE).toBe(wrangler.compatibility_date)
    expect(fromInfra(WORKER_MAIN)).toBe(fromApi(wrangler.main))
    expect(fromInfra(ASSETS.directory)).toBe(fromApi(wrangler.assets.directory))
    expect(ASSETS.notFoundHandling).toBe(wrangler.assets.not_found_handling)
    expect([...ASSETS.runWorkerFirst]).toEqual(wrangler.assets.run_worker_first)
    expect(OBSERVABILITY).toEqual(wrangler.observability)
    expect(fromInfra(D1_MIGRATIONS)).toBe(fromApi(wrangler.d1_databases[0].migrations_dir))
    expect(MODULE_RULES.map(({ type, globs }) => ({ type, globs: [...globs] }))).toEqual(
      wrangler.rules.map(({ type, globs }) => ({ type, globs })),
    )
  })

  it("binds what wrangler.jsonc binds", () => {
    expect(wrangler.d1_databases.map((db) => db.binding)).toEqual(["DB"])
    expect(wrangler.r2_buckets.map((bucket) => bucket.binding)).toEqual(["MEDIA"])
  })
})
