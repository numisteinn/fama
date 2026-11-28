import { MissingVoicePreviews, Voice } from "@fama/contracts"
import { beforeAll, beforeEach, expect, it } from "vitest"
import { keys } from "../media-store.ts"
import { readJson, startApp } from "../test-app.ts"

const heart = { id: "kokoro:af_heart", engine: "kokoro", name: "Heart", language: "en", gender: "female" }
const salka = { id: "piper:is_IS-salka-medium", engine: "piper", name: "Salka", language: "is", gender: "female" }
const workerPath = "/api/worker/voices"
const missingPath = `${workerPath}/missing-previews`
const id = encodeURIComponent(heart.id)
const uploadPath = `${workerPath}/${id}/preview`
const mediaPath = `/voice-previews/${id}`
const immutable = "public, max-age=31536000, immutable"
const clip = "an m4a clip"
const audio = (body = clip, type = "audio/mp4") => ({
  body,
  headers: { "content-type": type, "content-length": String(body.length) },
})

let app: Awaited<ReturnType<typeof startApp>>

beforeAll(async () => {
  app = await startApp()
  return () => app.dispose()
})
beforeEach(() => app.reset())

const register = (voices = [heart, salka]) => app.asWorker("POST", workerPath, { json: { voices } })

const uploadPreview = async (body = clip, type = "audio/mp4") => {
  const response = await app.asWorker("PUT", uploadPath, audio(body, type))
  expect(response.status).toBe(200)
  const voice = await readJson(Voice, response)
  expect(voice.previewUrl).toMatch(new RegExp(`^${mediaPath}\\?v=[a-f0-9]{16}$`))
  return voice
}

it("registers old Voice payloads without leasing work and lists only unpublished previews", async () => {
  expect(await readJson(MissingVoicePreviews, await app.asWorker("GET", missingPath))).toEqual({ voiceIds: [] })
  const created = await app.alice("POST", "/api/episodes", {
    json: { source: { _tag: "Text", text: "A story.", title: null }, voice: null, speed: 1 },
  })
  expect(created.status).toBe(201)
  expect((await register()).status).toBe(204)
  expect(await app.alice("GET", "/api/voices").then((response) => response.json())).toEqual({
    voices: [{ ...heart, previewUrl: null }, { ...salka, previewUrl: null }],
  })
  const pending = await app.asWorker("GET", missingPath)
  expect(pending.status).toBe(200)
  expect(await readJson(MissingVoicePreviews, pending)).toEqual({ voiceIds: [heart.id, salka.id] })
  const voice = await uploadPreview()
  expect(await readJson(MissingVoicePreviews, await app.asWorker("GET", missingPath))).toEqual({ voiceIds: [salka.id] })

  const claim = await app.asWorker("POST", "/api/worker/claim", {
    json: { workerId: "test-worker", voices: [heart] },
  })
  expect(claim.status).toBe(200)
  expect(await app.alice("GET", "/api/voices").then((response) => response.json())).toEqual({
    voices: [voice, { ...salka, previewUrl: null }],
  })
})

it("requires a worker token, a registered Voice and a non-empty audio body", async () => {
  expect((await app.request(null, "GET", missingPath)).status).toBe(401)
  expect((await app.alice("POST", workerPath, { json: { voices: [heart] } })).status).toBe(401)
  expect((await app.request(null, "PUT", uploadPath, audio())).status).toBe(401)
  expect((await app.asWorker("PUT", uploadPath, audio())).status).toBe(404)
  expect((await register()).status).toBe(204)
  expect((await app.asWorker("PUT", uploadPath, audio(clip, "text/plain"))).status).toBe(400)
  expect((await app.asWorker("PUT", uploadPath, audio(""))).status).toBe(400)
  expect((await app.env.MEDIA.list()).objects).toEqual([])
})

it("serves public GET, HEAD and a byte range with the requested caching", async () => {
  expect((await register()).status).toBe(204)
  expect((await app.request(null, "GET", mediaPath)).status).toBe(404)
  const { previewUrl } = await uploadPreview()
  if (previewUrl === null) throw new Error("Expected a preview URL")

  const get = await app.request(null, "GET", previewUrl, { headers: { origin: "http://client.test" } })
  expect(get.status).toBe(200)
  expect(get.headers.get("content-type")).toBe("audio/mp4")
  expect(get.headers.get("cache-control")).toBe(immutable)
  expect(get.headers.get("access-control-allow-origin")).toBe("*")
  expect(await get.text()).toBe(clip)

  const head = await app.request(null, "HEAD", previewUrl)
  expect(head.status).toBe(200)
  expect(head.headers.get("content-length")).toBe(String(clip.length))
  expect(head.headers.get("accept-ranges")).toBe("bytes")
  expect(head.headers.get("cache-control")).toBe(immutable)
  expect(await head.text()).toBe("")

  const range = await app.request(null, "GET", previewUrl, { headers: { range: "bytes=3-5" } })
  expect(range.status).toBe(206)
  expect(range.headers.get("content-range")).toBe(`bytes 3-5/${clip.length}`)
  expect(range.headers.get("cache-control")).toBe(immutable)
  expect(await range.text()).toBe(clip.slice(3, 6))

  const unversioned = await app.request(null, "GET", mediaPath)
  expect(unversioned.status).toBe(200)
  expect(unversioned.headers.get("cache-control")).toBe("public, max-age=300")
  expect(await unversioned.text()).toBe(clip)
})

it("replaces the R2 clip and publishes a new URL on regeneration", async () => {
  expect((await register()).status).toBe(204)
  const first = await uploadPreview()
  const second = await uploadPreview("replacement", "audio/x-m4a")
  expect(second.previewUrl).not.toBe(first.previewUrl)
  const object = await app.env.MEDIA.get(keys.voicePreview(heart.id))
  expect(await object?.text()).toBe("replacement")
})

it.each(["kokoro:..", "kokoro:../secret", "kokoro:..\\secret", "kokoro:af_heart/extra", "not-a-voice"])(
  "rejects invalid preview IDs even when the R2 object exists (%s)",
  async (unsafeId) => {
    await app.env.MEDIA.put(keys.voicePreview(unsafeId), clip)
    const encoded = encodeURIComponent(unsafeId)
    expect((await app.request(null, "GET", `/voice-previews/${encoded}?v=1`)).status).toBe(404)
    expect((await app.request(null, "HEAD", `/voice-previews/${encoded}`)).status).toBe(404)
    expect((await app.asWorker("PUT", `${workerPath}/${encoded}/preview`, audio())).status).toBe(404)
  },
)
