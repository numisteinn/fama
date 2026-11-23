// The HTTP routes against real local D1 and R2 (miniflare through wrangler's platform proxy): ownership between two
// users, the three auth boundaries, and the lease token on job routes.
import { Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { getPlatformProxy } from "wrangler"
import migration from "../migrations/0001_init.sql?raw"
import * as AccountRepo from "./account-repo.ts"
import { Bindings } from "./bindings.ts"
import * as EpisodeRepo from "./episode-repo.ts"
import { routes } from "./http.ts"
import * as MediaStore from "./media-store.ts"
import { sha256Hex } from "./secrets.ts"

const WORKER_TOKEN = "test-worker-token"
const users = {
  alice: { id: "user-alice", client: "alice-client-token", feed: "alice-feed-token" },
  bob: { id: "user-bob", client: "bob-client-token", feed: "bob-feed-token" },
}
const voice = { id: "kokoro:af_heart", engine: "kokoro", name: "Heart", language: "en-US", gender: "female" }

let proxy: Awaited<ReturnType<typeof getPlatformProxy<Env>>>
let env: Env
let handler: (request: Request) => Promise<Response>

beforeAll(async () => {
  proxy = await getPlatformProxy<Env>({ configPath: "wrangler.jsonc", persist: false })
  // In Node the proxied R2 cannot read a stream of unknown length (workerd can), so tests buffer bodies first.
  const media = proxy.env.MEDIA
  const put: R2Bucket["put"] = async (key, value, options) =>
    media.put(key, value instanceof ReadableStream ? await new Response(value).arrayBuffer() : value, options)
  env = { ...proxy.env, MEDIA: Object.assign(Object.create(media) as R2Bucket, { put }), FAMA_WORKER_TOKEN: WORKER_TOKEN }
  const services = Layer.mergeAll(AccountRepo.layer, EpisodeRepo.layer, MediaStore.layer).pipe(
    Layer.provideMerge(Layer.succeed(Bindings, env)),
  )
  const app = HttpRouter.toWebHandler(
    routes.pipe(Layer.provideMerge(services), Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  )
  handler = (request) => app.handler(request)
})

afterAll(() => proxy?.dispose())

const statements = (sql: string) =>
  sql
    .replace(/--.*$/gm, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "")

beforeEach(async () => {
  const tables = ["chapters", "episodes", "tokens", "users", "voices"]
  await env.DB.batch(tables.map((table) => env.DB.prepare(`DROP TABLE IF EXISTS ${table}`)))
  await env.DB.batch(statements(migration).map((statement) => env.DB.prepare(statement)))
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
  let cursor: string | undefined
  do {
    const page = await env.MEDIA.list(cursor === undefined ? {} : { cursor })
    if (page.objects.length > 0) await env.MEDIA.delete(page.objects.map((object) => object.key))
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor !== undefined)
})

const call = (
  token: string | null,
  method: string,
  path: string,
  init: { json?: unknown; body?: BodyInit; headers?: Record<string, string> } = {},
) =>
  handler(
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

const asClient = (user: { client: string }) => (method: string, path: string, init?: Parameters<typeof call>[3]) =>
  call(user.client, method, path, init)
const alice = asClient(users.alice)
const bob = asClient(users.bob)
const asWorker = (method: string, path: string, init?: Parameters<typeof call>[3]) =>
  call(WORKER_TOKEN, method, path, init)

const allKeys = async () => (await env.MEDIA.list()).objects.map((object) => object.key).sort()

const bytes = (text: string) => new TextEncoder().encode(text)

/** Alice adds a text episode, a worker claims it, uploads one chapter and the book, and completes it. */
const readyEpisode = async () => {
  const created = await alice("POST", "/api/episodes", {
    json: { source: { _tag: "Text", title: "Harbour", text: "The harbour is quiet." }, voice: null, speed: 1 },
  })
  expect(created.status).toBe(201)
  const episode = (await created.json()) as { id: string }
  const claim = await asWorker("POST", "/api/worker/claim", { json: { workerId: "w1", voices: [voice] } })
  const { job } = (await claim.json()) as { job: { episodeId: string; leaseToken: string } }
  expect(job.episodeId).toBe(episode.id)
  const lease = job.leaseToken
  const put = (path: string, body: string) =>
    asWorker("PUT", path, { body: bytes(body), headers: { "content-type": "audio/mp4", "content-length": String(body.length) } })
  expect((await put(`/api/worker/jobs/${episode.id}/chapters/0?workerId=w1&leaseToken=${lease}&title=One&durationMs=1000`, "chapter")).status).toBe(204)
  expect((await put(`/api/worker/jobs/${episode.id}/book?workerId=w1&leaseToken=${lease}`, "book")).status).toBe(204)
  const complete = await asWorker("POST", `/api/worker/jobs/${episode.id}/complete`, {
    json: { workerId: "w1", leaseToken: lease, durationMs: 1000 },
  })
  expect(complete.status).toBe(204)
  const ready = (await (await alice("GET", `/api/episodes/${episode.id}`)).json()) as {
    id: string
    bookUrl: string
    chapters: Array<{ url: string }>
  }
  return { ...ready, lease }
}

describe("ownership", () => {
  it("stores media under the owner's prefix and serves it by the owner's feed token", async () => {
    const episode = await readyEpisode()
    expect(await allKeys()).toEqual([
      `users/${users.alice.id}/episodes/${episode.id}/book.m4b`,
      `users/${users.alice.id}/episodes/${episode.id}/chapters/000.m4a`,
    ])
    expect(episode.bookUrl).toBe(`/media/${users.alice.feed}/episodes/${episode.id}/book.m4b`)
    const media = await call(null, "GET", episode.bookUrl)
    expect(media.status).toBe(200)
    expect(await media.text()).toBe("book")
  })

  it("a second user cannot list, read, retry or delete the first user's episode", async () => {
    const episode = await readyEpisode()
    const list = (await (await bob("GET", "/api/episodes")).json()) as { episodes: Array<unknown> }
    expect(list.episodes).toEqual([])
    expect((await bob("GET", `/api/episodes/${episode.id}`)).status).toBe(404)
    expect((await bob("POST", `/api/episodes/${episode.id}/retry`)).status).toBe(404)
    expect((await bob("DELETE", `/api/episodes/${episode.id}`)).status).toBe(404)
    expect((await alice("GET", `/api/episodes/${episode.id}`)).status).toBe(200)
  })

  it("delete of another user's episode removes nothing from R2", async () => {
    const episode = await readyEpisode()
    const before = await allKeys()
    expect(before).toHaveLength(2)
    expect((await bob("DELETE", `/api/episodes/${episode.id}`)).status).toBe(404)
    expect(await allKeys()).toEqual(before)
    expect((await alice("DELETE", `/api/episodes/${episode.id}`)).status).toBe(204)
    expect(await allKeys()).toEqual([])
  })

  it("a second user's feed token cannot fetch the first user's media or feed items", async () => {
    const episode = await readyEpisode()
    const asBob = episode.bookUrl.replace(users.alice.feed, users.bob.feed)
    expect((await call(null, "GET", asBob)).status).toBe(404)
    expect((await call(null, "GET", episode.chapters[0]!.url.replace(users.alice.feed, users.bob.feed))).status).toBe(404)
    const bobFeed = await (await call(null, "GET", `/feed/${users.bob.feed}/rss.xml`)).text()
    expect(bobFeed).not.toContain("<item>")
    const aliceFeed = await (await call(null, "GET", `/feed/${users.alice.feed}/rss.xml`)).text()
    expect(aliceFeed).toContain(`/media/${users.alice.feed}/episodes/${episode.id}/book.m4b`)
  })

  it("media paths outside episodes/ are refused", async () => {
    const form = new FormData()
    form.set("file", new Blob(["secret upload"], { type: "text/plain" }), "notes.txt")
    const created = (await (await alice("POST", "/api/episodes/upload", { body: form })).json()) as { id: string }
    const feed = users.alice.feed
    for (const path of [
      `/media/${feed}/uploads/${created.id}/notes.txt`,
      `/media/${feed}/episodes/%2E%2E/uploads/${created.id}/notes.txt`,
      `/media/${feed}/episodes/x/..%2F..%2Fuploads%2F${created.id}%2Fnotes.txt`,
      `/media/${feed}/episodes/..%2F..%2F..%2Fusers%2F${users.bob.id}%2Fepisodes%2Fx%2Fbook.m4b`,
      `/media/${feed}/users/${users.alice.id}/uploads/${created.id}/notes.txt`,
    ]) {
      const response = await call(null, "GET", path)
      expect(response.status, path).toBe(404)
    }
  })
})

describe("auth boundaries", () => {
  it("GET /api/me names the token's user", async () => {
    expect(await (await bob("GET", "/api/me")).json()).toEqual({ userId: users.bob.id, apiVersion: 1 })
  })

  it("a feed token cannot call /api/*", async () => {
    for (const [method, path] of [
      ["GET", "/api/me"],
      ["GET", "/api/episodes"],
      ["GET", "/api/feed"],
      ["POST", "/api/worker/claim"],
    ] as const) {
      expect((await call(users.alice.feed, method, path)).status, path).toBe(401)
    }
  })

  it("a client token cannot call /api/worker/*", async () => {
    await alice("POST", "/api/episodes", {
      json: { source: { _tag: "Text", title: null, text: "Hello." }, voice: null, speed: 1 },
    })
    const claim = await alice("POST", "/api/worker/claim", { json: { workerId: "w1", voices: [] } })
    expect(claim.status).toBe(401)
    const list = (await (await alice("GET", "/api/episodes")).json()) as { episodes: Array<{ job: { _tag: string } }> }
    expect(list.episodes[0]!.job._tag).toBe("Queued")
  })

  it("the worker token cannot call client routes", async () => {
    expect((await asWorker("GET", "/api/episodes")).status).toBe(401)
  })

  it("no token, a wrong token or an unset worker secret is refused", async () => {
    expect((await call(null, "GET", "/api/episodes")).status).toBe(401)
    expect((await call("wrong", "GET", "/api/episodes")).status).toBe(401)
    expect((await call(null, "POST", "/api/worker/claim", { json: { workerId: "w", voices: [] } })).status).toBe(401)
    expect((await call(null, "GET", "/feed/wrong/rss.xml")).status).toBe(401)
  })

  it("rotating the feed token closes the old feed and media URLs", async () => {
    const episode = await readyEpisode()
    const rotated = (await (await alice("POST", "/api/feed/rotate")).json()) as { url: string }
    const token = /\/feed\/([^/]+)\/rss\.xml$/.exec(rotated.url)?.[1]
    expect(token).toBeDefined()
    expect(token).not.toBe(users.alice.feed)
    expect(((await (await alice("GET", "/api/feed")).json()) as { url: string }).url).toBe(rotated.url)
    expect((await call(null, "GET", episode.bookUrl)).status).toBe(401)
    expect((await call(null, "GET", `/feed/${users.alice.feed}/rss.xml`)).status).toBe(401)
    const fresh = (await (await alice("GET", `/api/episodes/${episode.id}`)).json()) as { bookUrl: string }
    expect(fresh.bookUrl).toBe(`/media/${token}/episodes/${episode.id}/book.m4b`)
    expect((await call(null, "GET", fresh.bookUrl)).status).toBe(200)
  })
})

describe("leases", () => {
  const claimFile = async () => {
    const form = new FormData()
    form.set("file", new Blob(["file body"], { type: "text/plain" }), "notes.txt")
    const created = (await (await alice("POST", "/api/episodes/upload", { body: form })).json()) as { id: string }
    const claim = await asWorker("POST", "/api/worker/claim", { json: { workerId: "w1", voices: [] } })
    const { job } = (await claim.json()) as { job: { episodeId: string; leaseToken: string; sourcePath: string } }
    expect(job.episodeId).toBe(created.id)
    return job
  }

  it("every job route refuses a wrong lease token with 409", async () => {
    const job = await claimFile()
    const id = job.episodeId
    const wrong = "not-the-lease"
    const put = (path: string) =>
      asWorker("PUT", path, { body: bytes("x"), headers: { "content-type": "audio/mp4", "content-length": "1" } })
    const responses = {
      source: await asWorker("GET", `${job.sourcePath}?leaseToken=${wrong}`),
      progress: await asWorker("POST", `/api/worker/jobs/${id}/progress`, {
        json: { workerId: "w1", leaseToken: wrong, stage: "synthesizing", done: 0, total: 1, title: null, author: null, language: null, voice: null },
      }),
      chapter: await put(`/api/worker/jobs/${id}/chapters/0?workerId=w1&leaseToken=${wrong}&title=x&durationMs=1`),
      book: await put(`/api/worker/jobs/${id}/book?workerId=w1&leaseToken=${wrong}`),
      complete: await asWorker("POST", `/api/worker/jobs/${id}/complete`, {
        json: { workerId: "w1", leaseToken: wrong, durationMs: 1 },
      }),
      fail: await asWorker("POST", `/api/worker/jobs/${id}/fail`, { json: { workerId: "w1", leaseToken: wrong, reason: "x" } }),
    }
    for (const [route, response] of Object.entries(responses)) expect(response.status, route).toBe(409)
    expect((await asWorker("GET", job.sourcePath)).status, "source without a lease").toBe(400)
    const source = await asWorker("GET", `${job.sourcePath}?leaseToken=${job.leaseToken}`)
    expect(source.status).toBe(200)
    expect(await source.text()).toBe("file body")
    expect(await allKeys()).toEqual([`users/${users.alice.id}/uploads/${id}/notes.txt`])
  })

  it("the same worker id with an old lease is refused after a retry and a new claim", async () => {
    const first = await claimFile()
    const id = first.episodeId
    const fail = (leaseToken: string) =>
      asWorker("POST", `/api/worker/jobs/${id}/fail`, { json: { workerId: "w1", leaseToken, reason: "boom" } })
    expect((await fail(first.leaseToken)).status).toBe(204)
    expect((await fail(first.leaseToken)).status, "repeat fail is a no-op").toBe(204)
    expect((await alice("POST", `/api/episodes/${id}/retry`)).status).toBe(200)
    expect((await fail(first.leaseToken)).status, "old lease after retry").toBe(409)
    const claim = await asWorker("POST", "/api/worker/claim", { json: { workerId: "w1", voices: [] } })
    const second = ((await claim.json()) as { job: { leaseToken: string } }).job
    expect(second.leaseToken).not.toBe(first.leaseToken)
    expect((await asWorker("GET", `${first.sourcePath}?leaseToken=${first.leaseToken}`)).status).toBe(409)
    expect((await asWorker("GET", `${first.sourcePath}?leaseToken=${second.leaseToken}`)).status).toBe(200)
  })
})
