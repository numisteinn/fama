import { spawn, execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import http from "node:http"
import path from "node:path"
import os from "node:os"
import { fileURLToPath } from "node:url"
import { findChrome } from "./capture.mjs"

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      out[argv[i].slice(2)] = argv[i + 1]
      i++
    }
  }
  return out
}

function probeDuration(filePath) {
  return parseFloat(
    execFileSync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=nw=1:nk=1",
      filePath,
    ])
      .toString()
      .trim(),
  )
}

function resolvePoint(target, boxes, viewport) {
  if (!target) return { x: viewport.width / 2, y: viewport.height / 2 }
  if (target.box) {
    const b = boxes[target.box]
    if (!b) throw new Error(`Unknown box "${target.box}" in spec beat`)
    return { x: b.cx + (target.dx ?? 0), y: b.cy + (target.dy ?? 0) }
  }
  return { x: target.x ?? viewport.width / 2, y: target.y ?? viewport.height / 2 }
}

function compileTimeline(spec, manifest, vo, assetsDir, format) {
  const isVertical = format === "9:16"
  const width = isVertical ? 1080 : 1920
  const height = isVertical ? 1920 : 1080
  const fps = spec.meta?.fps ?? 30
  const vp = manifest.viewport
  const boxes = manifest.boxes

  const shots = []
  const camera = []
  const clicks = []
  const cursor = []
  const features = []
  const liveAudio = []
  const captions = []
  const audioTracks = []
  const attachmentCards = []
  const iphoneOverlays = []
  let endCard = null

  let t = 0
  let lastCursor = { x: vp.width * 0.78, y: vp.height * 0.62 }
  let lastCam = { x: vp.width / 2, y: vp.height / 2, zoom: 1.0 }
  cursor.push({ t: 0, ...lastCursor })
  camera.push({ t: 0, ...lastCam })

  const pushCursorMove = (at, pt, travelSec = 0.45) => {
    const arrive = Math.max(0, at)
    const depart = Math.max(cursor[cursor.length - 1].t, arrive - travelSec)
    if (depart > cursor[cursor.length - 1].t + 0.02) {
      cursor.push({ t: depart, x: lastCursor.x, y: lastCursor.y })
    }
    cursor.push({ t: arrive, x: pt.x, y: pt.y })
    lastCursor = pt
  }

  for (const beat of spec.beats || []) {
    const leadIn = beat.leadIn ?? 0
    t += leadIn
    const beatStart = t

    if (beat.feature) features.push({ t: beatStart, label: beat.feature })

    let beatDur = 0
    if (beat.type === "vo") {
      const clip = vo[beat.id]
      if (!clip) throw new Error(`Missing voiceover clip "${beat.id}" in voiceover.json`)
      beatDur = clip.duration
      audioTracks.push({ file: clip.file, at: beatStart, gain: beat.gain ?? 1.0 })
      captions.push({ start: beatStart, end: beatStart + beatDur, text: beat.caption ?? clip.text })
    } else if (beat.type === "liveAudio") {
      const file = manifest.audio[beat.audio]
      if (!file) throw new Error(`Missing captured audio "${beat.audio}" in manifest.json`)
      beatDur = probeDuration(path.join(assetsDir, file))
      if (beat.click) {
        const pt = resolvePoint({ box: beat.click }, boxes, vp)
        pushCursorMove(Math.max(0, beatStart - 0.06), pt, 0.4)
        clicks.push({ t: Math.max(0, beatStart - 0.04), x: pt.x, y: pt.y })
      }
      if (beat.shot) shots.push({ t: Math.max(0, beatStart - 0.04), shot: beat.shot, fade: beat.fade ?? 0.08 })
      audioTracks.push({ file, at: beatStart, gain: beat.gain ?? 1.15 })
      if (beat.liveLabel) liveAudio.push({ start: beatStart, end: beatStart + beatDur, label: beat.liveLabel })
      if (beat.caption) captions.push({ start: beatStart, end: beatStart + beatDur, text: beat.caption })
    } else if (beat.type === "liveReadAlong") {
      const file = manifest.audio[beat.audio]
      const timing = manifest.timing[beat.timing]
      if (!file || !timing) throw new Error(`Missing audio "${beat.audio}" or timing "${beat.timing}"`)
      const segIndices = beat.segments || [0]
      const firstSeg = timing.segments[segIndices[0]]
      const lastSeg = timing.segments[segIndices[segIndices.length - 1]]
      const trimStart = firstSeg.startMs / 1000
      let trimEnd = lastSeg.endMs / 1000
      if (beat.truncateLastSec && lastSeg.endMs - lastSeg.startMs > beat.truncateLastSec * 1000) {
        trimEnd = lastSeg.startMs / 1000 + beat.truncateLastSec
      }
      beatDur = Math.max(0.4, trimEnd - trimStart)

      if (beat.click) {
        const pt = resolvePoint({ box: beat.click }, boxes, vp)
        pushCursorMove(Math.max(0, beatStart - 0.06), pt, 0.4)
        clicks.push({ t: Math.max(0, beatStart - 0.04), x: pt.x, y: pt.y })
      }

      audioTracks.push({
        file,
        at: beatStart,
        trimStart,
        trimDur: beatDur,
        fadeOut: beat.fadeOut ?? 0.18,
        gain: beat.gain ?? 1.16,
      })

      for (let i = 0; i < segIndices.length; i++) {
        const idx = segIndices[i]
        const seg = timing.segments[idx]
        const segAt = beatStart + (seg.startMs / 1000 - trimStart)
        const nextSeg = i + 1 < segIndices.length ? timing.segments[segIndices[i + 1]] : null
        const segEnd = nextSeg ? beatStart + (nextSeg.startMs / 1000 - trimStart) : beatStart + beatDur
        const shotKey = beat.shot ?? `${beat.shotPrefix}${idx}`
        shots.push({ t: i === 0 ? Math.max(0, segAt - 0.08) : segAt, shot: shotKey, fade: 0.1 })
        captions.push({ start: segAt, end: segEnd, text: `“${seg.text}”` })
      }

      if (beat.liveLabel) liveAudio.push({ start: beatStart, end: beatStart + beatDur, label: beat.liveLabel })
    } else if (beat.type === "hold") {
      beatDur = beat.duration ?? 2.0
      if (beat.endCard) {
        endCard = { start: beatStart + 0.1, full: beatStart + Math.min(1.0, beatDur * 0.55) }
      }
    } else {
      throw new Error(`Unknown beat type: ${beat.type}`)
    }

    const beatSpan = beatDur + (beat.pauseAfter ?? 0)

    // Optional iPhone bezel overlay on this beat
    if (beat.iphoneShot) {
      iphoneOverlays.push({ start: beatStart, end: beatStart + beatSpan, image: beat.iphoneShot })
    }

    // Camera keyframes for this beat
    if (beat.camera) {
      const camList = Array.isArray(beat.camera) ? beat.camera : [{ at: 0.15, ...beat.camera }]
      for (const c of camList) {
        const pt = resolvePoint(c, boxes, vp)
        const ct = beatStart + (c.at ?? 0) * beatDur
        const nextCam = { x: pt.x, y: pt.y, zoom: c.zoom ?? lastCam.zoom }
        camera.push({ t: ct, ...nextCam })
        lastCam = nextCam
      }
    }

    // Relative events inside the beat (shots, clicks, live typing sequences, attachment cards)
    for (const ev of beat.events || []) {
      const et = beatStart + (ev.at ?? 0) * beatDur
      if (ev.click) {
        const pt = resolvePoint({ box: ev.click }, boxes, vp)
        pushCursorMove(Math.max(0, et - 0.04), pt, ev.travel ?? 0.45)
        clicks.push({ t: et, x: pt.x, y: pt.y })
      } else if (ev.moveTo) {
        const pt = resolvePoint(ev.moveTo, boxes, vp)
        pushCursorMove(et, pt, ev.travel ?? 0.45)
      }
      if (ev.shot) {
        shots.push({ t: et, shot: ev.shot, fade: ev.fade ?? 0.14 })
      }
      if (ev.typeSequence) {
        const seqFrames = manifest.sequences[ev.typeSequence]
        if (!seqFrames || seqFrames.length === 0) {
          throw new Error(`Missing sequence "${ev.typeSequence}" in manifest.json`)
        }
        const seqEnd = beatStart + (ev.endAt ?? Math.min(0.95, (ev.at ?? 0) + 0.45)) * beatDur
        const span = Math.max(0.25, seqEnd - et)
        for (let i = 0; i < seqFrames.length; i++) {
          const ft = et + (i / seqFrames.length) * span
          shots.push({ t: ft, shot: seqFrames[i], fade: 0 })
        }
      }
      if (ev.attachmentCard) {
        const ac = ev.attachmentCard
        const enter = beatStart + (ac.enterAt ?? ev.at ?? 0.3) * beatDur
        const dropStart = beatStart + (ac.dropAt ?? 0.55) * beatDur
        const exit = beatStart + (ac.exitAt ?? 0.72) * beatDur
        attachmentCards.push({
          image: ac.image,
          title: ac.title,
          badge: ac.badge,
          enter,
          dropStart,
          exit,
        })
      }
    }

    t = beatStart + beatSpan
  }

  const duration = Math.ceil(t * 10) / 10
  camera.push({ t: duration, ...lastCam })
  cursor.push({ t: duration, ...lastCursor })
  shots.sort((a, b) => a.t - b.t)
  camera.sort((a, b) => a.t - b.t)
  cursor.sort((a, b) => a.t - b.t)
  clicks.sort((a, b) => a.t - b.t)

  return {
    format,
    width,
    height,
    fps,
    duration,
    meta: spec.meta || {},
    shots,
    camera,
    clicks,
    cursor,
    features,
    liveAudio,
    captions,
    audioTracks,
    attachmentCards,
    iphoneOverlays,
    endCard,
  }
}

