import { ClaimResponse, SAMPLE_LEASE_MS, SampleList } from "@fama/contracts"
import { Schema } from "effect"
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest"
import { startApp, users } from "../test-app.ts"

const voice = { id: "piper:is_IS-salka-medium", engine: "piper", name: "Salka", language: "is", gender: "female" }
const secondVoice = { ...voice, id: "piper:is_IS-steinn-medium", name: "Steinn", gender: "male" }
const english = { id: "kokoro:af_heart", engine: "kokoro", name: "Heart", language: "en-US", gender: "female" }
const document = { title: "Höfnin", author: null, language: "is", chapters: [{ title: "Höfnin", text: "Höfnin vaknar." }] }
let app: Awaited<ReturnType<typeof startApp>>

beforeAll(async () => { app = await startApp() })
beforeEach(() => app.reset())
afterAll(() => app?.dispose())

const claim = (workerId: string, voices = [voice, secondVoice, english]) =>
  app.asWorker("POST", "/api/worker/claim", { json: { workerId, voices } })

const claimed = async (response: Response) => {
  expect(response.status).toBe(200)
  return Schema.decodeUnknownSync(ClaimResponse)(await response.json()).work
}

const listed = async (response: Response) => {
  expect(response.status).toBe(200)
  return Schema.decodeUnknownSync(SampleList)(await response.json()).samples
}

const episode = async () => {
  const response = await app.alice("POST", "/api/episodes", {
    json: { source: { _tag: "Text", title: "Höfnin", text: "Höfnin vaknar." }, voice: null, speed: 1.25 },
  })
  expect(response.status).toBe(201)
  const { id } = await response.json() as { id: string }
  return id
}

const stored = async (id: string) => {
  const work = await claimed(await claim("mac"))
  expect(work).toMatchObject({ _tag: "Narrate", episodeId: id })
  const query = new URLSearchParams({ workerId: "mac", leaseToken: work.leaseToken })
  expect((await app.asWorker("PUT", `/api/worker/jobs/${id}/document?${query}`, { json: document })).status).toBe(204)
}

const clip = (id: string, voiceId: string, leaseToken: string, body = "sample audio") => {
  const query = new URLSearchParams({ voice: voiceId, leaseToken })
  return app.asWorker("PUT", `/api/worker/samples/${id}/clip?${query}`, {
    body, headers: { "content-type": "audio/mp4", "content-length": String(body.length) },
  })
}

it("lists only the owner's Samples and requests each registered Voice of the Document language once", async () => {
  const id = await episode()
  const url = `/api/episodes/${id}/samples`
  expect((await app.alice("POST", url)).status).toBe(404)
  expect(await listed(await app.alice("GET", url))).toEqual([])
  await stored(id)
  expect((await app.bob("POST", url)).status).toBe(404)
  expect((await app.bob("GET", url)).status).toBe(404)
  expect((await app.alice("POST", url, { json: { voices: [english.id] } })).status).toBe(400)
  expect((await app.alice("POST", url, { json: { voices: ["piper:../x"] } })).status).toBe(400)
  const asked = await listed(await app.alice("POST", url))
  expect(asked).toEqual([voice, secondVoice].map(({ id }) => ({ voice: id, state: { _tag: "Requested" } })))
  expect(await listed(await app.alice("POST", url, { json: {} }))).toEqual(asked)

  const [first, second] = await Promise.all([claim("one", []).then(claimed), claim("two", []).then(claimed)])
  expect(first).toMatchObject({ _tag: "Sample", episodeId: id, speed: 1.25 })
  expect(second).toMatchObject({ _tag: "Sample", episodeId: id, speed: 1.25 })
  expect(new Set([first.voice, second.voice])).toEqual(new Set([voice.id, secondVoice.id]))
  expect((await claim("three", [])).status).toBe(204)
})

