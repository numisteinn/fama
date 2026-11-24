// The API for route tests: the real routes on local D1 and R2 (miniflare through wrangler's platform proxy), with
// two seeded users and the worker token.
import { Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import { getPlatformProxy } from "wrangler"
import * as AccountRepo from "./account-repo.ts"
import { Bindings } from "./bindings.ts"
import * as EpisodeRepo from "./episode-repo.ts"
import { routes } from "./http.ts"
import * as MediaStore from "./media-store.ts"
import { sha256Hex } from "./secrets.ts"
import * as Wake from "./wake.ts"

const files = import.meta.glob("../migrations/*.sql", { query: "?raw", import: "default", eager: true })

/** The SQL of every migration, in order. */
export const migrations = Object.keys(files)
  .sort()
  .map((path) => files[path])
  .join("\n")

export const WORKER_TOKEN = "test-worker-token"
export const users = {
  alice: { id: "user-alice", client: "alice-client-token", feed: "alice-feed-token" },
  bob: { id: "user-bob", client: "bob-client-token", feed: "bob-feed-token" },
}

type Init = { json?: unknown; body?: BodyInit; headers?: Record<string, string> }

const TABLES = ["timings", "progress", "chapters", "episodes", "tokens", "users", "voices"]

const statements = migrations
  .replace(/--.*$/gm, "")
  .split(";")
  .map((statement) => statement.trim())
  .filter((statement) => statement !== "")

export const startApp = async () => {
  const proxy = await getPlatformProxy<Env>({ configPath: "wrangler.jsonc", persist: false })
  // In Node the proxied R2 cannot read a stream of unknown length (workerd can), so tests buffer bodies first.
  const media = proxy.env.MEDIA
  const put: R2Bucket["put"] = async (key, value, options) =>
    media.put(key, value instanceof ReadableStream ? await new Response(value).arrayBuffer() : value, options)
  const env: Env = {
    ...proxy.env,
    MEDIA: Object.assign(Object.create(media) as R2Bucket, { put }),
    FAMA_WORKER_TOKEN: WORKER_TOKEN,
  }
  const services = Layer.mergeAll(
    AccountRepo.layer,
    EpisodeRepo.layer,
    MediaStore.layer,
    Wake.layer({ waitUntil: () => {} }),
  ).pipe(Layer.provideMerge(Layer.succeed(Bindings, env)))
  const app = HttpRouter.toWebHandler(
    routes.pipe(Layer.provideMerge(services), Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  )

  const call = (token: string | null, method: string, path: string, init: Init = {}) =>
    app.handler(
      new Request(`http://fama.test${path}`, {
        method,
        headers: {
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
          ...(init.json === undefined ? {} : { "content-type": "application/json" }),
          ...init.headers,
        },
        body: init.json === undefined ? (init.body ?? null) : JSON.stringify(init.json),
      }),
    )
  const as = (token: string) => (method: string, path: string, init?: Init) => call(token, method, path, init)

  /** Empty tables, the two users, and an empty bucket. */
  const reset = async () => {
    await env.DB.batch(TABLES.map((table) => env.DB.prepare(`DROP TABLE IF EXISTS ${table}`)))
    await env.DB.batch(statements.map((statement) => env.DB.prepare(statement)))
    for (const user of Object.values(users)) {
      await env.DB.batch([
        env.DB.prepare("INSERT INTO users (id, feed_token, created_at) VALUES (?, ?, ?)").bind(
          user.id,
          user.feed,
          "2026-11-23T00:00:00.000Z",
        ),
        env.DB.prepare("INSERT INTO tokens (hash, user_id, created_at) VALUES (?, ?, ?)").bind(
          await sha256Hex(user.client),
          user.id,
          "2026-11-23T00:00:00.000Z",
        ),
      ])
    }
    const page = await env.MEDIA.list()
    if (page.objects.length > 0) await env.MEDIA.delete(page.objects.map((object) => object.key))
  }

  return {
    env,
    call,
    alice: as(users.alice.client),
    bob: as(users.bob.client),
    asWorker: as(WORKER_TOKEN),
    reset,
    dispose: () => proxy.dispose(),
  }
}
