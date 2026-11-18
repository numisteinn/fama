// Serves the client endpoints of docs/api.md from memory, with real audio and Range support.
// Every response is encoded with the @fama/contracts schemas, so a drift from the contract throws here.
// Run: node scripts/make-fixtures.ts && node scripts/mock-api.ts
import { execFileSync } from "node:child_process"
import { createReadStream, existsSync, statSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { join } from "node:path"
import { Schema } from "effect"
import { Episode, EpisodeList, FeedInfo, VoiceList, type Chapter, type JobState, type Source } from "@fama/contracts"

const PORT = Number(process.env.PORT ?? 8790)
const API_TOKEN = process.env.FAMA_API_TOKEN ?? "dev-token"
const FEED_TOKEN = "feed-secret"
const fixtures = join(import.meta.dirname, "fixtures")

if (!existsSync(join(fixtures, "rest-0.m4a"))) {
  console.error("No fixtures. Run: node scripts/make-fixtures.ts")
  process.exit(1)
}

const durationMs = (file: string) =>
  Math.round(
    Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", join(fixtures, file)]).toString()) * 1000,
  )

const media = (file: string) => `/media/${FEED_TOKEN}/${file}`
const chapter = (index: number, title: string, file: string): Chapter => ({ index, title, durationMs: durationMs(file), url: media(file) })

const runChapters = [
  { title: "Start slow", file: "run-0.m4a" },
  { title: "The middle miles", file: "run-1.m4a" },
  { title: "Finish strong", file: "run-2.m4a" },
]

type Mutable<T> = { -readonly [K in keyof T]: T[K] }
type EpisodeRecord = Mutable<Episode>

const now = () => new Date().toISOString()
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()
let nextId = 1
const newId = () => `ep_${String(nextId++).padStart(4, "0")}`

const episodes = new Map<string, EpisodeRecord>()

function addEpisode(fields: Partial<EpisodeRecord> & Pick<EpisodeRecord, "source" | "title" | "job">) {
  const episode: EpisodeRecord = {
    id: newId() as Episode["id"],
    createdAt: now(),
    author: null,
    language: null,
    voice: null,
    speed: 1,
    durationMs: null,
    chapters: [],
    bookUrl: null,
    coverUrl: null,
    ...fields,
  }
  episodes.set(episode.id, episode)
  return episode
}

const sum = (chapters: ReadonlyArray<Chapter>) => chapters.reduce((total, c) => total + c.durationMs, 0)

// Fixtures: one Ready with 2 chapters, one Running, one Failed.
const readyChapters = [chapter(0, "Rest is part of the work", "rest-0.m4a"), chapter(1, "Reading your own recovery", "rest-1.m4a")]
addEpisode({
  createdAt: minutesAgo(180),
  source: { _tag: "Url", url: "https://example.com/training/rest-between-sets" },
  title: "On Rest Between Sets",
  author: "Fama Fixtures",
  language: "en",
  voice: "kokoro:af_heart" as Episode["voice"],
  chapters: readyChapters,
  durationMs: sum(readyChapters),
  coverUrl: media("cover-rest.png"),
  job: { _tag: "Ready", finishedAt: minutesAgo(170) },
})
addEpisode({
  createdAt: minutesAgo(90),
  source: { _tag: "File", fileName: "scan.pdf", contentType: "application/pdf" },
  title: "scan.pdf",
  job: { _tag: "Failed", reason: "No text found. The PDF looks like scanned images.", failedAt: minutesAgo(89) },
})
const running = addEpisode({
  createdAt: minutesAgo(2),
  source: { _tag: "Url", url: "https://example.com/blog/the-long-run" },
  title: "The Long Run",
  author: "Fama Fixtures",
  language: "en",
  chapters: [chapter(0, runChapters[0]!.title, runChapters[0]!.file)],
  job: { _tag: "Running", workerId: "mock-worker" as never, stage: "synthesizing", done: 1, total: 3, heartbeatAt: now() },
})
simulateJob(running.id, { startAt: 1, stepMs: 20_000 })

/** Moves a job through Queued, Running and Ready, adding one chapter per step. */
function simulateJob(id: string, { startAt = 0, stepMs = 6_000 } = {}) {
  let step = startAt
  const tick = () => {
    const episode = episodes.get(id)
    if (!episode || episode.job._tag === "Failed" || episode.job._tag === "Ready") return
    if (step === 0 && episode.chapters.length === 0) {
      episode.job = running_("extracting", 0, 1)
      step = -1
      return void setTimeout(tick, stepMs / 2)
    }
    if (step < 0) step = 0
    if (episode.chapters.length < runChapters.length && step > episode.chapters.length - 1) {
      const next = runChapters[episode.chapters.length]!
      episode.chapters = [...episode.chapters, chapter(episode.chapters.length, next.title, next.file)]
    }
    step++
    if (episode.chapters.length >= runChapters.length) {
      episode.durationMs = sum(episode.chapters)
      episode.job = { _tag: "Ready", finishedAt: now() }
      return
    }
    episode.job = running_("synthesizing", episode.chapters.length, runChapters.length)
    setTimeout(tick, stepMs)
  }
  setTimeout(tick, step === 0 ? 3_000 : stepMs)
}

function running_(stage: "extracting" | "synthesizing", done: number, total: number): JobState {
  return { _tag: "Running", workerId: "mock-worker" as never, stage, done, total, heartbeatAt: now() }
}

function provisionalTitle(source: Source): string {
  switch (source._tag) {
    case "Url": {
      try {
        const url = new URL(source.url)
        return `${url.host}${url.pathname === "/" ? "" : url.pathname}`
      } catch {
        return source.url
      }
    }
    case "Text":
      return source.title ?? source.text.trim().split(/\s+/).slice(0, 6).join(" ")
    case "File":
      return source.fileName
  }
}

const voices = [
  { id: "kokoro:af_heart", engine: "kokoro", name: "Heart", language: "en-US", gender: "female" },
  { id: "kokoro:am_michael", engine: "kokoro", name: "Michael", language: "en-US", gender: "male" },
  { id: "kokoro:bf_emma", engine: "kokoro", name: "Emma", language: "en-GB", gender: "female" },
  { id: "piper:is_IS-salka-medium", engine: "piper", name: "Salka", language: "is-IS", gender: "female" },
]

// HTTP

function send(res: ServerResponse, status: number, body?: unknown) {
  if (body === undefined) return void res.writeHead(status).end()
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body))
}

