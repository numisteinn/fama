import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import fsSync from "node:fs"
import path from "node:path"
import os from "node:os"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

export function findChrome() {
  if (process.env.CHROME_PATH && fsSync.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH
  }
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ]
  for (const c of candidates) {
    if (fsSync.existsSync(c)) return c
  }
  // Fall back to Playwright's cached Chromium on macOS/Linux if present.
  const pwRoots = [
    path.join(os.homedir(), "Library/Caches/ms-playwright"),
    path.join(os.homedir(), ".cache/ms-playwright"),
  ]
  for (const root of pwRoots) {
    if (!fsSync.existsSync(root)) continue
    const dirs = fsSync
      .readdirSync(root)
      .filter((d) => d.startsWith("chromium-"))
      .sort()
      .reverse()
    for (const d of dirs) {
      for (const rel of [
        "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
        "chrome-linux/chrome",
      ]) {
        const full = path.join(root, d, rel)
        if (fsSync.existsSync(full)) return full
      }
    }
  }
  throw new Error("Chrome/Chromium not found. Install Chrome or set CHROME_PATH.")
}

async function launchChrome() {
  const chrome = findChrome()
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "fama-demo-chrome-"))
  const proc = spawn(
    chrome,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu-sandbox",
      "--hide-scrollbars",
      "--autoplay-policy=no-user-gesture-required",
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
  const page = targets.find((t) => t.type === "page")
  if (!page) throw new Error("No Chrome page target found")

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true })
    ws.addEventListener("error", reject, { once: true })
  })

  let nextId = 1
  const pending = new Map()
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`))
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
    try {
      ws.close()
    } catch {}
    proc.kill("SIGTERM")
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {})
  }

  return { cdp, close }
}

async function evalJs(cdp, expression) {
  const res = await cdp("Runtime.evaluate", {
    expression: `(${expression})()`,
    awaitPromise: true,
    returnByValue: true,
  })
  if (res.exceptionDetails) {
    throw new Error(`JS error: ${res.exceptionDetails.text} ${JSON.stringify(res.exceptionDetails.exception)}`)
  }
  return res.result?.value
}

function buildMatcherExpr(step) {
  const baseSelector =
    step.selector ||
    (step.role === "button"
      ? 'button, [role="button"]'
      : step.role
        ? `[role="${step.role}"]`
        : "*")

  const checks = []
  if (step.name !== undefined) checks.push(`label === ${JSON.stringify(step.name)}`)
  if (step.nameStartsWith !== undefined) checks.push(`label.startsWith(${JSON.stringify(step.nameStartsWith)})`)
  if (step.nameContains !== undefined) checks.push(`label.includes(${JSON.stringify(step.nameContains)})`)
  const cond = checks.length > 0 ? checks.join(" && ") : "true"

  return `() => {
    const els = [...document.querySelectorAll(${JSON.stringify(baseSelector)})];
    return els.find((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const st = getComputedStyle(el);
      if (st.visibility === "hidden" || st.display === "none") return false;
      const label = (el.getAttribute("aria-label") || el.textContent || "").replace(/\\s+/g, " ").trim();
      return ${cond};
    }) || null;
  }`
}

async function waitFor(cdp, matcherExpr, label, timeoutMs = 60_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const ok = await evalJs(cdp, `() => Boolean((${matcherExpr})())`)
    if (ok) return
    await sleep(250)
  }
  throw new Error(`Timed out waiting for: ${label}`)
}

async function getBox(cdp, matcherExpr) {
  return evalJs(
    cdp,
    `() => {
      const el = (${matcherExpr})();
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    }`,
  )
}

async function clickBox(cdp, box) {
  await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.cx, y: box.cy })
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: box.cx, y: box.cy, button: "left", clickCount: 1 })
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.cx, y: box.cy, button: "left", clickCount: 1 })
}

async function snap(cdp, assetsDir, name, delayMs = 250) {
  if (delayMs > 0) await sleep(delayMs)
  const { data } = await cdp("Page.captureScreenshot", { format: "png" })
  const filename = `${name}.png`
  await fs.writeFile(path.join(assetsDir, filename), Buffer.from(data, "base64"))
  console.log(`capture: ${filename}`)
  return filename
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.spec || !args.out) {
    throw new Error("Usage: capture.mjs --spec <spec.json> --out <dir> [--base-url http://localhost:8788] [--token dev-api-token]")
  }

  const baseUrl = args["base-url"] || "http://localhost:8788"
  const token = args.token || "dev-api-token"
  const spec = JSON.parse(await fs.readFile(args.spec, "utf8"))
  const assetsDir = path.join(args.out, "assets")
  await fs.mkdir(assetsDir, { recursive: true })

  const viewport = {
    width: spec.meta?.viewport?.width ?? 1120,
    height: spec.meta?.viewport?.height ?? 740,
    scale: spec.meta?.viewport?.scale ?? 2,
  }
  const colorScheme = spec.meta?.colorScheme || "dark"

  const apiGet = async (urlPath) => {
    const res = await fetch(`${baseUrl}${urlPath}`, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) throw new Error(`GET ${urlPath} -> ${res.status}`)
    return res.json()
  }

  const downloadFile = async (urlPath, destName) => {
    const res = await fetch(`${baseUrl}${urlPath}`)
    if (!res.ok) throw new Error(`GET ${urlPath} -> ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    await fs.writeFile(path.join(assetsDir, destName), buf)
    console.log(`capture: downloaded ${destName} (${buf.length} bytes)`)
    return destName
  }

  const manifest = {
    viewport,
    shots: {},
    sequences: {},
    boxes: {},
    audio: {},
    timing: {},
  }

  const { cdp, close } = await launchChrome()
  try {
    await cdp("Page.enable")
    await cdp("DOM.enable")
    await cdp("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.scale,
      mobile: false,
    })
    await cdp("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: colorScheme }],
    })

    // Seed JSON-encoded token matching apps/web/src/flags.ts
    await cdp("Page.navigate", { url: baseUrl })
    await sleep(600)
    await evalJs(cdp, `() => { localStorage.setItem("fama.token", JSON.stringify(${JSON.stringify(token)})); }`)
    await cdp("Page.reload", { ignoreCache: true })
    await sleep(500)

    for (const step of spec.capture || []) {
      switch (step.op) {
        case "wait": {
          const expr = buildMatcherExpr(step)
          await waitFor(cdp, expr, step.label || JSON.stringify(step), step.timeoutMs ?? 60_000)
          if (step.delayMs) await sleep(step.delayMs)
          break
        }

        case "box": {
          const expr = buildMatcherExpr(step)
          const box = await getBox(cdp, expr)
          if (!box && !step.optional) throw new Error(`Could not find box for ${step.as}`)
          manifest.boxes[step.as] = box
          break
        }

        case "snap": {
          if (step.blur) await evalJs(cdp, `() => { document.activeElement?.blur?.(); }`)
          manifest.shots[step.as] = await snap(cdp, assetsDir, step.file || step.as, step.delayMs ?? 250)
          break
        }

        case "click": {
          const box = manifest.boxes[step.box]
          if (!box) throw new Error(`Missing box "${step.box}" for click`)
          await clickBox(cdp, box)
          if (step.waitAriaChecked !== undefined) {
            const sel = step.selector || '[role="switch"]'
            await waitFor(
              cdp,
              `() => document.querySelector(${JSON.stringify(sel)})?.getAttribute("aria-checked") === ${JSON.stringify(String(step.waitAriaChecked))}`,
              `aria-checked=${step.waitAriaChecked}`,
              10_000,
            )
          }
          if (step.delayMs) await sleep(step.delayMs)
          break
        }

        case "hover": {
          const box = manifest.boxes[step.box]
          if (!box) throw new Error(`Missing box "${step.box}" for hover`)
          await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.cx, y: box.cy })
          await sleep(step.delayMs ?? 250)
          break
        }

        case "upload": {
          const { root } = await cdp("DOM.getDocument")
          const { nodeId } = await cdp("DOM.querySelector", {
            nodeId: root.nodeId,
            selector: step.selector || 'input[type="file"]',
          })
          const filePath = path.isAbsolute(step.file) ? step.file : path.join(assetsDir, step.file)
          await cdp("DOM.setFileInputFiles", { nodeId, files: [filePath] })
          await sleep(step.delayMs ?? 450)
          break
        }

        case "typeSequence": {
          const box = manifest.boxes[step.box]
          if (!box) throw new Error(`Missing box "${step.box}" for typeSequence`)
          await clickBox(cdp, box)
          await evalJs(
            cdp,
            `() => {
              const el = document.activeElement;
              if (el && "selectionStart" in el && typeof el.value === "string") {
                el.selectionStart = el.selectionEnd = el.value.length;
              }
            }`,
          )
          const chars = [...step.text]
          const stride = Math.max(1, step.stepChars ?? 2)
          const frames = []
          let frameIdx = 0
          for (let i = 0; i < chars.length; i += stride) {
            const chunk = chars.slice(i, i + stride).join("")
            await cdp("Input.insertText", { text: chunk })
            const key = `${step.prefix}${frameIdx}`
            manifest.shots[key] = await snap(cdp, assetsDir, key, 70)
            frames.push(key)
            frameIdx++
          }
          manifest.sequences[step.as || step.prefix] = frames
          if (step.finalAs) manifest.shots[step.finalAs] = manifest.shots[frames[frames.length - 1]]
          break
        }

        case "downloadSample": {
          const { episodes } = await apiGet("/api/episodes")
          const ep = episodes[step.episodeIndex ?? 0]
          if (!ep) throw new Error("No episodes found for downloadSample")
          manifest.episodeId = ep.id
          const { samples } = await apiGet(`/api/episodes/${ep.id}/samples`)
          const match = samples.find((s) => s.voice.includes(step.voiceContains))
          if (!match || match.state?._tag !== "Ready") {
            throw new Error(`Ready sample matching "${step.voiceContains}" not found`)
          }
          manifest.audio[step.as] = await downloadFile(match.state.url, `${step.as}.m4a`)
          break
        }

        case "downloadChapter": {
          const { episodes } = await apiGet("/api/episodes")
          const ep = episodes[step.episodeIndex ?? 0]
          if (!ep) throw new Error("No episodes found for downloadChapter")
          manifest.episodeId = ep.id
          const ch = ep.chapters[step.index ?? 0]
          if (!ch) throw new Error(`Chapter ${step.index ?? 0} not found`)
          if (step.audioAs) manifest.audio[step.audioAs] = await downloadFile(ch.url, `${step.audioAs}.m4a`)
          if (step.timingAs && ch.timingUrl) manifest.timing[step.timingAs] = await apiGet(ch.timingUrl)
          break
        }

        case "snapReaderSentences": {
          const sel = step.selector || '#reader [role="button"]'
          const btns = await evalJs(
            cdp,
            `() => [...document.querySelectorAll(${JSON.stringify(sel)})].map((b, i) => {
              const r = b.getBoundingClientRect();
              return { i, text: b.textContent.trim(), x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width/2, cy: r.top + r.height/2 };
            })`,
          )
          manifest.boxes[step.boxesAs || `${step.prefix}sentences`] = btns
          const count = Math.min(btns.length, step.max ?? btns.length)
          for (let i = 0; i < count; i++) {
            await clickBox(cdp, btns[i])
            await sleep(200)
            await evalJs(cdp, `() => { const a = document.querySelector("audio"); if (a) a.pause(); }`)
            manifest.shots[`${step.prefix}${i}`] = await snap(cdp, assetsDir, `${step.prefix}${i}`, 140)
          }
          break
        }

        case "snapLastReaderSentence": {
          const sel = step.selector || '#reader [role="button"]'
          const btns = await evalJs(
            cdp,
            `() => [...document.querySelectorAll(${JSON.stringify(sel)})].map((b, i) => {
              const r = b.getBoundingClientRect();
              return { i, text: b.textContent.trim(), x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width/2, cy: r.top + r.height/2 };
            })`,
          )
          if (btns.length === 0) throw new Error("No Read-along sentences found")
          const last = btns[btns.length - 1]
          if (step.boxAs) manifest.boxes[step.boxAs] = last
          await clickBox(cdp, last)
          await sleep(200)
          await evalJs(cdp, `() => { const a = document.querySelector("audio"); if (a) a.pause(); }`)
          manifest.shots[step.as] = await snap(cdp, assetsDir, step.as, 150)
          break
        }

        case "sleep": {
          await sleep(step.ms ?? 300)
          break
        }

        default:
          throw new Error(`Unknown capture op: ${step.op}`)
      }
    }

    await fs.writeFile(path.join(assetsDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
    console.log("capture: manifest.json written")
  } finally {
    await close()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
