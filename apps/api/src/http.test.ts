// The HTTP routes against real local D1 and R2 (miniflare through wrangler's platform proxy): ownership between two
// users, the three auth boundaries, the lease token on job routes, listening progress, and the worker wake.
import { Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { getPlatformProxy } from "wrangler"
import * as AccountRepo from "./account-repo.ts"
import { Bindings } from "./bindings.ts"
import * as EpisodeRepo from "./episode-repo.ts"
import { routes } from "./http.ts"
import * as MediaStore from "./media-store.ts"
import * as SampleRepo from "./sample-repo.ts"
import { sha256Hex } from "./secrets.ts"
import { migrations } from "./test-app.ts"
import * as Wake from "./wake.ts"

const WORKER_TOKEN = "test-worker-token"
const users = {
  alice: { id: "user-alice", client: "alice-client-token", feed: "alice-feed-token" },
  bob: { id: "user-bob", client: "bob-client-token", feed: "bob-feed-token" },
}
const voice = { id: "kokoro:af_heart", engine: "kokoro", name: "Heart", language: "en-US", gender: "female" }

let proxy: Awaited<ReturnType<typeof getPlatformProxy<Env>>>
let env: Env
let handler: (request: Request) => Promise<Response>

/** The wake calls the API made, with the episode states D1 held when each call went out. */
type WakeCall = { url: string; method: string; authorization: string | null; jobStates: Array<string> }
let wakeCalls: Array<WakeCall> = []
/** The promises handed to `waitUntil`. */
let pendingWakes: Array<Promise<unknown>> = []
/** What the fake wake endpoint does once a call is recorded. */
let wakeAnswer: (signal: AbortSignal | undefined) => Promise<Response> = async () => new Response(null, { status: 202 })
let waitUntilThrows = false
const WAKE_TIMEOUT_MS = 200

const fakeWakeFetch: typeof fetch = async (input, init) => {
  const { results } = await env.DB.prepare("SELECT job_state FROM episodes").all<{ job_state: string }>()
  wakeCalls.push({
    url: String(input),
    method: init?.method ?? "GET",
    authorization: new Headers(init?.headers).get("authorization"),
    jobStates: results.map((row) => row.job_state),
  })
  return wakeAnswer(init?.signal ?? undefined)
}

const setWake = (url: string | undefined, secret: string | undefined) =>
  Object.assign(env, { WORKER_WAKE_URL: url, WORKER_WAKE_SECRET: secret })

beforeAll(async () => {
  proxy = await getPlatformProxy<Env>({ configPath: "wrangler.jsonc", persist: false })
  // In Node the proxied R2 cannot read a stream of unknown length (workerd can), so tests buffer bodies first.
  const media = proxy.env.MEDIA
  const put: R2Bucket["put"] = async (key, value, options) =>
    media.put(key, value instanceof ReadableStream ? await new Response(value).arrayBuffer() : value, options)
  env = { ...proxy.env, MEDIA: Object.assign(Object.create(media) as R2Bucket, { put }), FAMA_WORKER_TOKEN: WORKER_TOKEN }
  const wake = Wake.layer({
    waitUntil: (promise) => {
      if (waitUntilThrows) throw new Error("waitUntil outside a request")
      pendingWakes.push(promise)
    },
    fetch: fakeWakeFetch,
    timeoutMs: WAKE_TIMEOUT_MS,
  })
  const services = Layer.mergeAll(AccountRepo.layer, EpisodeRepo.layer, MediaStore.layer, SampleRepo.layer, wake).pipe(
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
  setWake(undefined, undefined)
  wakeCalls = []
  pendingWakes = []
  wakeAnswer = async () => new Response(null, { status: 202 })
  waitUntilThrows = false
  const tables = ["timings", "samples", "progress", "chapters", "episodes", "tokens", "users", "voices"]
  await env.DB.batch(tables.map((table) => env.DB.prepare(`DROP TABLE IF EXISTS ${table}`)))
  await env.DB.batch(statements(migrations).map((statement) => env.DB.prepare(statement)))
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
  const { work: job } = (await claim.json()) as { work: { episodeId: string; leaseToken: string } }
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
    const { work: job } = (await claim.json()) as { work: { episodeId: string; leaseToken: string; sourcePath: string } }
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
    const second = ((await claim.json()) as { work: { leaseToken: string } }).work
    expect(second.leaseToken).not.toBe(first.leaseToken)
    expect((await asWorker("GET", `${first.sourcePath}?leaseToken=${first.leaseToken}`)).status).toBe(409)
    expect((await asWorker("GET", `${first.sourcePath}?leaseToken=${second.leaseToken}`)).status).toBe(200)
  })
})

