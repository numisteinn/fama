/**
 * A stand-in for the Fama API, for web development without the Worker.
 * Serves the client endpoints of docs/api.md, simulates workers, and streams
 * real m4a files (made with ffmpeg) with Range support.
 *
 *   node scripts/mock-api.ts            # port 8787, API token "dev"
 *   PORT=9000 MOCK_TOKEN=secret node scripts/mock-api.ts
 */
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"

const PORT = Number(process.env.PORT ?? 8787)
const API_TOKEN = process.env.MOCK_TOKEN ?? "dev"
const FEED_TOKEN = "mockfeedtoken"
const MEDIA_DIR = join(tmpdir(), "fama-mock-media")

// Media pool. Every episode's chapter N plays pool file N mod length.
const POOL = [
  { seconds: 20, frequency: 330 },
  { seconds: 25, frequency: 392 },
  { seconds: 12, frequency: 440 },
  { seconds: 12, frequency: 494 },
] as const
const chapterMs = (index: number) => POOL[index % POOL.length]!.seconds * 1000

function makeMedia() {
  mkdirSync(MEDIA_DIR, { recursive: true })
  const encode = (input: string, out: string) => {
    if (existsSync(out)) return
    execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", input,
      "-af", "volume=0.08", "-c:a", "aac", "-b:a", "64k", "-f", "mp4", out,
    ])
  }
  POOL.forEach((item, index) =>
    encode(`sine=frequency=${item.frequency}:duration=${item.seconds}`, join(MEDIA_DIR, `chapter-${index}.m4a`)),
  )
  encode("sine=frequency=262:duration=45", join(MEDIA_DIR, "book.m4b"))
}

// Domain, shaped like packages/contracts.

type Source =
  | { _tag: "Url"; url: string }
  | { _tag: "Text"; title: string | null; text: string }
  | { _tag: "File"; fileName: string; contentType: string }

type Stage = "extracting" | "synthesizing" | "encoding" | "uploading"

type Job =
  | { _tag: "Queued" }
  | { _tag: "Running"; workerId: string; stage: Stage; done: number; total: number; heartbeatAt: string }
  | { _tag: "Ready"; finishedAt: string }
  | { _tag: "Failed"; reason: string; failedAt: string }

interface Chapter {
  index: number
  title: string
  durationMs: number
  url: string
}

interface Episode {
  id: string
  createdAt: string
  source: Source
  title: string
  author: string | null
  language: string | null
  voice: string | null
  speed: number
  durationMs: number | null
  chapters: Array<Chapter>
  bookUrl: string | null
  coverUrl: string | null
  job: Job
}

/** How the fake worker moves an episode along. */
interface Sim {
  stepMs: number
  nextAt: number
  chapters: number
  title: string
  /** Fail at this stage instead of finishing, once. */
  failWith: string | null
}

const VOICES = [
  { id: "kokoro:af_heart", engine: "kokoro", name: "Heart", language: "en-US", gender: "female" },
  { id: "kokoro:am_michael", engine: "kokoro", name: "Michael", language: "en-US", gender: "male" },
  { id: "kokoro:bf_emma", engine: "kokoro", name: "Emma", language: "en-GB", gender: "female" },
  { id: "piper:is_IS-salka-medium", engine: "piper", name: "Salka", language: "is", gender: "female" },
  { id: "piper:is_IS-bui-medium", engine: "piper", name: "Búi", language: "is", gender: "male" },
]

const episodes: Array<Episode> = []
const sims = new Map<string, Sim>()

const now = () => new Date().toISOString()
const mediaPath = (id: string, key: string) => `/media/${FEED_TOKEN}/episodes/${id}/${key}`
const chapterOf = (id: string, index: number, title: string): Chapter => ({
  index,
  title,
  durationMs: chapterMs(index),
  url: mediaPath(id, `chapters/${String(index).padStart(3, "0")}.m4a`),
})

function newEpisode(source: Source, voice: string | null, speed: number, title: string): Episode {
  return {
    id: randomUUID().slice(0, 8),
    createdAt: now(),
    source,
    title,
    author: null,
    language: null,
    voice,
    speed,
    durationMs: null,
    chapters: [],
    bookUrl: null,
    coverUrl: null,
    job: { _tag: "Queued" },
  }
}

