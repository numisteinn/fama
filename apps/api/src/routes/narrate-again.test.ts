import { type ClaimedJob, type Document, Episode } from "@fama/contracts"
import { beforeAll, beforeEach, expect, it } from "vitest"
import { keys } from "../media-store.ts"
import { startApp, users, readJson, readNarrateJob } from "../test-app.ts"
import { required } from "../../../../test/required.ts"

let app: Awaited<ReturnType<typeof startApp>>
beforeAll(async () => {
  app = await startApp()
  return () => app.dispose()
})
beforeEach(() => app.reset())

const original = {
  title: "Harbour Days", author: null, language: "en",
  chapters: [{ title: "Morning", text: "Quiet water." }, { title: "Evening", text: "The boats come home." }],
} satisfies Document
const edited = { ...original, chapters: [required(original.chapters[0]), { ...required(original.chapters[1]), text: "The boats stay out." }] }
const voice = { voice: "kokoro:af_heart", speed: 1.25 }
const inputHash = "a".repeat(64)
const nextHash = "b".repeat(64)

const claim = async () => {
  const response = await app.asWorker("POST", "/api/worker/claim", { json: { workerId: "w1", voices: [] } })
  expect(response.status).toBe(200)
  return readNarrateJob(response)
}
const add = async () => {
  const response = await app.alice("POST", "/api/episodes", {
    json: { source: { _tag: "Text", title: null, text: required(original.chapters[0]).text }, voice: null, speed: 1 },
  })
  expect(response.status).toBe(201)
  return (await readJson(Episode, response)).id
}
const apiPath = (id: string) => `/api/episodes/${id}`
const view = async (id: string) => await readJson(Episode, await app.alice("GET", apiPath(id)))
const workerPath = (job: ClaimedJob, path: string, query = "") =>
  `/api/worker/jobs/${job.episodeId}/${path}?workerId=w1&leaseToken=${job.leaseToken}${query}`
const putTiming = (job: ClaimedJob, index: number, hash: string, text: string) =>
  app.asWorker("PUT", workerPath(job, `chapters/${index}/timing`, `&inputHash=${hash}`), {
    json: { segments: [{ text, startMs: 0, endMs: 2000, endsParagraph: true }] },
  })
const putBytes = (job: ClaimedJob, path: string, body: string, query = "") =>
  app.asWorker("PUT", workerPath(job, path, query), {
    body: new TextEncoder().encode(body), headers: { "content-length": String(body.length), "content-type": "audio/mp4" },
  })
const putAudio = (job: ClaimedJob, index: number, hash: string, durationMs: number, body: string) =>
  putBytes(job, `chapters/${index}`, body, `&title=Chapter&inputHash=${hash}&durationMs=${durationMs}`)
const finish = (job: ClaimedJob, end: "complete" | "fail", durationMs = 20_000) =>
  app.asWorker("POST", `/api/worker/jobs/${job.episodeId}/${end}`, {
    json: { workerId: "w1", leaseToken: job.leaseToken, durationMs, reason: "interrupted" },
  })
const storeDocument = (job: ClaimedJob) =>
  app.asWorker("PUT", workerPath(job, "document"), { json: original })