describe("time left", () => {
  it("shows the worker's estimate on the running job, and takes a worker that sends none", async () => {
    const createBody = { source: { _tag: "Text", title: "Harbour", text: "The harbour is quiet." }, voice: null, speed: 1 }
    const created = (await (await alice("POST", "/api/episodes", { json: createBody })).json()) as { id: string }
    const claim = await asWorker("POST", "/api/worker/claim", { json: { workerId: "w1", voices: [] } })
    const { work: job } = (await claim.json()) as { work: { leaseToken: string } }
    const report = (extra: Record<string, unknown>) =>
      asWorker("POST", `/api/worker/jobs/${created.id}/progress`, {
        json: { workerId: "w1", leaseToken: job.leaseToken, stage: "synthesizing", done: 4, total: 9, title: null, author: null, language: null, voice: null, ...extra },
      })
    const jobOf = async () => ((await (await alice("GET", `/api/episodes/${created.id}`)).json()) as { job: unknown }).job

    expect((await report({ remainingMs: 95_000 })).status).toBe(204)
    expect(await jobOf()).toMatchObject({ _tag: "Running", stage: "synthesizing", done: 4, total: 9, remainingMs: 95_000 })
    expect((await report({})).status, "an older worker").toBe(204)
    expect(await jobOf()).toMatchObject({ _tag: "Running", remainingMs: null })
    expect((await report({ remainingMs: -1 })).status).toBe(400)
  })
})

describe("progress", () => {
  type Progress = { positionMs: number; updatedAt: string }
  const putProgress = (client: typeof alice, id: string, body: unknown) =>
    client("PUT", `/api/episodes/${id}/progress`, { json: body })
  const progressOf = async (id: string) =>
    ((await (await alice("GET", `/api/episodes/${id}`)).json()) as { progress: Progress | null }).progress
  const stamp = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString()

  it("stores a write, returns it, and shows it on the episode", async () => {
    const episode = await readyEpisode()
    expect(await progressOf(episode.id)).toBeNull()
    const write = { positionMs: 10_000, updatedAt: stamp(-60_000) }
    const response = await putProgress(alice, episode.id, write)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(write)
    expect(await progressOf(episode.id)).toEqual(write)
    const list = (await (await alice("GET", "/api/episodes")).json()) as { episodes: Array<{ progress: Progress }> }
    expect(list.episodes[0]!.progress).toEqual(write)
  })

  it("an older write loses: it changes nothing and gets the stored value back", async () => {
    const episode = await readyEpisode()
    const newer = { positionMs: 60_000, updatedAt: stamp(-10_000) }
    expect((await putProgress(alice, episode.id, newer)).status).toBe(200)
    const older = await putProgress(alice, episode.id, { positionMs: 5_000, updatedAt: stamp(-20_000) })
    expect(older.status).toBe(200)
    expect(await older.json()).toEqual(newer)
    const tie = await putProgress(alice, episode.id, { positionMs: 7_000, updatedAt: newer.updatedAt })
    expect(await tie.json(), "an equal stamp also loses").toEqual(newer)
    expect(await progressOf(episode.id)).toEqual(newer)
    const latest = { positionMs: 70_000, updatedAt: stamp(-5_000) }
    expect(await (await putProgress(alice, episode.id, latest)).json()).toEqual(latest)
  })

  it("a stamp from the future is clamped to the server clock", async () => {
    const episode = await readyEpisode()
    const before = Date.now()
    const response = await putProgress(alice, episode.id, { positionMs: 30_000, updatedAt: "2100-01-01T00:00:00.000Z" })
    const after = Date.now()
    const stored = (await response.json()) as Progress
    expect(stored.positionMs).toBe(30_000)
    expect(Date.parse(stored.updatedAt)).toBeGreaterThanOrEqual(before)
    expect(Date.parse(stored.updatedAt)).toBeLessThanOrEqual(after)
    expect(await progressOf(episode.id)).toEqual(stored)
    // So a later honest write still wins.
    await new Promise((resolve) => setTimeout(resolve, 5))
    const honest = { positionMs: 31_000, updatedAt: new Date().toISOString() }
    expect(await (await putProgress(alice, episode.id, honest)).json()).toEqual(honest)
  })

  it("a second user gets 404 and changes nothing", async () => {
    const episode = await readyEpisode()
    const mine = { positionMs: 10_000, updatedAt: stamp(-60_000) }
    await putProgress(alice, episode.id, mine)
    const response = await putProgress(bob, episode.id, { positionMs: 1, updatedAt: stamp(0) })
    expect(response.status).toBe(404)
    expect(await progressOf(episode.id)).toEqual(mine)
    const rows = await env.DB.prepare("SELECT user_id FROM progress").all()
    expect(rows.results).toEqual([{ user_id: users.alice.id }])
    expect((await putProgress(alice, "no-such-episode", mine)).status).toBe(404)
  })

  it("deleting the episode deletes its progress", async () => {
    const episode = await readyEpisode()
    await putProgress(alice, episode.id, { positionMs: 10_000, updatedAt: stamp(-60_000) })
    expect((await env.DB.prepare("SELECT count(*) AS n FROM progress").first())?.n).toBe(1)
    expect((await alice("DELETE", `/api/episodes/${episode.id}`)).status).toBe(204)
    expect((await env.DB.prepare("SELECT count(*) AS n FROM progress").first())?.n).toBe(0)
  })

  it("refuses a body that is not EpisodeProgress", async () => {
    const episode = await readyEpisode()
    for (const body of [
      { positionMs: -1, updatedAt: stamp(0) },
      { positionMs: 1.5, updatedAt: stamp(0) },
      { positionMs: 1, updatedAt: "yesterday" },
      { positionMs: 1 },
    ]) {
      expect((await putProgress(alice, episode.id, body)).status, JSON.stringify(body)).toBe(400)
    }
    expect(await progressOf(episode.id)).toBeNull()
  })

  it("needs a client token", async () => {
    const episode = await readyEpisode()
    const body = { positionMs: 1, updatedAt: stamp(0) }
    expect((await call(null, "PUT", `/api/episodes/${episode.id}/progress`, { json: body })).status).toBe(401)
    expect((await call(WORKER_TOKEN, "PUT", `/api/episodes/${episode.id}/progress`, { json: body })).status).toBe(401)
  })
})