async function startStaticServer(outDir) {
  const mime = {
    ".html": "text/html; charset=utf-8",
    ".json": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
  }
  const server = http.createServer(async (req, res) => {
    const rel = (req.url || "/").split("?")[0].replace(/^\/+/, "") || "stage.html"
    const full = rel === "stage.html" ? path.join(SCRIPT_DIR, "stage.html") : path.join(outDir, rel)
    try {
      const data = await fs.readFile(full)
      res.writeHead(200, { "Content-Type": mime[path.extname(full)] || "application/octet-stream" })
      res.end(data)
    } catch {
      res.writeHead(404)
      res.end("not found")
    }
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  return { server, port: server.address().port }
}

async function launchChrome() {
  const chrome = findChrome()
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "fama-render-chrome-"))
  const proc = spawn(
    chrome,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      `--user-data-dir=${userDataDir}`,
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  )
  const port = await new Promise((resolve, reject) => {
    let stderr = ""
    const onData = (chunk) => {
      stderr += chunk.toString()
      const m = stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//)
      if (m) {
        proc.stderr.off("data", onData)
        resolve(Number(m[1]))
      }
    }
    proc.stderr.on("data", onData)
    proc.once("exit", (code) => reject(new Error(`Chrome exited ${code}: ${stderr}`)))
  })
  const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json())
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl)
  await new Promise((r, j) => {
    ws.addEventListener("open", r, { once: true })
    ws.addEventListener("error", j, { once: true })
  })
  let nextId = 1
  const pending = new Map()
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message))
      else resolve(msg.result)
    }
  })
  const cdp = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })
  const close = async () => {
    try { ws.close() } catch {}
    proc.kill("SIGTERM")
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {})
  }
  return { cdp, close }
}