function seed() {
  const ready = newEpisode(
    { _tag: "Url", url: "https://example.com/essays/on-rest" },
    "kokoro:af_heart",
    1,
    "On Rest Between Sets",
  )
  ready.createdAt = new Date(Date.now() - 86_400_000).toISOString()
  ready.author = "Mira Holt"
  ready.language = "en-US"
  ready.chapters = [chapterOf(ready.id, 0, "Why rest matters"), chapterOf(ready.id, 1, "How long to wait")]
  ready.durationMs = chapterMs(0) + chapterMs(1)
  ready.bookUrl = mediaPath(ready.id, "book.m4b")
  ready.job = { _tag: "Ready", finishedAt: now() }

  const running = newEpisode(
    { _tag: "File", fileName: "strength-training-anatomy.epub", contentType: "application/epub+zip" },
    null,
    1.1,
    "Strength Training Anatomy",
  )
  running.createdAt = new Date(Date.now() - 600_000).toISOString()
  running.language = "en-US"
  running.voice = "kokoro:am_michael"
  running.chapters = [chapterOf(running.id, 0, "Arms")]
  running.job = { _tag: "Running", workerId: "mac-mini", stage: "synthesizing", done: 1, total: 6, heartbeatAt: now() }
  sims.set(running.id, { stepMs: 8000, nextAt: Date.now() + 8000, chapters: 6, title: running.title, failWith: null })

  const failed = newEpisode(
    { _tag: "Url", url: "https://news.example.org/paywalled/story" },
    null,
    1,
    "news.example.org/paywalled/story",
  )
  failed.createdAt = new Date(Date.now() - 3_600_000).toISOString()
  failed.job = { _tag: "Failed", reason: "Could not fetch the page: 403 Forbidden", failedAt: now() }

  episodes.push(running, failed, ready)
}

const CHAPTER_TITLES = ["Opening", "The middle part", "Turning point", "What follows", "Closing", "Afterword"]

/** One step of the fake worker. */
function step(episode: Episode, sim: Sim) {
  const job = episode.job
  const running = (stage: Stage, done: number): Job => ({
    _tag: "Running", workerId: "mock-worker", stage, done, total: sim.chapters, heartbeatAt: now(),
  })
  switch (job._tag) {
    case "Queued":
      episode.job = running("extracting", 0)
      return
    case "Running":
      if (job.stage === "extracting") {
        if (sim.failWith) {
          episode.job = { _tag: "Failed", reason: sim.failWith, failedAt: now() }
          sim.failWith = null
          sims.delete(episode.id)
          return
        }
        episode.title = sim.title
        episode.language = "en-US"
        episode.voice ??= "kokoro:af_heart"
        episode.job = running("synthesizing", 0)
      } else if (job.stage === "synthesizing") {
        const index = episode.chapters.length
        episode.chapters.push(chapterOf(episode.id, index, CHAPTER_TITLES[index % CHAPTER_TITLES.length]!))
        episode.job = running(index + 1 >= sim.chapters ? "encoding" : "synthesizing", index + 1)
      } else if (job.stage === "encoding") {
        episode.job = running("uploading", sim.chapters)
      } else {
        episode.durationMs = episode.chapters.reduce((sum, chapter) => sum + chapter.durationMs, 0)
        episode.bookUrl = mediaPath(episode.id, "book.m4b")
        episode.job = { _tag: "Ready", finishedAt: now() }
        sims.delete(episode.id)
      }
      return
    default:
      sims.delete(episode.id)
  }
}

setInterval(() => {
  const t = Date.now()
  for (const episode of episodes) {
    const sim = sims.get(episode.id)
    if (!sim || t < sim.nextAt) continue
    sim.nextAt = t + sim.stepMs
    step(episode, sim)
  }
}, 250)

function provisionalTitle(source: Source): string {
  switch (source._tag) {
    case "Url": {
      const url = new URL(source.url)
      return (url.host + url.pathname).replace(/\/$/, "")
    }
    case "Text":
      return source.title ?? source.text.split(/\s+/).slice(0, 8).join(" ")
    case "File":
      return source.fileName
  }
}

function realTitle(source: Source): string {
  switch (source._tag) {
    case "Url":
      return `An article from ${new URL(source.url).host}`
    case "Text":
      return provisionalTitle(source)
    case "File":
      return source.fileName.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ")
  }
}

function enqueue(episode: Episode) {
  const failing = episode.source._tag === "Url" && episode.source.url.includes("fail")
  sims.set(episode.id, {
    stepMs: 2500,
    nextAt: Date.now() + 1000,
    chapters: 3,
    title: realTitle(episode.source),
    failWith: failing ? "Could not fetch the page: 404 Not Found" : null,
  })
}

// HTTP.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Range",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
}