it("recovers an expired Sample lease, claims Samples first, and serves and deletes private clips", async () => {
  const id = await episode()
  const url = `/api/episodes/${id}/samples`
  await stored(id)
  const queued = await episode()
  await listed(await app.alice("POST", url, { json: { voices: [voice.id, voice.id] } }))
  const old = await claimed(await claim("old", []))
  expect(old).toMatchObject({ _tag: "Sample", episodeId: id, voice: voice.id })
  expect((await claimed(await claim("another", []))).episodeId).toBe(queued)
  const expired = new Date(Date.now() - SAMPLE_LEASE_MS - 1000).toISOString()
  await app.env.DB.prepare("UPDATE samples SET claimed_at = ? WHERE episode_id = ?").bind(expired, id).run()
  expect((await clip(id, voice.id, old.leaseToken)).status).toBe(409)
  const fresh = await claimed(await claim("fresh", []))
  expect(fresh).toMatchObject({ _tag: "Sample", episodeId: id, voice: voice.id })
  expect(fresh.leaseToken).not.toBe(old.leaseToken)

  if (fresh._tag !== "Sample") throw new Error("Expected Sample work")
  const query = new URLSearchParams({ voice: fresh.voice, leaseToken: fresh.leaseToken })
  const read = await app.asWorker("GET", `${fresh.documentPath}?${query}`)
  expect(await read.json()).toEqual(document)
  expect((await clip(id, voice.id, old.leaseToken)).status).toBe(409)
  await app.env.MEDIA.put(`users/${users.alice.id}/episodes/${id}/samples/${voice.id}.m4a`, "sample audio")
  expect((await clip(id, voice.id, fresh.leaseToken, "retry audio")).status).toBe(204)
  expect((await clip(id, voice.id, fresh.leaseToken, "different audio")).status).toBe(204)
  const [sample] = await listed(await app.alice("GET", url))
  if (sample?.state._tag !== "Ready") throw new Error("Expected a Ready Sample")
  const path = sample.state.url
  expect(path).toContain("piper%3A")
  const range = await app.call(null, "GET", path, { headers: { range: "bytes=0-5" } })
  expect(range.status).toBe(206)
  expect(range.headers.get("content-type")).toBe("audio/mp4")
  expect(await range.text()).toBe("sample")
  expect((await app.call(null, "GET", path.replace(users.alice.feed, users.bob.feed))).status).toBe(404)
  expect(await listed(await app.alice("POST", url, { json: { voices: [voice.id] } }))).toEqual([sample])
  expect((await claim("empty", [])).status).toBe(204)

  expect((await app.alice("DELETE", `/api/episodes/${id}`)).status).toBe(204)
  expect((await app.call(null, "GET", path)).status).toBe(404)
  expect(await app.env.DB.prepare("SELECT voice FROM samples WHERE episode_id = ?").bind(id).first()).toBeNull()
})

it("retries one failed Sample without changing the Episode or the other voice", async () => {
  const id = await episode()
  const url = `/api/episodes/${id}/samples`
  await stored(id)
  await listed(await app.alice("POST", url))
  const work = await claimed(await claim("mac", []))
  const reason = "This Worker does not have the voice."
  const json = { voice: work.voice, leaseToken: work.leaseToken, reason }
  const fail = `/api/worker/samples/${id}/fail`
  expect((await app.asWorker("POST", fail, { json })).status).toBe(204)
  expect((await app.asWorker("POST", fail, { json: { ...json, reason: "Changed" } })).status).toBe(204)
  expect((await clip(id, voice.id, work.leaseToken)).status).toBe(409)
  expect(await listed(await app.alice("GET", url))).toContainEqual({
    voice: work.voice, state: { _tag: "Failed", reason },
  })
  const other = await claimed(await claim("mac", []))
  expect(other).toMatchObject({ _tag: "Sample", voice: secondVoice.id })
  expect((await clip(id, secondVoice.id, other.leaseToken)).status).toBe(204)
  const asked = await listed(await app.alice("POST", url))
  expect(asked.map((sample) => sample.state._tag)).toEqual(["Requested", "Ready"])
  const retried = await claimed(await claim("mac", []))
  expect(retried).toMatchObject({ _tag: "Sample", voice: voice.id })
  expect(retried.leaseToken).not.toBe(work.leaseToken)
  expect((await app.alice("GET", `/api/episodes/${id}`).then((response) => response.json()))).toMatchObject({
    job: { _tag: "Running" },
  })
})