describe("worker wake", () => {
  const WAKE_URL = "https://fama-test--fama-worker-wake.modal.run/"
  const WAKE_SECRET = "test-wake-secret"
  const textEpisode = { source: { _tag: "Text", title: "Harbour", text: "The harbour is quiet." }, voice: null, speed: 1 }
  const createText = () => alice("POST", "/api/episodes", { json: textEpisode })
  const uploadFile = () => {
    const form = new FormData()
    form.set("file", new Blob(["file body"], { type: "text/plain" }), "notes.txt")
    return alice("POST", "/api/episodes/upload", { body: form })
  }
  const settled = async () => {
    const results = await Promise.allSettled(pendingWakes)
    expect(results.map((result) => result.status)).toEqual(pendingWakes.map(() => "fulfilled"))
  }
  const expectOneWake = (jobStates: Array<string>) => {
    expect(wakeCalls).toEqual([{ url: WAKE_URL, method: "POST", authorization: `Bearer ${WAKE_SECRET}`, jobStates }])
  }

  it("create sends one wake with the secret, after the Queued episode is stored", async () => {
    setWake(WAKE_URL, WAKE_SECRET)
    expect((await createText()).status).toBe(201)
    await settled()
    expectOneWake(["Queued"])
  })

  it("upload sends one wake with the secret, after the Queued episode is stored", async () => {
    setWake(WAKE_URL, WAKE_SECRET)
    expect((await uploadFile()).status).toBe(201)
    await settled()
    expectOneWake(["Queued"])
  })

  it("retry sends one wake with the secret, after the job is Queued again", async () => {
    const { id } = (await (await uploadFile()).json()) as { id: string }
    const claim = await asWorker("POST", "/api/worker/claim", { json: { workerId: "w1", voices: [] } })
    const { work: job } = (await claim.json()) as { work: { leaseToken: string } }
    const fail = await asWorker("POST", `/api/worker/jobs/${id}/fail`, {
      json: { workerId: "w1", leaseToken: job.leaseToken, reason: "boom" },
    })
    expect(fail.status).toBe(204)
    setWake(WAKE_URL, WAKE_SECRET)
    expect((await alice("POST", `/api/episodes/${id}/retry`)).status).toBe(200)
    await settled()
    expectOneWake(["Queued"])
  })

  it("start wakes the worker after queuing the reviewed Document, once", async () => {
    const created = await alice("POST", "/api/episodes", { json: { ...textEpisode, review: true } })
    const { id } = (await created.json()) as { id: string }
    const claim = await asWorker("POST", "/api/worker/claim", { json: { workerId: "w1", voices: [] } })
    const { work: job } = (await claim.json()) as { work: { leaseToken: string } }
    const document = {
      title: "Harbour", author: null, language: "en",
      chapters: [{ title: "Morning", text: "The harbour is quiet." }],
    }
    const stored = await asWorker("PUT", `/api/worker/jobs/${id}/document?workerId=w1&leaseToken=${job.leaseToken}`, {
      json: document,
    })
    expect(await stored.json()).toEqual({ next: "Review" })
    setWake(WAKE_URL, WAKE_SECRET)
    expect((await alice("POST", `/api/episodes/${id}/start`, { json: { document } })).status).toBe(200)
    expect((await alice("POST", `/api/episodes/${id}/start`, { json: { document } })).status).toBe(409)
    await settled()
    expectOneWake(["Queued"])
  })

  it("a refused retry sends no wake", async () => {
    setWake(WAKE_URL, WAKE_SECRET)
    const { id } = (await (await createText()).json()) as { id: string }
    await asWorker("POST", "/api/worker/claim", { json: { workerId: "w1", voices: [] } })
    await settled()
    wakeCalls = []
    expect((await alice("POST", `/api/episodes/${id}/retry`)).status).toBe(409)
    expect((await bob("POST", `/api/episodes/${id}/retry`)).status).toBe(404)
    expect(wakeCalls).toEqual([])
  })

  it("other client and worker routes send no wake", async () => {
    setWake(WAKE_URL, WAKE_SECRET)
    await readyEpisode()
    await settled()
    wakeCalls = []
    await alice("GET", "/api/episodes")
    await asWorker("POST", "/api/worker/claim", { json: { workerId: "w1", voices: [] } })
    expect(wakeCalls).toEqual([])
  })

  it("no wake URL sends no wake", async () => {
    expect((await createText()).status).toBe(201)
    expect((await uploadFile()).status).toBe(201)
    expect(pendingWakes).toEqual([])
    expect(wakeCalls).toEqual([])
  })

  it("a wake URL without a secret sends no wake", async () => {
    setWake(WAKE_URL, undefined)
    expect((await createText()).status).toBe(201)
    expect(wakeCalls).toEqual([])
  })

  it("a wake that throws still returns 201", async () => {
    setWake(WAKE_URL, WAKE_SECRET)
    wakeAnswer = async () => {
      throw new TypeError("fetch failed")
    }
    expect((await createText()).status).toBe(201)
    expect((await uploadFile()).status).toBe(201)
    await settled()
    expect(wakeCalls).toHaveLength(2)
  })

  it("a wake that answers 401 or 500 still returns 201", async () => {
    setWake(WAKE_URL, WAKE_SECRET)
    wakeAnswer = async () => new Response("Unauthorized", { status: 401 })
    expect((await createText()).status).toBe(201)
    wakeAnswer = async () => new Response("boom", { status: 500 })
    expect((await uploadFile()).status).toBe(201)
    await settled()
    expect(wakeCalls).toHaveLength(2)
  })

  it("a slow wake does not hold the response, and is cut at the timeout", async () => {
    setWake(WAKE_URL, WAKE_SECRET)
    let aborted = false
    wakeAnswer = (signal) =>
      new Promise((_, reject) => {
        signal?.addEventListener("abort", () => {
          aborted = true
          reject(signal.reason)
        })
      })
    const started = Date.now()
    const response = await createText()
    expect(response.status).toBe(201)
    expect(aborted, "the response came before the wake settled").toBe(false)
    await settled()
    expect(aborted).toBe(true)
    expect(Date.now() - started).toBeGreaterThanOrEqual(WAKE_TIMEOUT_MS - 20)
    expect(wakeCalls).toHaveLength(1)
  })

  it("a retry with a slow wake still returns 200", async () => {
    const { id } = (await (await uploadFile()).json()) as { id: string }
    const claim = await asWorker("POST", "/api/worker/claim", { json: { workerId: "w1", voices: [] } })
    const { work: job } = (await claim.json()) as { work: { leaseToken: string } }
    await asWorker("POST", `/api/worker/jobs/${id}/fail`, { json: { workerId: "w1", leaseToken: job.leaseToken, reason: "boom" } })
    setWake(WAKE_URL, WAKE_SECRET)
    wakeAnswer = (signal) => new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason)))
    expect((await alice("POST", `/api/episodes/${id}/retry`)).status).toBe(200)
    await settled()
    expect(wakeCalls).toHaveLength(1)
  })

  it("a waitUntil that throws still returns 201", async () => {
    setWake(WAKE_URL, WAKE_SECRET)
    waitUntilThrows = true
    expect((await createText()).status).toBe(201)
  })
})

