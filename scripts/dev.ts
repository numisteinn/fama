// `pnpm dev`: the API (wrangler dev, local D1 and R2, serving the web build), the web build in watch
// mode, and the Mac worker. Ctrl-C stops all three. Local D1 gets a dev user with client token `dev-api-token` and
// feed token `dev-feed-token`. Each child runs in its own process group, so stopping a group
// also stops what it spawned (workerd, Python), and nothing else on the machine.
import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import { appendFileSync, copyFileSync, existsSync, readFileSync } from "node:fs"
import { createInterface } from "node:readline"

const root = new URL("..", import.meta.url).pathname
const devVars = `${root}apps/api/.dev.vars`
if (!existsSync(devVars)) copyFileSync(`${root}apps/api/.dev.vars.example`, devVars)
if (!/^FAMA_WORKER_TOKEN=/m.test(readFileSync(devVars, "utf8"))) {
  // A .dev.vars from before workers had their own token.
  appendFileSync(devVars, "\nFAMA_WORKER_TOKEN=dev-worker-token\n")
  console.log(`Added FAMA_WORKER_TOKEN=dev-worker-token to ${devVars}`)
}
const workerToken = /^FAMA_WORKER_TOKEN=(.*)$/m.exec(readFileSync(devVars, "utf8"))?.[1]?.trim()
if (!workerToken) throw new Error(`FAMA_WORKER_TOKEN is empty in ${devVars}`)

const bin = (app: string, name: string) => `${root}apps/${app}/node_modules/.bin/${name}`
const once = (command: string, args: Array<string>, cwd: string) =>
  execFileSync(command, args, { cwd: root + cwd, stdio: "inherit" })
// wrangler serves apps/web/dist, so it must exist before wrangler starts.
once(bin("web", "vite"), ["build"], "apps/web")
once(bin("api", "wrangler"), ["d1", "migrations", "apply", "DB", "--local"], "apps/api")
try {
  once(
    "node",
    [
      "scripts/create-user.ts",
      "--user-id=dev-user",
      "--client-token=dev-api-token",
      "--feed-token=dev-feed-token",
      "--",
      "--local",
    ],
    "apps/api",
  )
} catch {
  console.error(
    "Could not seed the dev user. If the error says `no such table: users`, the local D1 has the schema from before " +
      "users. Delete apps/api/.wrangler/state/v3/d1 (local test data only) and run `pnpm dev` again.",
  )
  process.exit(1)
}

const services: Array<{ name: string; color: number; cwd: string; command: [string, ...Array<string>] }> = [
  { name: "api", color: 36, cwd: "apps/api", command: [bin("api", "wrangler"), "dev"] },
  { name: "web", color: 35, cwd: "apps/web", command: [bin("web", "vite"), "build", "--watch"] },
  {
    name: "worker",
    color: 33,
    cwd: "worker",
    command: ["uv", "run", "fama", "work", "--api", "http://localhost:8787", "--token", workerToken],
  },
]

const children: Array<ChildProcess> = []
let stopping = false

function stopAll(code: number) {
  if (stopping) return
  stopping = true
  process.exitCode = code
  for (const child of children) signal(child, "SIGTERM")
  setTimeout(() => children.forEach((child) => signal(child, "SIGKILL")), 5000).unref()
}

function signal(child: ChildProcess, name: NodeJS.Signals) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return
  try {
    process.kill(-child.pid, name)
  } catch {
    // The group is already gone.
  }
}

for (const service of services) {
  const [command, ...args] = service.command
  const child = spawn(command, args, {
    cwd: root + service.cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: "1" },
  })
  const prefix = `\x1b[${service.color}m${service.name.padEnd(6)}\x1b[0m│ `
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on("line", (line) => console.log(prefix + line))
  }
  child.on("exit", (code, signalName) => {
    if (!stopping) console.log(`${prefix}exited (${signalName ?? code}), stopping the rest`)
    stopAll(code ?? 1)
    if (children.every((c) => c.exitCode !== null || c.signalCode !== null)) process.exit()
  })
  children.push(child)
}

process.on("SIGINT", () => stopAll(0))
process.on("SIGTERM", () => stopAll(0))
