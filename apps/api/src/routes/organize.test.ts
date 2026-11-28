// Library organization: the owner renames an episode and moves it in and out of the archive. Archived episodes
// stay in the library with their audio, but the feed leaves them out.
import { Episode, EpisodeList } from "@fama/contracts"
import { beforeAll, beforeEach, expect, it } from "vitest"
import { readJson, readNarrateJob, startApp, users } from "../test-app.ts"
import { required } from "../../../../test/required.ts"

let app: Awaited<ReturnType<typeof startApp>>

beforeAll(async () => {
  app = await startApp()
  return () => app.dispose()
})
beforeEach(() => app.reset())

const bytes = (text: string) => new TextEncoder().encode(text)
const inputHash = "a".repeat(64)

/** Alice adds a text episode, with the provisional title and no author. */
const addEpisode = async () => {
  const created = await app.alice("POST", "/api/episodes", {
    json: { source: { _tag: "Text", title: "Harbour", text: "The harbour is quiet." }, voice: null, speed: 1 },
  })
  expect(created.status).toBe(201)
  return readJson(Episode, created)
}

/** A Ready episode with a book file: the kind the feed lists. */
const readyEpisode = async () => {
  const episode = await addEpisode()
  const job = await readNarrateJob(await app.asWorker("POST", "/api/worker/claim", { json: { workerId: "w1", voices: [] } }))
  expect(job.episodeId).toBe(episode.id)
  const lease = job.leaseToken
  const put = (path: string, body: string) =>
    app.asWorker("PUT", path, {
      body: bytes(body),
      headers: { "content-type": "audio/mp4", "content-length": String(body.length) },
    })
  const chapter =
    `/api/worker/jobs/${episode.id}/chapters/0?workerId=w1&leaseToken=${lease}&title=One&durationMs=1000&inputHash=${inputHash}`
  expect((await put(chapter, "chapter")).status).toBe(204)
  expect((await put(`/api/worker/jobs/${episode.id}/book?workerId=w1&leaseToken=${lease}`, "book")).status).toBe(204)
  const complete = await app.asWorker("POST", `/api/worker/jobs/${episode.id}/complete`, {
    json: { workerId: "w1", leaseToken: lease, durationMs: 1000 },
  })
  expect(complete.status).toBe(204)
  return readJson(Episode, await app.alice("GET", `/api/episodes/${episode.id}`))
}

const patch = (id: string, json: unknown) => app.alice("PATCH", `/api/episodes/${id}`, { json })
const view = async (id: string) => readJson(Episode, await app.alice("GET", `/api/episodes/${id}`))
const inFeed = async (id: string) =>
  (await (await app.request(null, "GET", `/feed/${users.alice.feed}/rss.xml`)).text())
    .includes(`<guid isPermaLink="false">${id}</guid>`)

it("renames the title, sets and clears the author", async () => {
  const episode = await addEpisode()
  const renamed = await patch(episode.id, { title: "  Harbour Nights  ", author: "  Fama Fixtures  " })
  expect(renamed.status).toBe(200)
  const after = await readJson(Episode, renamed)
  expect(after.title).toBe("Harbour Nights")
  expect(after.author).toBe("Fama Fixtures")

  const long = await patch(episode.id, { title: "x".repeat(300) })
  expect(long.status).toBe(200)

  const cleared = await readJson(Episode, await patch(episode.id, { author: null }))
  expect(cleared.author).toBeNull()
  expect(cleared.title).toBe("x".repeat(300))
})

it("archives and unarchives, and the library list keeps the episode either way", async () => {
  const episode = await addEpisode()
  expect((await view(episode.id)).archivedAt).toBeNull()

  const archived = await readJson(Episode, await patch(episode.id, { archived: true }))
  expect(archived.archivedAt).not.toBeNull()
  const listed = await readJson(EpisodeList, await app.alice("GET", "/api/episodes"))
  expect(listed.episodes.map((one) => one.id)).toEqual([episode.id])
  expect(listed.episodes[0]?.archivedAt).toBe(archived.archivedAt)

  const back = await readJson(Episode, await patch(episode.id, { archived: false }))
  expect(back.archivedAt).toBeNull()
})

it("archiving again keeps the first stamp", async () => {
  const episode = await addEpisode()
  const first = "2021-01-01T00:00:00.000Z"
  await app.env.DB.prepare("UPDATE episodes SET archived_at = ? WHERE id = ?").bind(first, episode.id).run()
  const again = await readJson(Episode, await patch(episode.id, { archived: true }))
  expect(again.archivedAt).toBe(first)
})

it("another user's episode is not found, and nothing of theirs changes", async () => {
  const episode = await addEpisode()
  expect((await app.bob("PATCH", `/api/episodes/${episode.id}`, { json: { title: "Bob's" } })).status).toBe(404)
  expect((await app.bob("PATCH", `/api/episodes/no-such-episode`, { json: { title: "Bob's" } })).status).toBe(404)
  expect((await app.request(users.alice.feed, "PATCH", `/api/episodes/${episode.id}`, { json: { title: "X" } })).status).toBe(401)
  expect((await view(episode.id)).title).toBe("Harbour")
})

it("refuses an empty body, a blank or too long field, and a wrong type", async () => {
  const episode = await addEpisode()
  const before = await view(episode.id)
  for (const body of [{}, { title: "   " }, { title: "x".repeat(301) }, { author: "  " }, { archived: "yes" }]) {
    const response = await patch(episode.id, body)
    expect(response.status, JSON.stringify(body)).toBe(400)
  }
  expect((await app.alice("PATCH", `/api/episodes/${episode.id}`)).status).toBe(400)
  expect(await view(episode.id)).toEqual(before)
})

it("the feed leaves an archived episode out and takes it back, keeping its audio", async () => {
  const episode = await readyEpisode()
  expect(await inFeed(episode.id)).toBe(true)

  const archived = await readJson(Episode, await patch(episode.id, { archived: true }))
  expect(archived.archivedAt).not.toBeNull()
  expect(await inFeed(episode.id)).toBe(false)
  const xml = await (await app.request(null, "GET", `/feed/${users.alice.feed}/rss.xml`)).text()
  expect(xml).not.toContain("<item>")
  // Archiving deletes no audio: the book file stays served.
  expect((await app.request(null, "GET", required(episode.bookUrl))).status).toBe(200)

  expect((await patch(episode.id, { archived: false })).status).toBe(200)
  expect(await inFeed(episode.id)).toBe(true)
})
