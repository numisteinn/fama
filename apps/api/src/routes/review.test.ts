import { type ClaimedJob, type Document, Episode } from "@fama/contracts"
import { beforeAll, beforeEach, expect, it } from "vitest"
import { startApp, readJson, readNarrateJob } from "../test-app.ts"

let app: Awaited<ReturnType<typeof startApp>>

beforeAll(async () => {
  app = await startApp()
  return () => app.dispose()
})
beforeEach(() => app.reset())

const document = {
  title: "Harbour Days",
  author: "Fama Fixtures",
  language: "en",
  chapters: [
    { title: "Morning", text: "The harbour is quiet." },
    { title: "Evening", text: "The boats come home." },
  ],
} satisfies Document

const kept = { ...document, chapters: [{ title: "Evening", text: "The boats come home after dark." }] }

const claim = () => app.asWorker("POST", "/api/worker/claim", { json: { workerId: "w1", voices: [] } })

const add = async () => {
  const response = await app.alice("POST", "/api/episodes", {
    json: { source: { _tag: "Text", title: null, text: "A day at sea." }, voice: null, speed: 1, review: true },
  })
  expect(response.status).toBe(201)
  return (await readJson(Episode, response)).id
}

const take = async () => {
  const response = await claim()
  expect(response.status).toBe(200)
  return readNarrateJob(response)
}

const upload = (job: ClaimedJob) =>
  app.asWorker("PUT", `/api/worker/jobs/${job.episodeId}/document?workerId=w1&leaseToken=${job.leaseToken}&voice=kokoro%3Aaf_heart`, {
    json: document,
  })

const review = async () => {
  const id = await add()
  const job = await take()
  expect(job.episodeId).toBe(id)
  expect(job.documentPath).toBeNull()
  const stored = await upload(job)
  expect(stored.status).toBe(200)
  expect(await stored.json()).toEqual({ next: "Review" })
  return job
}

const episodePath = (id: string) => `/api/episodes/${id}`

it("ends the lease and exposes the extracted metadata and Document before narration", async () => {
  const job = await review()
  const path = episodePath(job.episodeId)
  expect(await (await app.alice("GET", path)).json()).toMatchObject({
    title: document.title,
    author: document.author,
    language: document.language,
    voice: "kokoro:af_heart",
    job: { _tag: "Review" },
    chapters: [],
    bookUrl: null,
  })
  expect(await (await app.alice("GET", `${path}/document`)).json()).toEqual(document)
  expect((await claim()).status).toBe(204)
  expect((await app.alice("POST", `${path}/retry`)).status).toBe(409)
  expect((await upload(job)).status).toBe(409)
  const fail = await app.asWorker("POST", `/api/worker/jobs/${job.episodeId}/fail`, {
    json: { workerId: "w1", leaseToken: job.leaseToken, reason: "lost response" },
  })
  expect(fail.status).toBe(409)
})

it("lets the owner edit and start with the kept chapters in their new order", async () => {
  const job = await review()
  const path = episodePath(job.episodeId)
  const edited = { ...document, chapters: [document.chapters[0], ...kept.chapters] }
  expect((await app.bob("PUT", `${path}/document`, { json: edited })).status).toBe(404)
  expect((await app.bob("POST", `${path}/start`, { json: { document: kept } })).status).toBe(404)
  expect((await app.alice("PUT", `${path}/document`, { json: { ...edited, chapters: [] } })).status).toBe(400)
  expect((await app.alice("POST", `${path}/start`, { json: { document: { ...edited, chapters: [] } } })).status).toBe(400)
  expect((await app.alice("PUT", `${path}/document`, { json: edited })).status).toBe(204)
  expect(await (await app.alice("GET", `${path}/document`)).json()).toEqual(edited)

  const started = await app.alice("POST", `${path}/start`, { json: { document: kept } })
  expect(started.status).toBe(200)
  expect(await started.json()).toMatchObject({ job: { _tag: "Queued" } })
  expect((await app.alice("POST", `${path}/start`, { json: { document: edited } })).status).toBe(409)
  expect((await app.alice("PUT", `${path}/document`, { json: edited })).status).toBe(409)

  const next = await take()
  expect(next.leaseToken).not.toBe(job.leaseToken)
  expect(next.chapters).toEqual([])
  expect(next.documentPath).toBe(`/api/worker/jobs/${job.episodeId}/document`)
  const stored = await app.asWorker("GET", `${next.documentPath}?leaseToken=${next.leaseToken}`)
  expect(await stored.json()).toEqual(kept)
})

it("keeps the winning Document when a second start was already writing to R2", async () => {
  const job = await review()
  const path = episodePath(job.episodeId)
  const media = app.env.MEDIA
  const put = media.put.bind(media)
  const staged = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  media.put = async (key, value, options) => {
    media.put = put
    staged.resolve()
    await resume.promise
    return put(key, value, options)
  }

  const late = app.alice("POST", `${path}/start`, { json: { document } })
  try {
    await staged.promise
    expect((await app.alice("POST", `${path}/start`, { json: { document: kept } })).status).toBe(200)
    const next = await take()
    resume.resolve()
    expect((await late).status).toBe(409)
    const stored = await app.asWorker("GET", `${next.documentPath}?leaseToken=${next.leaseToken}`)
    expect(await stored.json()).toEqual(kept)
  } finally {
    media.put = put
    resume.resolve()
    await late
  }
})

it("lets the owner change voice in Review without queuing and override voice or speed at Start", async () => {
  const job = await review()
  const path = episodePath(job.episodeId)
  expect((await app.alice("PUT", `${path}/voice`, { json: { voice: "kokoro:af_bella", speed: 1.15 } })).status).toBe(204)
  expect(await (await app.alice("GET", path)).json()).toMatchObject({
    voice: "kokoro:af_bella",
    speed: 1.15,
    job: { _tag: "Review" },
  })
  expect((await claim()).status).toBe(204)

  const started = await app.alice("POST", `${path}/start`, {
    json: { document: kept, voice: "kokoro:am_adam", speed: 1.25 },
  })
  expect(started.status).toBe(200)
  expect(await started.json()).toMatchObject({
    voice: "kokoro:am_adam",
    speed: 1.25,
    job: { _tag: "Queued" },
  })
  const next = await take()
  expect(next.voice).toBe("kokoro:am_adam")
  expect(next.speed).toBe(1.25)
})

it("deletes a Review episode and its Document with no remaining work", async () => {
  const job = await review()
  const path = episodePath(job.episodeId)
  expect((await app.bob("DELETE", path)).status).toBe(404)
  expect((await app.alice("DELETE", path)).status).toBe(204)
  expect((await app.alice("GET", `${path}/document`)).status).toBe(404)
  expect((await app.alice("POST", `${path}/start`, { json: { document: kept } })).status).toBe(404)
  expect((await claim()).status).toBe(204)
  expect((await app.env.MEDIA.list()).objects).toEqual([])
})