describe("timing files", () => {
  const timing = {
    segments: [
      { text: "Harbour", startMs: 0, endMs: 600, endsParagraph: true },
      { text: "The harbour has 3 boats.", startMs: 1500, endMs: 3200, endsParagraph: true },
    ],
  }

  const claimed = async () => {
    const created = await alice("POST", "/api/episodes", {
      json: { source: { _tag: "Text", title: "Harbour", text: "The harbour has 3 boats." }, voice: null, speed: 1 },
    })
    const { id } = (await created.json()) as { id: string }
    const claim = await asWorker("POST", "/api/worker/claim", { json: { workerId: "w1", voices: [voice] } })
    const { work: job } = (await claim.json()) as { work: { leaseToken: string } }
    return { id, lease: job.leaseToken }
  }
  const putTiming = (id: string, lease: string, json: unknown, token: string | null = WORKER_TOKEN) =>
    call(token, "PUT", `/api/worker/jobs/${id}/chapters/0/timing?workerId=w1&leaseToken=${lease}`, { json })
  const putChapter = (id: string, lease: string) =>
    asWorker("PUT", `/api/worker/jobs/${id}/chapters/0?workerId=w1&leaseToken=${lease}&title=One&durationMs=3200`, {
      body: bytes("chapter"),
      headers: { "content-type": "audio/mp4", "content-length": "7" },
    })
  const chaptersOf = async (id: string) =>
    ((await (await alice("GET", `/api/episodes/${id}`)).json()) as { chapters: Array<{ timingUrl: string | null }> }).chapters

  it("a chapter lists the timing file the worker uploaded before it, and the media route serves it", async () => {
    const { id, lease } = await claimed()
    expect((await putTiming(id, lease, timing)).status).toBe(204)
    expect(await chaptersOf(id), "no chapter before its audio").toEqual([])
    expect((await putChapter(id, lease)).status).toBe(204)
    const [chapter] = await chaptersOf(id)
    expect(chapter!.timingUrl).toBe(`/media/${users.alice.feed}/episodes/${id}/chapters/000.json`)
    const listed = (await (await alice("GET", "/api/episodes")).json()) as {
      episodes: Array<{ chapters: Array<{ timingUrl: string | null }> }>
    }
    expect(listed.episodes[0]!.chapters[0]!.timingUrl).toBe(chapter!.timingUrl)
    const served = await call(null, "GET", chapter!.timingUrl!)
    expect(served.status).toBe(200)
    expect(served.headers.get("content-type")).toBe("application/json")
    expect(await served.json()).toEqual(timing)
    expect(await allKeys()).toContain(`users/${users.alice.id}/episodes/${id}/chapters/000.json`)
  })

  it("a chapter without a timing file has timingUrl null", async () => {
    const episode = await readyEpisode()
    expect(await chaptersOf(episode.id)).toMatchObject([{ timingUrl: null }])
  })

  it("an upload again replaces the file", async () => {
    const { id, lease } = await claimed()
    await putTiming(id, lease, timing)
    await putChapter(id, lease)
    const shorter = { segments: [timing.segments[0]] }
    expect((await putTiming(id, lease, shorter)).status).toBe(204)
    const [chapter] = await chaptersOf(id)
    expect(await (await call(null, "GET", chapter!.timingUrl!)).json()).toEqual(shorter)
  })

  it("refuses a wrong lease, a client token, and a body that is not a timing file", async () => {
    const { id, lease } = await claimed()
    expect((await putTiming(id, "not-the-lease", timing)).status).toBe(409)
    expect((await putTiming(id, lease, timing, users.alice.client)).status).toBe(401)
    const overlap = { segments: [timing.segments[1], timing.segments[0]] }
    const fraction = { segments: [{ ...timing.segments[0], endMs: 600.5 }] }
    for (const body of [overlap, fraction, { segments: [{ text: "x" }] }, []]) {
      expect((await putTiming(id, lease, body)).status, JSON.stringify(body)).toBe(400)
    }
    await putChapter(id, lease)
    expect(await chaptersOf(id)).toMatchObject([{ timingUrl: null }])
    expect(await allKeys()).toEqual([`users/${users.alice.id}/episodes/${id}/chapters/000.m4a`])
  })

  it("deleting the episode deletes its timing files", async () => {
    const { id, lease } = await claimed()
    await putTiming(id, lease, timing)
    await putChapter(id, lease)
    expect((await alice("DELETE", `/api/episodes/${id}`)).status).toBe(204)
    expect(await allKeys()).toEqual([])
    expect((await env.DB.prepare("SELECT * FROM timings").all()).results).toEqual([])
  })
})
