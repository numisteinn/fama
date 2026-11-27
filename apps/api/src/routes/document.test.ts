// The stored Document: the worker writes it once under its lease, a later claim points at it, and its owner reads it.
import { beforeAll, beforeEach, expect, it } from "vitest"
import { startApp, users, readJson, readNarrateJob } from "../test-app.ts"
import { Episode } from "@fama/contracts"

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
}

interface Claimed {
  readonly episodeId: string
  readonly leaseToken: string
  readonly documentPath: string | null
  readonly coverPath: string | null
}

const claim = async () => {
  const response = await app.asWorker("POST", "/api/worker/claim", { json: { workerId: "w1", voices: [] } })
  expect(response.status).toBe(200)
  return readNarrateJob(response)
}

/** Alice adds a text episode and a worker claims it. */
const claimed = async () => {
  const created = await app.alice("POST", "/api/episodes", {
    json: { source: { _tag: "Text", title: "Harbour", text: "The harbour is quiet." }, voice: null, speed: 1 },
  })
  expect(created.status).toBe(201)
  const job = await claim()
  expect(job.episodeId).toBe((await readJson(Episode, created)).id)
  return job
}

const putDocument = (job: Claimed, body: unknown, leaseToken = job.leaseToken) =>
  app.asWorker("PUT", `/api/worker/jobs/${job.episodeId}/document?workerId=w1&leaseToken=${leaseToken}`, { json: body })

/** The job fails, its owner retries it, and a worker claims it again. */
const claimedAgain = async (job: Claimed) => {
  const fail = await app.asWorker("POST", `/api/worker/jobs/${job.episodeId}/fail`, {
    json: { workerId: "w1", leaseToken: job.leaseToken, reason: "boom" },
  })
  expect(fail.status).toBe(204)
  expect((await app.alice("POST", `/api/episodes/${job.episodeId}/retry`)).status).toBe(200)
  return claim()
}

const keysOf = async () => (await app.env.MEDIA.list()).objects.map((object) => object.key)

it("a new claim has no Document, and the client route answers 404 until the worker stores one", async () => {
  const job = await claimed()
  expect(job.documentPath).toBeNull()
  expect(job.coverPath).toBeNull()
  const response = await app.alice("GET", `/api/episodes/${job.episodeId}/document`)
  expect(response.status).toBe(404)
  expect(await response.json()).toEqual({ error: "NotStored", message: "This episode has no Document." })
})

it("the worker stores the Document, its owner reads it, and the next claim points at it", async () => {
  const job = await claimed()
  const written = await putDocument(job, { ...document, cover: "not part of the shape" })
  expect(written.status).toBe(200)
  expect(await written.json()).toEqual({ next: "Narrate" })
  expect(await keysOf()).toEqual([expect.stringContaining(`users/${users.alice.id}/documents/${job.episodeId}/`)])

  const read = await app.alice("GET", `/api/episodes/${job.episodeId}/document`)
  expect(read.status).toBe(200)
  expect(read.headers.get("content-type")).toBe("application/json")
  expect(await read.json()).toEqual(document)

  const again = await claimedAgain(job)
  expect(again.documentPath).toBe(`/api/worker/jobs/${job.episodeId}/document`)
  const forWorker = await app.asWorker("GET", `${again.documentPath}?leaseToken=${again.leaseToken}`)
  expect(forWorker.status).toBe(200)
  expect(await forWorker.json()).toEqual(document)
})

it("reads Documents stored before the Review migration", async () => {
  const job = await claimed()
  const key = `users/${users.alice.id}/episodes/${job.episodeId}/document.json`
  const body = JSON.stringify(document)
  await app.env.MEDIA.put(key, body, { httpMetadata: { contentType: "application/json" } })
  await app.env.DB.prepare("UPDATE episodes SET document_size = ? WHERE id = ?").bind(body.length, job.episodeId).run()

  expect(await (await app.alice("GET", `/api/episodes/${job.episodeId}/document`)).json()).toEqual(document)
  const again = await claimedAgain(job)
  expect(await (await app.asWorker("GET", `${again.documentPath}?leaseToken=${again.leaseToken}`)).json()).toEqual(document)
})

it("a repeated upload under the same lease is safe", async () => {
  const job = await claimed()
  expect((await putDocument(job, document)).status).toBe(200)
  expect((await putDocument(job, document)).status).toBe(200)
  expect(await (await app.alice("GET", `/api/episodes/${job.episodeId}/document`)).json()).toEqual(document)
})

it("the Document routes need the current lease and the right token", async () => {
  const job = await claimed()
  const id = job.episodeId
  expect((await putDocument(job, document, "not-the-lease")).status).toBe(409)
  expect(await keysOf()).toEqual([])
  expect((await putDocument(job, document)).status).toBe(200)

  const again = await claimedAgain(job)
  expect((await putDocument(job, document)).status, "an old lease cannot replace the Document").toBe(409)
  expect((await app.asWorker("GET", `${again.documentPath}?leaseToken=${job.leaseToken}`)).status).toBe(409)
  expect((await app.asWorker("GET", `/api/worker/jobs/${id}/cover?leaseToken=${job.leaseToken}`)).status).toBe(409)
  expect((await app.asWorker("GET", `${again.documentPath}`)).status, "no lease").toBe(400)

  expect((await app.alice("PUT", `/api/worker/jobs/${id}/document?workerId=w1&leaseToken=${again.leaseToken}`, { json: document })).status).toBe(401)
  expect((await app.asWorker("GET", `/api/episodes/${id}/document`)).status).toBe(401)
  expect((await app.request(users.alice.feed, "GET", `/api/episodes/${id}/document`)).status).toBe(401)
})

it("a body that is not a Document is refused and stores nothing", async () => {
  const job = await claimed()
  for (const body of [{ ...document, chapters: [] }, { ...document, language: null }, { title: "No chapters" }, "text"]) {
    expect((await putDocument(job, body)).status, JSON.stringify(body)).toBe(400)
  }
  expect(await keysOf()).toEqual([])
  expect((await claimedAgain(job)).documentPath).toBeNull()
})

it("another user cannot read the Document, and deleting the episode deletes it", async () => {
  const job = await claimed()
  expect((await putDocument(job, document)).status).toBe(200)
  expect((await app.bob("GET", `/api/episodes/${job.episodeId}/document`)).status).toBe(404)
  expect((await app.alice("DELETE", `/api/episodes/${job.episodeId}`)).status).toBe(204)
  expect(await keysOf()).toEqual([])
  expect((await app.alice("GET", `/api/episodes/${job.episodeId}/document`)).status).toBe(404)
})

it("a claim after the cover upload points at the cover, and the worker reads it back", async () => {
  const job = await claimed()
  const id = job.episodeId
  const none = await app.asWorker("GET", `/api/worker/jobs/${id}/cover?leaseToken=${job.leaseToken}`)
  expect(none.status).toBe(404)
  const upload = await app.asWorker("PUT", `/api/worker/jobs/${id}/cover?workerId=w1&leaseToken=${job.leaseToken}`, {
    body: new TextEncoder().encode("png bytes"),
    headers: { "content-type": "image/png", "content-length": "9" },
  })
  expect(upload.status).toBe(204)

  const again = await claimedAgain(job)
  expect(again.coverPath).toBe(`/api/worker/jobs/${id}/cover`)
  const cover = await app.asWorker("GET", `${again.coverPath}?leaseToken=${again.leaseToken}`)
  expect(cover.status).toBe(200)
  expect(cover.headers.get("content-type")).toBe("image/png")
  expect(await cover.text()).toBe("png bytes")
})
