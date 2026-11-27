// Drives the full Fama protocol against a running `pnpm dev` server, as the seeded dev user (client token
// `dev-api-token`, feed token `dev-feed-token`) and a worker with FAMA_WORKER_TOKEN from .dev.vars.
// Usage: node scripts/smoke.ts [baseUrl]. Exits non-zero on the first failed check.
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ClaimResponse, Episode, EpisodeList, FeedInfo, Me, VoiceList } from "@fama/contracts"
import { Schema } from "effect"

const base = process.argv[2] ?? "http://localhost:8787"
const vars = Object.fromEntries(
  readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => [line.slice(0, line.indexOf("=")).trim(), line.slice(line.indexOf("=") + 1).trim()]),
)
const apiToken = "dev-api-token"
const feedToken = "dev-feed-token"
const workerToken = vars.FAMA_WORKER_TOKEN ?? ""

let checks = 0
function check(condition: boolean, label: string, detail?: unknown): asserts condition {
  if (!condition) {
    throw new Error(`FAIL ${label} ${detail === undefined ? "" : JSON.stringify(detail, null, 2)}`)
  }
  checks++
  console.log(`ok   ${label}`)
}

type Init = { body?: BodyInit; json?: unknown; headers?: Record<string, string> }
const send = (token: string, method: string, path: string, init: Init = {}) =>
  fetch(base + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.json === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers,
    },
    body: init.json === undefined ? (init.body ?? null) : JSON.stringify(init.json),
  })
/** A client call as the dev user. */
const call = (method: string, path: string, init?: Init) => send(apiToken, method, path, init)
/** A worker call with the worker token. */
const work = (method: string, path: string, init?: Init) => send(workerToken, method, path, init)

const expectStatus = async (response: Response, status: number, label: string): Promise<string> => {
  const text = await response.text()
  check(response.status === status, `${label} -> ${status}`, { got: response.status, body: text })
  return text
}

const expectJson = async <S extends Schema.Decoder<unknown>>(
  schema: S, response: Response, status: number, label: string,
): Promise<S["Type"]> => {
  const value: unknown = JSON.parse(await expectStatus(response, status, label))
  return Schema.decodeUnknownSync(schema)(value)
}

const expectNarrate = async (response: Response, label: string) => {
  const { work: job } = await expectJson(ClaimResponse, response, 200, label)
  check(job._tag === "Narrate", "claim returns a Narrate job")
  return job
}

const voice = { id: "kokoro:af_heart", engine: "kokoro", name: "Heart", language: "en-US", gender: "female" }
const workerA = `smoke-a-${process.pid}`
const workerB = `smoke-b-${process.pid}`

const dir = mkdtempSync(join(tmpdir(), "fama-smoke-"))
const tone = (name: string, frequency: number, format: string) => {
  const path = join(dir, name)
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `sine=frequency=${frequency}:duration=1`, "-c:a", "aac", "-f", format, path])
  return readFileSync(path)
}
const chapter0 = tone("0.m4a", 440, "mp4")
const chapter1 = tone("1.m4a", 660, "mp4")
const inputHash = "a".repeat(64)
const book = tone("book.m4b", 550, "ipod")
const created: Array<string> = []

