// The transcript in the feed: one WebVTT file on the book file's timeline, made from the timing files and stored.
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest"
import { startApp, users } from "../test-app.ts"

let app: Awaited<ReturnType<typeof startApp>>

beforeAll(async () => {
  app = await startApp()
})
afterAll(() => app?.dispose())
beforeEach(() => app.reset())

const chapters = [
  {
    title: "Morning",
    durationMs: 4_000,
    segments: [
      { text: "Harbour Year.", startMs: 300, endMs: 1_500, endsParagraph: true },
      { text: "Boats & <nets>.", startMs: 1_900, endMs: 3_990, endsParagraph: true },
    ],
  },
  { title: "Evening", durationMs: 5_000, segments: [{ text: "Evening.", startMs: 250, endMs: 2_000, endsParagraph: true }] },
]

const bytes = (text: string) => new TextEncoder().encode(text)

/**
 * Alice adds an episode and a worker makes it: a timing file (unless `untimed` names the chapter) and audio for each
 * chapter, then the book file. `complete` makes it Ready.
 */
const made = async ({ untimed = -1, complete = true } = {}) => {
  const created = await app.alice("POST", "/api/episodes", {
    json: { source: { _tag: "Text", title: "Harbour", text: "The harbour is quiet." }, voice: null, speed: 1 },
  })
  const { id } = (await created.json()) as { id: string }
  const claim = await app.asWorker("POST", "/api/worker/claim", { json: { workerId: "w1", voices: [] } })
  const lease = ((await claim.json()) as { job: { leaseToken: string } }).job.leaseToken
  const query = `workerId=w1&leaseToken=${lease}`
  const put = (path: string, body: string) =>
    app.asWorker("PUT", path, { body: bytes(body), headers: { "content-type": "audio/mp4", "content-length": String(body.length) } })
  for (const [index, chapter] of chapters.entries()) {
    if (index !== untimed) {
      const timing = await app.asWorker("PUT", `/api/worker/jobs/${id}/chapters/${index}/timing?${query}`, {
        json: { segments: chapter.segments },
      })
      expect(timing.status).toBe(204)
    }
    const path = `/api/worker/jobs/${id}/chapters/${index}?${query}&title=${chapter.title}&durationMs=${chapter.durationMs}`
    expect((await put(path, "chapter")).status).toBe(204)
  }
  expect((await put(`/api/worker/jobs/${id}/book?${query}`, "book")).status).toBe(204)
  if (complete) {
    const done = await app.asWorker("POST", `/api/worker/jobs/${id}/complete`, {
      json: { workerId: "w1", leaseToken: lease, durationMs: 9_000 },
    })
    expect(done.status).toBe(204)
  }
  return id
}

const feed = async () => (await app.call(null, "GET", `/feed/${users.alice.feed}/rss.xml`)).text()
const transcriptPath = (id: string, feedToken = users.alice.feed) => `/media/${feedToken}/episodes/${id}/transcript.vtt`

const expected = [
  "WEBVTT",
  "",
  "00:00:00.300 --> 00:00:01.500",
  "Harbour Year.",
  "",
  "00:00:01.900 --> 00:00:03.990",
  "Boats &amp; &lt;nets&gt;.",
  "",
  "00:00:04.250 --> 00:00:06.000",
  "Evening.",
  "",
].join("\n")

it("a Ready episode with a timing file for each chapter has a transcript tag in the feed", async () => {
  const id = await made()
  const xml = await feed()
  expect(xml).toContain('xmlns:podcast="https://podcastindex.org/namespace/1.0"')
  expect(xml).toContain(`<podcast:transcript url="http://fama.test${transcriptPath(id)}" type="text/vtt"/>`)
})

it("the transcript is WebVTT on the episode timeline, and the API stores it for the Ready", async () => {
  const id = await made()
  const response = await app.call(null, "GET", transcriptPath(id))
  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toBe("text/vtt; charset=utf-8")
  expect(await response.text()).toBe(expected)

  const { job } = (await (await app.alice("GET", `/api/episodes/${id}`)).json()) as { job: { finishedAt: string } }
  const stored = `users/${users.alice.id}/episodes/${id}/transcript/${Date.parse(job.finishedAt)}.vtt`
  expect((await app.env.MEDIA.list()).objects.map((object) => object.key)).toContain(stored)

  // Served from the stored copy: the timing files are no longer read.
  await app.env.MEDIA.delete(`users/${users.alice.id}/episodes/${id}/chapters/000.json`)
  expect(await (await app.call(null, "GET", transcriptPath(id))).text()).toBe(expected)
})

it("the transcript answers HEAD and Range requests like other media", async () => {
  const id = await made()
  const head = await app.call(null, "HEAD", transcriptPath(id))
  expect(head.status).toBe(200)
  expect(head.headers.get("content-length")).toBe(String(bytes(expected).length))
  const range = await app.call(null, "GET", transcriptPath(id), { headers: { range: "bytes=0-5" } })
  expect(range.status).toBe(206)
  expect(await range.text()).toBe("WEBVTT")
})

it("an episode with a chapter that has no timing file has no transcript", async () => {
  const id = await made({ untimed: 1 })
  const xml = await feed()
  expect(xml).toContain(`/episodes/${id}/book.m4b`)
  expect(xml).not.toContain("<podcast:transcript")
  expect((await app.call(null, "GET", transcriptPath(id))).status).toBe(404)
})

it("an episode that is not Ready has no transcript yet", async () => {
  const id = await made({ complete: false })
  expect((await app.call(null, "GET", transcriptPath(id))).status).toBe(404)
})

it("the feed token guards the transcript: a wrong token is 401, another user's episode is 404", async () => {
  const id = await made()
  expect((await app.call(null, "GET", transcriptPath(id, "wrong"))).status).toBe(401)
  expect((await app.call(null, "GET", transcriptPath(id, users.bob.feed))).status).toBe(404)
})