async function mixAudioAndMux(videoOnlyPath, assetsDir, timeline, finalOutPath) {
  const clickWav = path.join(assetsDir, "click.wav")
  execFileSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc=exprs='0.22*sin(2*PI*1350*t)*exp(-t*260)':s=48000:d=0.02",
    clickWav,
  ])

  const inputs = ["-i", videoOnlyPath]
  const filterParts = []
  const mixLabels = []
  let idx = 1

  for (const tr of timeline.audioTracks) {
    inputs.push("-i", path.join(assetsDir, tr.file))
    const chain = ["aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo"]
    if (tr.trimStart !== undefined) {
      chain.push(`atrim=start=${tr.trimStart.toFixed(3)}:duration=${tr.trimDur.toFixed(3)}`)
      chain.push("asetpts=PTS-STARTPTS")
    }
    if (tr.fadeOut) {
      const fadeStart = Math.max(0, (tr.trimDur || 1) - tr.fadeOut)
      chain.push(`afade=t=out:st=${fadeStart.toFixed(3)}:d=${tr.fadeOut.toFixed(3)}`)
    }
    chain.push(`volume=${(tr.gain ?? 1).toFixed(2)}`)
    const delayMs = Math.round(tr.at * 1000)
    chain.push(`adelay=${delayMs}|${delayMs}`)
    const label = `a${idx}`
    filterParts.push(`[${idx}:a]${chain.join(",")}[${label}]`)
    mixLabels.push(`[${label}]`)
    idx++
  }

  for (const clk of timeline.clicks) {
    inputs.push("-i", clickWav)
    const delayMs = Math.round(clk.t * 1000)
    const label = `c${idx}`
    filterParts.push(
      `[${idx}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=0.45,adelay=${delayMs}|${delayMs}[${label}]`,
    )
    mixLabels.push(`[${label}]`)
    idx++
  }

  filterParts.push(
    `${mixLabels.join("")}amix=inputs=${mixLabels.length}:duration=longest:dropout_transition=0:normalize=0,volume=1.45,alimiter=limit=0.95,apad=whole_dur=${timeline.duration.toFixed(2)}[aout]`,
  )

  execFileSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    ...inputs,
    "-filter_complex",
    filterParts.join(";"),
    "-map",
    "0:v:0",
    "-map",
    "[aout]",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-shortest",
    "-movflags",
    "+faststart",
    finalOutPath,
  ])
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.out) throw new Error("Usage: render.mjs --out <run-dir> [--format 16:9|9:16]")

  const outDir = args.out
  const format = args.format || "16:9"
  const formatSlug = format.replace(":", "x")
  const assetsDir = path.join(outDir, "assets")

  const spec = JSON.parse(await fs.readFile(path.join(outDir, "spec.json"), "utf8"))
  const manifest = JSON.parse(await fs.readFile(path.join(assetsDir, "manifest.json"), "utf8"))
  const vo = JSON.parse(await fs.readFile(path.join(assetsDir, "voiceover.json"), "utf8"))

  const timeline = compileTimeline(spec, manifest, vo, assetsDir, format)
  await fs.writeFile(path.join(assetsDir, "timeline.json"), JSON.stringify(timeline, null, 2) + "\n")

  const totalFrames = Math.ceil(timeline.duration * timeline.fps)
  console.log(`render: ${format} (${timeline.width}x${timeline.height}), ${timeline.duration}s (${totalFrames} frames @ ${timeline.fps}fps)`)

  const { server, port } = await startStaticServer(outDir)
  const { cdp, close } = await launchChrome()
  const videoOnly = path.join(outDir, `video-only-${formatSlug}.mp4`)
  const finalOut = path.join(outDir, `demo-${formatSlug}.mp4`)

  try {
    await cdp("Page.enable")
    await cdp("Emulation.setDeviceMetricsOverride", {
      width: timeline.width,
      height: timeline.height,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await cdp("Page.navigate", { url: `http://127.0.0.1:${port}/stage.html` })

    while (true) {
      const r = await cdp("Runtime.evaluate", { expression: "Boolean(window.__READY__)", returnByValue: true })
      if (r.result?.value) break
      await new Promise((res) => setTimeout(res, 100))
    }

    const ff = spawn(
      "ffmpeg",
      [
        "-y",
        "-v",
        "error",
        "-f",
        "image2pipe",
        "-vcodec",
        "png",
        "-r",
        String(timeline.fps),
        "-i",
        "-",
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "17",
        "-pix_fmt",
        "yuv420p",
        videoOnly,
      ],
      { stdio: ["pipe", "inherit", "inherit"] },
    )

    const t0 = Date.now()
    for (let f = 0; f < totalFrames; f++) {
      const t = f / timeline.fps
      await cdp("Runtime.evaluate", { expression: `window.renderAt(${t.toFixed(4)})` })
      const { data } = await cdp("Page.captureScreenshot", { format: "png" })
      const buf = Buffer.from(data, "base64")
      if (!ff.stdin.write(buf)) {
        await new Promise((r) => ff.stdin.once("drain", r))
      }
      if (f % 180 === 0 || f === totalFrames - 1) {
        const pct = Math.round(((f + 1) / totalFrames) * 100)
        console.log(`render: frame ${f + 1}/${totalFrames} (${pct}%) in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
      }
    }
    ff.stdin.end()
    await new Promise((resolve, reject) => {
      ff.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))))
    })
  } finally {
    await close()
    server.close()
  }

  console.log("render: mixing audio tracks...")
  await mixAudioAndMux(videoOnly, assetsDir, timeline, finalOut)
  await fs.unlink(videoOnly).catch(() => {})

  // Export 3x3 visual QA contact sheet + end card frame
  const sheetPath = path.join(outDir, `contact-sheet-${formatSlug}.png`)
  const endPath = path.join(outDir, `end-frame-${formatSlug}.png`)
  const thumbW = format === "9:16" ? 360 : 640
  const thumbH = format === "9:16" ? 640 : 360
  const dur = probeDuration(finalOut)

  execFileSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-i",
    finalOut,
    "-vf",
    `fps=9/${Math.max(1, dur - 0.5).toFixed(2)},scale=${thumbW}:${thumbH},tile=3x3`,
    "-frames:v",
    "1",
    sheetPath,
  ])
  execFileSync("ffmpeg", ["-y", "-v", "error", "-sseof", "-0.6", "-i", finalOut, "-frames:v", "1", endPath])

  const stat = await fs.stat(finalOut)
  console.log(`VIDEO=${finalOut}`)
  console.log(`CONTACT_SHEET=${sheetPath}`)
  console.log(`END_FRAME=${endPath}`)
  console.log(`SUMMARY=${(stat.size / 1024 / 1024).toFixed(2)} MB, ${dur.toFixed(2)}s, ${timeline.width}x${timeline.height}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