try {
  const before = await expectJson(EpisodeList, await call("GET", "/api/episodes"), 200, "GET /api/episodes")
  const pending = before.episodes.filter((e) => e.job._tag === "Queued" || e.job._tag === "Running")
  check(pending.length === 0, "no pending jobs before the run (smoke claims the oldest job)", pending.map((e) => e.id))

  check((await call("GET", "/api/episodes", { headers: { authorization: "Bearer wrong" } })).status === 401, "wrong API token -> 401")
  const me = await expectJson(Me, await call("GET", "/api/me"), 200, "GET /api/me")
  check(me.userId === "dev-user" && me.apiVersion === 2, "me is the dev user", me)
  check((await send(feedToken, "GET", "/api/episodes")).status === 401, "feed token on /api/* -> 401")
  check((await call("POST", "/api/worker/claim", { json: { workerId: workerA, voices: [] } })).status === 401, "client token on /api/worker/* -> 401")
  check((await work("GET", "/api/episodes")).status === 401, "worker token on client routes -> 401")

  // Client creates a Text episode and a File episode.
  const text = await expectJson(
    Episode,
    await call("POST", "/api/episodes", {
      json: { source: { _tag: "Text", title: null, text: "Fama reads this text aloud for the smoke test." }, voice: null, speed: 1 },
    }),
    201,
    "POST /api/episodes (Text)",
  )
  created.push(text.id)
  check(text.job._tag === "Queued" && text.title === "Fama reads this text aloud for the smoke…", "Text episode is Queued with provisional title", text)

  const form = new FormData()
  form.set("file", new Blob(["Hello from an uploaded file."], { type: "text/plain" }), "notes.txt")
  form.set("voice", voice.id)
  form.set("speed", "1.25")
  const file = await expectJson(Episode, await call("POST", "/api/episodes/upload", { body: form }), 201, "POST /api/episodes/upload")
  created.push(file.id)
  check(
    file.source._tag === "File" && file.source.fileName === "notes.txt" && file.title === "notes.txt" && file.speed === 1.25 && file.voice === voice.id,
    "File episode has source, title, voice, speed",
    file,
  )

  // Worker A claims both jobs, oldest first.
  const claim1 = await expectNarrate(await work("POST", "/api/worker/claim", { json: { workerId: workerA, voices: [voice] } }), "claim #1")
  check(claim1.episodeId === text.id && claim1.sourcePath === null && claim1.chapters.length === 0 && claim1.leaseToken !== "", "claim #1 returns the Text job with a lease", claim1)
  const claim2 = await expectNarrate(await work("POST", "/api/worker/claim", { json: { workerId: workerA, voices: [voice] } }), "claim #2")
  check(claim2.episodeId === file.id && claim2.sourcePath === `/api/worker/jobs/${file.id}/source`, "claim #2 returns the File job with sourcePath", claim2)
  const leaseText = encodeURIComponent(claim1.leaseToken)
  const leaseFile = claim2.leaseToken
  await expectStatus(await work("GET", `${claim2.sourcePath}?leaseToken=${leaseText}`), 409, "GET source with another job's lease")
  const sourceResponse = await work("GET", `${claim2.sourcePath}?leaseToken=${encodeURIComponent(leaseFile)}`)
  check(sourceResponse.status === 200 && (await sourceResponse.text()) === "Hello from an uploaded file.", "GET source returns the uploaded bytes")

  const voices = await expectJson(VoiceList, await call("GET", "/api/voices"), 200, "GET /api/voices")
  check(voices.voices.some((v) => v.id === voice.id), "claim registered the worker's voice", voices)

  // A second worker cannot take a live lease, and a wrong lease token is refused.
  check((await work("POST", "/api/worker/claim", { json: { workerId: workerB, voices: [] } })).status === 204, "worker B claim -> 204 (leases are live)")
  const progressBody = (workerId: string, leaseToken: string, done: number) => ({
    workerId, leaseToken, stage: "synthesizing", done, total: 2, title: "Smoke Text", author: "Smoke Author", language: "en", voice: voice.id,
    remainingMs: 90_000,
  })
  await expectStatus(await work("POST", `/api/worker/jobs/${text.id}/progress`, { json: progressBody(workerB, "wrong", 1) }), 409, "progress with a wrong lease")
  await expectStatus(
    await work("PUT", `/api/worker/jobs/${text.id}/chapters/0?workerId=${workerB}&leaseToken=${encodeURIComponent(leaseFile)}&title=x&durationMs=1&inputHash=${inputHash}`, { body: chapter0, headers: { "content-type": "audio/mp4" } }),
    409,
    "chapter upload with another job's lease",
  )

  // Worker A reports progress, uploads chapters and the book, then completes.
  await expectStatus(await work("POST", `/api/worker/jobs/${text.id}/progress`, { json: progressBody(workerA, claim1.leaseToken, 0) }), 204, "progress")
  const chapters = [chapter0, chapter1]
  for (const [index, bytes] of chapters.entries()) {
    await expectStatus(
      await work("PUT", `/api/worker/jobs/${text.id}/chapters/${index}?workerId=${workerA}&leaseToken=${leaseText}&title=${encodeURIComponent(`Part ${index + 1} & more`)}&durationMs=1000&inputHash=${inputHash}`, {
        body: bytes,
        headers: { "content-type": "audio/mp4" },
      }),
      204,
      `PUT chapter ${index}`,
    )
  }
  const running = await expectJson(Episode, await call("GET", `/api/episodes/${text.id}`), 200, "GET episode while Running")
  const firstChapter = running.chapters[0]
  check(
    running.job._tag === "Running" && running.job.stage === "synthesizing" && running.job.remainingMs === 90_000 && running.title === "Smoke Text" && running.author === "Smoke Author" && running.chapters.length === 2 && firstChapter !== undefined,
    "Running episode shows progress, metadata and chapters",
    running,
  )
  const chapterAudio = await fetch(base + firstChapter.url)
  check(
    chapterAudio.status === 200 && chapterAudio.headers.get("content-type") === "audio/mp4" && (await chapterAudio.arrayBuffer()).byteLength === chapter0.length,
    "chapter 0 plays while the job runs",
  )

  await expectStatus(await work("PUT", `/api/worker/jobs/${text.id}/book?workerId=${workerA}&leaseToken=${leaseText}`, { body: book, headers: { "content-type": "audio/mp4" } }), 204, "PUT book")
  const completeBody = { workerId: workerA, leaseToken: claim1.leaseToken, durationMs: 2000 }
  await expectStatus(await work("POST", `/api/worker/jobs/${text.id}/complete`, { json: completeBody }), 204, "complete")
  await expectStatus(await work("POST", `/api/worker/jobs/${text.id}/complete`, { json: completeBody }), 204, "complete again (idempotent)")
  await expectStatus(await call("POST", `/api/episodes/${text.id}/retry`), 409, "retry of a Ready job")

  const list = await expectJson(EpisodeList, await call("GET", "/api/episodes"), 200, "GET /api/episodes")
  check(list.episodes[0]?.id === file.id && list.episodes[1]?.id === text.id, "episodes are newest first")
  const ready = list.episodes.find((e) => e.id === text.id)
  check(
    ready !== undefined && ready.job._tag === "Ready" && ready.durationMs === 2000 && ready.chapters.length === 2 &&
      ready.chapters[1]?.title === "Part 2 & more" && ready.chapters[1].url.startsWith(`/media/${feedToken}/episodes/${text.id}/chapters/`) && ready.chapters[1].url.endsWith("/001.m4a") &&
      ready.bookUrl !== null && ready.bookUrl.startsWith(`/media/${feedToken}/episodes/${text.id}/books/`) && ready.bookUrl.endsWith("/book.m4b"),
    "Ready episode has chapters and bookUrl",
    ready,
  )

  // Feed.
  const feedInfo = await expectJson(FeedInfo, await call("GET", "/api/feed"), 200, "GET /api/feed")
  check(feedInfo.url === `${base}/feed/${feedToken}/rss.xml`, "feed url", feedInfo)
  const feedResponse = await fetch(feedInfo.url)
  const xml = await feedResponse.text()
  check(feedResponse.status === 200 && feedResponse.headers.get("content-type")?.startsWith("application/rss+xml") === true, "feed is served as RSS")
  execFileSync("xmllint", ["--noout", "-"], { input: xml })
  check(true, "feed parses as XML (xmllint)")
  const readyCount = list.episodes.filter((e) => e.job._tag === "Ready" && e.bookUrl !== null).length
  const items = xml.match(/<item>/g)?.length ?? 0
  check(items === readyCount, `feed has one item per ready episode (${items})`, { items, readyCount })
  check(
    xml.includes(`<enclosure url="${base}${ready.bookUrl}" length="${book.length}" type="audio/x-m4a"/>`) &&
      xml.includes("<itunes:duration>2</itunes:duration>") &&
      xml.includes(`<guid isPermaLink="false">${text.id}</guid>`),
    "feed item has absolute enclosure, length, duration and guid",
  )
  check((await fetch(`${base}/feed/wrong/rss.xml`)).status === 401, "wrong feed token -> 401")
  const coverImage = await fetch(`${base}/feed/${feedToken}/cover.jpg`)
  check(coverImage.status === 200 && coverImage.headers.get("content-type") === "image/jpeg", "channel image is served")

  // Media with Range.
  const bookUrl = base + ready.bookUrl
  const full = await fetch(bookUrl)
  check(full.status === 200 && full.headers.get("content-length") === String(book.length) && full.headers.get("accept-ranges") === "bytes", "GET book -> 200 with length and accept-ranges")
  await full.arrayBuffer()
  const partial = await fetch(bookUrl, { headers: { range: "bytes=0-99" } })
  const partialBytes = Buffer.from(await partial.arrayBuffer())
  check(
    partial.status === 206 && partial.headers.get("content-range") === `bytes 0-99/${book.length}` && partialBytes.equals(book.subarray(0, 100)) &&
      partial.headers.get("content-type") === "audio/x-m4a",
    "Range bytes=0-99 -> 206 with Content-Range and the right bytes",
    Object.fromEntries(partial.headers),
  )
  const suffix = await fetch(bookUrl, { headers: { range: "bytes=-10" } })
  check(suffix.status === 206 && Buffer.from(await suffix.arrayBuffer()).equals(book.subarray(book.length - 10)), "Range bytes=-10 -> 206 last 10 bytes")
  const open = await fetch(bookUrl, { headers: { range: `bytes=${book.length - 5}-` } })
  check(open.status === 206 && open.headers.get("content-range") === `bytes ${book.length - 5}-${book.length - 1}/${book.length}`, "Range bytes=N- -> 206")
  await open.arrayBuffer()
  const unsatisfiable = await fetch(bookUrl, { headers: { range: `bytes=${book.length + 10}-` } })
  check(unsatisfiable.status === 416 && unsatisfiable.headers.get("content-range") === `bytes */${book.length}`, "Range past the end -> 416", unsatisfiable.status)
  const head = await fetch(bookUrl, { method: "HEAD" })
  check(head.status === 200 && head.headers.get("content-length") === String(book.length), "HEAD book -> 200 with length")
  check((await fetch(`${base}/media/wrong/episodes/${text.id}/book.m4b`)).status === 401, "media with wrong feed token -> 401")
  check((await fetch(`${base}/media/${feedToken}/uploads/${file.id}/notes.txt`)).status === 404, "media never serves uploads/ -> 404")

  // Failure and retry of the File job.
  await expectStatus(await work("POST", `/api/worker/jobs/${file.id}/fail`, { json: { workerId: workerB, leaseToken: "wrong", reason: "nope" } }), 409, "fail with a wrong lease")
  await expectStatus(await work("POST", `/api/worker/jobs/${file.id}/fail`, { json: { workerId: workerA, leaseToken: leaseFile, reason: "extraction failed" } }), 204, "fail")
  const failed = await expectJson(Episode, await call("GET", `/api/episodes/${file.id}`), 200, "GET failed episode")
  check(failed.job._tag === "Failed" && failed.job.reason === "extraction failed", "job is Failed with reason", failed.job)
  await expectStatus(await work("POST", `/api/worker/jobs/${file.id}/progress`, { json: progressBody(workerA, leaseFile, 1) }), 409, "progress after fail")
  const retried = await expectJson(Episode, await call("POST", `/api/episodes/${file.id}/retry`), 200, "retry")
  check(retried.job._tag === "Queued", "retry puts the job back to Queued", retried.job)
  const reclaim = await expectNarrate(await work("POST", "/api/worker/claim", { json: { workerId: workerB, voices: [] } }), "worker B claims the retried job")
  check(reclaim.episodeId === file.id && reclaim.leaseToken !== leaseFile, "retried job is claimable with a new lease", reclaim)
  await expectStatus(await work("POST", `/api/worker/jobs/${file.id}/fail`, { json: { workerId: workerA, leaseToken: leaseFile, reason: "old" } }), 409, "the old lease is refused after a new claim")
  await expectStatus(await work("POST", `/api/worker/jobs/${file.id}/fail`, { json: { workerId: workerB, leaseToken: reclaim.leaseToken, reason: "smoke cleanup" } }), 204, "worker B fails it")

  // Delete removes the episode and its media.
  for (const episode of [text, file]) {
    await expectStatus(await call("DELETE", `/api/episodes/${episode.id}`), 204, `DELETE ${episode.source._tag} episode`)
    await expectStatus(await call("GET", `/api/episodes/${episode.id}`), 404, `GET deleted ${episode.source._tag} episode`)
  }
  for (const url of [...ready.chapters.map((c) => c.url), ready.bookUrl]) {
    check((await fetch(base + url)).status === 404, `media gone: ${url.split("/").slice(-2).join("/")}`)
  }
  await expectStatus(await work("GET", `/api/worker/jobs/${file.id}/source?leaseToken=${encodeURIComponent(reclaim.leaseToken)}`), 404, "upload gone")

  console.log(`\nsmoke passed: ${checks} checks`)
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  rmSync(dir, { recursive: true, force: true })
  await Promise.all(created.map((id) => call("DELETE", `/api/episodes/${id}`)))
}
