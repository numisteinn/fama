import { describe, expect, it } from "vitest"
import { connectUrl } from "./connect.ts"
import { setupReport, userStep, workerCommand } from "./setup.ts"

const server = "https://fama-home.example.workers.dev"
const created = { clientToken: "client-tok_123", workerToken: "abcdef0123" }

describe("userStep", () => {
  it("creates the user only on a server with none", () => {
    expect(userStep(0)).toBe("create")
    expect(userStep(1)).toBe("exists")
    expect(userStep(2)).toBe("exists")
  })
})

describe("connectUrl", () => {
  it("is the fama://connect link with the server and the client token", () => {
    const link = connectUrl(server, created.clientToken)
    expect(link).toBe("fama://connect?server=https%3A%2F%2Ffama-home.example.workers.dev&token=client-tok_123")
    const parsed = new URL(link)
    expect(parsed.protocol).toBe("fama:")
    expect(parsed.host).toBe("connect")
    expect(parsed.searchParams.get("server")).toBe(server)
    expect(parsed.searchParams.get("token")).toBe(created.clientToken)
  })
})

describe("setupReport", () => {
  it("prints the server, both tokens, the worker command and a QR code when it creates the user", () => {
    const report = setupReport({ stage: "home", serverUrl: server, created })
    expect(report).toContain(`Server:        ${server}`)
    expect(report).toContain(`Client token:  ${created.clientToken}`)
    expect(report).toContain(`Worker token:  ${created.workerToken}`)
    expect(report).toContain(workerCommand(server, created.workerToken))
    expect(report).toMatch(/[▀▄█]/)
  })

  it("prints no token and no QR code on a rerun", () => {
    const report = setupReport({ stage: "home", serverUrl: server, created: undefined })
    expect(report).toContain(server)
    expect(report).toContain("The user exists")
    expect(report).toContain(workerCommand(server, "<FAMA_WORKER_TOKEN>"))
    expect(report).not.toContain(created.clientToken)
    expect(report).not.toContain(created.workerToken)
    expect(report).not.toMatch(/[▀▄█]/)
  })
})