function send(res: ServerResponse, status: number, body?: unknown) {
  if (body === undefined) {
    res.writeHead(status, CORS).end()
    return
  }
  res.writeHead(status, { ...CORS, "Content-Type": "application/json" }).end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Array<Buffer> = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

function parseSpeed(raw: unknown): number {
  const speed = Number(raw ?? 1)
  return Number.isFinite(speed) && speed > 0 ? speed : 1
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (req.headers.authorization !== `Bearer ${API_TOKEN}`) return send(res, 401, { error: "Unauthorized" })
  const path = url.pathname
  const method = req.method ?? "GET"
  const episodeMatch = path.match(/^\/api\/episodes\/([^/]+)(\/retry)?$/)

  if (method === "GET" && path === "/api/episodes") {
    const sorted = [...episodes].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    return send(res, 200, { episodes: sorted })
  }
  if (method === "GET" && path === "/api/voices") return send(res, 200, { voices: VOICES })
  if (method === "GET" && path === "/api/feed") {
    return send(res, 200, { url: `http://${req.headers.host}/feed/${FEED_TOKEN}/rss.xml` })
  }
  if (method === "POST" && path === "/api/episodes") {
    const body = JSON.parse((await readBody(req)).toString("utf8")) as {
      source: Source
      voice: string | null
      speed: number
    }
    if (body.source._tag === "Url" && !URL.canParse(body.source.url)) {
      return send(res, 400, { error: "That link is not a valid URL" })
    }
    const episode = newEpisode(body.source, body.voice, parseSpeed(body.speed), provisionalTitle(body.source))
    episodes.push(episode)
    enqueue(episode)
    return send(res, 201, episode)
  }
  if (method === "POST" && path === "/api/episodes/upload") {
    const request = new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": req.headers["content-type"] ?? "" },
      body: await readBody(req),
    })
    const form = await request.formData()
    const file = form.get("file")
    if (!(file instanceof File)) return send(res, 400, { error: "No file in the upload" })
    const source: Source = { _tag: "File", fileName: file.name, contentType: file.type || "application/octet-stream" }
    const voice = form.get("voice")
    const episode = newEpisode(source, typeof voice === "string" ? voice : null, parseSpeed(form.get("speed")), file.name)
    episodes.push(episode)
    enqueue(episode)
    return send(res, 201, episode)
  }
  if (episodeMatch) {
    const index = episodes.findIndex((item) => item.id === episodeMatch[1])
    const episode = episodes[index]
    if (!episode) return send(res, 404, { error: "Not found" })
    if (method === "GET" && !episodeMatch[2]) return send(res, 200, episode)
    if (method === "DELETE" && !episodeMatch[2]) {
      episodes.splice(index, 1)
      sims.delete(episode.id)
      return send(res, 204)
    }
    if (method === "POST" && episodeMatch[2]) {
      episode.job = { _tag: "Queued" }
      episode.chapters = []
      episode.durationMs = null
      episode.bookUrl = null
      enqueue(episode)
      return send(res, 200, episode)
    }
  }
  send(res, 404, { error: "Not found" })
}

function handleMedia(req: IncomingMessage, res: ServerResponse, key: string) {
  const chapter = key.match(/^episodes\/([^/]+)\/chapters\/(\d+)\.m4a$/)
  const file = chapter
    ? join(MEDIA_DIR, `chapter-${Number(chapter[2]) % POOL.length}.m4a`)
    : /^episodes\/[^/]+\/book\.m4b$/.test(key)
      ? join(MEDIA_DIR, "book.m4b")
      : null
  if (!file || !existsSync(file)) return send(res, 404, { error: "Not found" })

  const size = statSync(file).size
  const headers = { ...CORS, "Content-Type": "audio/mp4", "Accept-Ranges": "bytes", "Cache-Control": "no-cache" }
  const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/)
  if (!range) {
    res.writeHead(200, { ...headers, "Content-Length": size })
    if (req.method === "HEAD") return res.end()
    return createReadStream(file).pipe(res)
  }
  let start = range[1] ? Number(range[1]) : size - Number(range[2])
  let end = range[1] && range[2] ? Number(range[2]) : size - 1
  start = Math.max(0, start)
  end = Math.min(end, size - 1)
  if (start > end) {
    res.writeHead(416, { ...headers, "Content-Range": `bytes */${size}` }).end()
    return
  }
  res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 })
  if (req.method === "HEAD") return res.end()
  createReadStream(file, { start, end }).pipe(res)
}

function handleFeed(req: IncomingMessage, res: ServerResponse) {
  const origin = `http://${req.headers.host}`
  const escape = (text: string) => text.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`)
  const items = episodes
    .filter((episode) => episode.job._tag === "Ready" && episode.bookUrl)
    .map(
      (episode) =>
        `<item><title>${escape(episode.title)}</title><guid>${episode.id}</guid>` +
        `<enclosure url="${origin}${episode.bookUrl}" type="audio/mp4"/></item>`,
    )
  res.writeHead(200, { "Content-Type": "application/rss+xml" })
  res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Fama</title>${items.join("")}</channel></rss>`)
}

makeMedia()
seed()

createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
  if (req.method === "OPTIONS") return send(res, 204)
  const started = Date.now()
  res.on("finish", () => {
    if (!url.pathname.startsWith("/media/")) {
      console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`)
    }
  })
  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url).catch((error: unknown) => send(res, 500, { error: String(error) }))
    return
  }
  const media = url.pathname.match(new RegExp(`^/media/${FEED_TOKEN}/(.+)$`))
  if (media) return handleMedia(req, res, media[1]!)
  if (url.pathname === `/feed/${FEED_TOKEN}/rss.xml`) return handleFeed(req, res)
  send(res, 404, { error: "Not found" })
}).listen(PORT, () => {
  console.log(`Mock Fama API on http://localhost:${PORT}  token: ${API_TOKEN}`)
})