const encodeEpisode = Schema.encodeSync(Episode)
const encodeList = Schema.encodeSync(EpisodeList)

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

/** Reads the text fields and the file name of a multipart body. Enough for a mock. */
function parseMultipart(body: Buffer, contentType: string) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType)
  const text = body.toString("latin1")
  const fields: Record<string, string> = {}
  let file: { fileName: string; contentType: string; size: number } | null = null
  if (!boundary) return { fields, file }
  for (const part of text.split(`--${boundary[1] ?? boundary[2]}`)) {
    const [head, ...rest] = part.split("\r\n\r\n")
    if (!head || rest.length === 0) continue
    const name = /name="([^"]+)"/.exec(head)?.[1]
    const fileName = /filename="([^"]*)"/.exec(head)?.[1]
    const value = rest.join("\r\n\r\n").replace(/\r\n$/, "")
    if (fileName !== undefined) {
      file = { fileName, contentType: /Content-Type:\s*(\S+)/i.exec(head)?.[1] ?? "application/octet-stream", size: value.length }
    } else if (name) {
      fields[name] = value
    }
  }
  return { fields, file }
}

function serveMedia(req: IncomingMessage, res: ServerResponse, key: string) {
  const path = join(fixtures, key)
  if (key.includes("..") || !existsSync(path)) return send(res, 404)
  const size = statSync(path).size
  const type = key.endsWith(".png") ? "image/png" : "audio/mp4"
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "")
  if (!range) {
    res.writeHead(200, { "content-type": type, "content-length": size, "accept-ranges": "bytes" })
    return void createReadStream(path).pipe(res)
  }
  const start = range[1] ? Number(range[1]) : size - Number(range[2])
  const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
  if (start >= size || start > end) {
    return void res.writeHead(416, { "content-range": `bytes */${size}` }).end()
  }
  res.writeHead(206, {
    "content-type": type,
    "content-length": end - start + 1,
    "content-range": `bytes ${start}-${end}/${size}`,
    "accept-ranges": "bytes",
  })
  createReadStream(path, { start, end }).pipe(res)
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`)
  const path = url.pathname
  console.log(req.method, path, req.headers.range ?? "")

  const mediaMatch = new RegExp(`^/media/${FEED_TOKEN}/(.+)$`).exec(path)
  if (mediaMatch) return serveMedia(req, res, decodeURIComponent(mediaMatch[1]!))
  if (path === `/feed/${FEED_TOKEN}/rss.xml`) {
    res.writeHead(200, { "content-type": "application/rss+xml" })
    return void res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Fama</title></channel></rss>`)
  }

  if (!path.startsWith("/api/")) return send(res, 404)
  if (req.headers.authorization !== `Bearer ${API_TOKEN}`) return send(res, 401, { error: "Unauthorized" })

  const episodeMatch = /^\/api\/episodes\/([^/]+)(\/retry)?$/.exec(path)

  if (req.method === "GET" && path === "/api/episodes") {
    const list = [...episodes.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    return send(res, 200, encodeList({ episodes: list }))
  }
  if (req.method === "POST" && path === "/api/episodes") {
    const body = JSON.parse((await readBody(req)).toString("utf8"))
    const source: Source = body.source
    const episode = addEpisode({ source, title: provisionalTitle(source), voice: body.voice, speed: body.speed, job: { _tag: "Queued" } })
    simulateJob(episode.id)
    return send(res, 201, encodeEpisode(episode))
  }
  if (req.method === "POST" && path === "/api/episodes/upload") {
    const { fields, file } = parseMultipart(await readBody(req), req.headers["content-type"] ?? "")
    if (!file) return send(res, 400, { error: "Missing file" })
    console.log("  upload", file.fileName, file.contentType, `${file.size} bytes`, fields)
    const source: Source = { _tag: "File", fileName: file.fileName, contentType: file.contentType }
    const episode = addEpisode({
      source,
      title: provisionalTitle(source),
      voice: (fields.voice || null) as Episode["voice"],
      speed: fields.speed ? Number(fields.speed) : 1,
      job: { _tag: "Queued" },
    })
    simulateJob(episode.id)
    return send(res, 201, encodeEpisode(episode))
  }
  if (episodeMatch) {
    const episode = episodes.get(episodeMatch[1]!)
    if (!episode) return send(res, 404, { error: "Not found" })
    if (req.method === "GET" && !episodeMatch[2]) return send(res, 200, encodeEpisode(episode))
    if (req.method === "DELETE" && !episodeMatch[2]) {
      episodes.delete(episode.id)
      return send(res, 204)
    }
    if (req.method === "POST" && episodeMatch[2]) {
      episode.job = { _tag: "Queued" }
      episode.chapters = []
      simulateJob(episode.id)
      return send(res, 200, encodeEpisode(episode))
    }
  }
  if (req.method === "GET" && path === "/api/voices") return send(res, 200, Schema.encodeSync(VoiceList)({ voices } as never))
  if (req.method === "GET" && path === "/api/feed") {
    return send(res, 200, Schema.encodeSync(FeedInfo)({ url: `http://${req.headers.host}/feed/${FEED_TOKEN}/rss.xml` }))
  }
  send(res, 404, { error: "Not found" })
})

server.listen(PORT, () => {
  console.log(`Mock Fama API on http://localhost:${PORT}  token: ${API_TOKEN}`)
})
