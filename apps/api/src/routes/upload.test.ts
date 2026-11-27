import { Episode } from "@fama/contracts"
import { beforeAll, beforeEach, expect, it } from "vitest"
import { startApp, readJson, readNarrateJob } from "../test-app.ts"

let app: Awaited<ReturnType<typeof startApp>>

beforeAll(async () => {
  app = await startApp()
  return () => app.dispose()
})
beforeEach(() => app.reset())

const source = { _tag: "Url", url: "https://example.com/news/harbour" } as const

async function claim() {
  const response = await app.asWorker("POST", "/api/worker/claim", { json: { workerId: "w1", voices: [] } })
  expect(response.status).toBe(200)
  return readNarrateJob(response)
}

it("keeps the Url source and serves its uploaded bytes to the worker holding the lease", async () => {
  const html = "<html lang=en><title>The Quiet Harbour</title></html>"
  const contentType = "text/html; charset=utf-8"
  const form = new FormData()
  form.set("url", source.url)
  form.set("file", new Blob([html], { type: contentType }), "page")

  const response = await app.alice("POST", "/api/episodes/upload", { body: form })
  expect(response.status).toBe(201)
  const episode = await readJson(Episode, response)
  expect(episode).toMatchObject({ source, title: "example.com/news/harbour" })

  const job = await claim()
  expect(job).toMatchObject({ episodeId: episode.id, source, sourcePath: `/api/worker/jobs/${episode.id}/source` })
  const uploaded = await app.asWorker("GET", `${job.sourcePath}?leaseToken=${job.leaseToken}`)
  expect(uploaded.status).toBe(200)
  expect(uploaded.headers.get("content-type")).toBe(contentType)
  expect(await uploaded.text()).toBe(html)
})

it("claims a link submitted without bytes with a null sourcePath", async () => {
  const response = await app.alice("POST", "/api/episodes", { json: { source, voice: null, speed: 1 } })
  expect(response.status).toBe(201)
  expect(await claim()).toMatchObject({ source, sourcePath: null })
})