it("publishes the new audio and timing together, remaps progress and rebuilds the transcript", async () => {
  const id = await add()
  const path = apiPath(id)
  const first = await claim()
  expect((await storeDocument(first)).status).toBe(200)
  for (const [i, chapter] of original.chapters.entries()) {
    expect((await putTiming(first, i, inputHash, chapter.text)).status).toBe(204)
    expect((await putAudio(first, i, inputHash, 10_000, `audio-${i}`)).status).toBe(204)
  }
  expect((await putBytes(first, "book", "first book")).status).toBe(204)
  expect((await finish(first, "complete")).status).toBe(204)
  const before = await view(id)
  const transcriptPath = `/media/${users.alice.feed}/episodes/${id}/transcript.vtt`
  expect(await (await app.request(null, "GET", transcriptPath)).text()).toContain(required(original.chapters[1]).text)
  if (before.job._tag !== "Ready") throw new Error("Expected Ready")
  const transcriptKey = keys.transcriptRevision(users.alice.id, id, before.job.finishedAt)
  expect(await app.env.MEDIA.head(transcriptKey)).not.toBeNull()
  const progress = { positionMs: 15_000, updatedAt: "2026-01-01T00:00:00.000Z" }
  expect((await app.alice("PUT", `${path}/progress`, { json: progress })).status).toBe(200)

  expect((await app.alice("PUT", `${path}/document`, { json: edited })).status).toBe(204)
  expect(await view(id)).toMatchObject({ job: { _tag: "Queued" }, bookUrl: null, chapters: before.chapters, progress })
  expect(await app.env.MEDIA.head(transcriptKey)).toBeNull()
  expect((await app.request(null, "GET", transcriptPath)).status).toBe(404)

  const again = await claim()
  expect(again.chapters).toEqual([{ index: 0, inputHash }, { index: 1, inputHash }])
  expect(await (await app.asWorker("GET", workerPath(again, "document"))).json()).toEqual(edited)
  expect(await (await app.asWorker("GET", workerPath(again, "chapters/0"))).text()).toBe("audio-0")
  expect((await putTiming(first, 1, nextHash, "old worker")).status).toBe(409)
  expect((await putTiming(again, 1, nextHash, required(edited.chapters[1]).text)).status).toBe(204)
  expect((await view(id)).chapters).toEqual(before.chapters)
  expect(await (await app.request(null, "GET", required(before.chapters[1]).url)).text()).toBe("audio-1")

  expect((await putAudio(again, 1, nextHash, 6000, "edited audio")).status).toBe(204)
  expect((await putAudio(again, 1, nextHash, 6000, "edited audio")).status).toBe(204)
  const running = await view(id)
  expect(running.chapters[0]).toEqual(before.chapters[0])
  expect(required(running.chapters[1]).url).not.toBe(required(before.chapters[1]).url)
  expect(required(running.chapters[1]).timingUrl).not.toBe(required(before.chapters[1]).timingUrl)
  expect(await (await app.request(null, "GET", required(running.chapters[1]).url)).text()).toBe("edited audio")
  expect(await (await app.request(null, "GET", required(required(running.chapters[1]).timingUrl))).text()).toContain(required(edited.chapters[1]).text)
  expect(running.progress?.positionMs).toBe(13_000)
  expect(required(running.progress).updatedAt > progress.updatedAt).toBe(true)

  expect((await putBytes(again, "book", "new book")).status).toBe(204)
  expect((await finish(again, "complete", 16_000)).status).toBe(204)
  const ready = await view(id)
  expect(ready.durationMs).toBe(16_000)
  expect(ready.bookUrl).not.toBe(before.bookUrl)
  expect(await (await app.request(null, "GET", required(ready.bookUrl))).text()).toBe("new book")
  const transcript = await (await app.request(null, "GET", transcriptPath)).text()
  expect(transcript).toContain(required(edited.chapters[1]).text)
  expect(transcript).not.toContain(required(original.chapters[1]).text)
})

it("guards editing by owner and state and only allows chapter text to change after narration starts", async () => {
  const id = await add()
  const path = apiPath(id)
  const document = (body: unknown) => app.alice("PUT", `${path}/document`, { json: body })
  const changeVoice = (body: unknown) => app.alice("PUT", `${path}/voice`, { json: body })
  expect((await document(edited)).status).toBe(409)
  expect((await changeVoice(voice)).status).toBe(409)
  const job = await claim()
  expect((await storeDocument(job)).status).toBe(200)
  expect((await document(edited)).status).toBe(409)
  expect((await changeVoice(voice)).status).toBe(409)
  expect((await finish(job, "fail")).status).toBe(204)
  expect((await app.bob("PUT", `${path}/document`, { json: edited })).status).toBe(404)
  expect((await app.bob("PUT", `${path}/voice`, { json: voice })).status).toBe(404)
  expect((await document({ ...edited, title: "New title" })).status).toBe(400)
  expect((await document({ ...edited, chapters: edited.chapters.toReversed() })).status).toBe(400)
  expect((await document({ ...edited, chapters: edited.chapters.slice(1) })).status).toBe(400)
  expect((await document(edited)).status).toBe(204)
  const again = await claim()
  expect((await finish(again, "fail")).status).toBe(204)
  expect((await changeVoice({ ...voice, speed: 0 })).status).toBe(400)
  expect((await changeVoice(voice)).status).toBe(204)
  expect(await claim()).toMatchObject(voice)
})
