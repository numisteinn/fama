import { createServer, type RequestListener } from "node:http"
import { afterEach, expect, it, vi } from "vitest"
import { submitLink } from "./fetchPage"

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function serve(handler: RequestListener) {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("Expected a TCP listener")
  return {
    url: `http://127.0.0.1:${address.port}`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

it("sends the original link alone when the phone cannot reach the site", async () => {
  const site = await serve((_, response) => response.end())
  await site.stop()
  const create = vi.fn(async () => "queued")
  const upload = vi.fn(async () => "uploaded")

  expect(await submitLink(site.url, create, upload)).toBe("queued")
  expect(create).toHaveBeenCalledOnce()
  expect(upload).not.toHaveBeenCalled()
})

it("uploads the bytes with the final URL and the site's Content-Type", async () => {
  const html = "<html><title>The Quiet Harbour</title></html>"
  const contentType = "text/html; charset=utf-8"
  const site = await serve((request, response) => {
    if (request.url === "/start") {
      response.writeHead(302, { location: "/article" }).end()
    } else {
      response.writeHead(200, { "content-type": contentType }).end(html)
    }
  })
  try {
    const page = await submitLink(`${site.url}/start`, async () => null, async ({ url, part }) => ({
      url,
      contentType: part.type,
      html: new TextDecoder().decode(await part.bytes()),
    }))
    expect(page).toEqual({ url: `${site.url}/article`, contentType, html })
  } finally {
    await site.stop()
  }
})

it("falls back when the body exceeds the limit without a Content-Length", async () => {
  const site = await serve((_, response) => {
    response.writeHead(200, { "content-type": "application/pdf", "transfer-encoding": "chunked" })
    response.end(Buffer.alloc(10 * 1024 * 1024 + 1))
  })
  try {
    expect(await submitLink(site.url, async () => "queued", async () => "uploaded")).toBe("queued")
  } finally {
    await site.stop()
  }
})

it("aborts a slow fetch and falls back to the link", async () => {
  vi.useFakeTimers()
  vi.stubGlobal("fetch", (_url: string, { signal }: RequestInit) => new Promise((_, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
  }))
  const submission = submitLink("https://example.com/slow", async () => "queued", async () => "uploaded")
  await vi.advanceTimersByTimeAsync(10_000)
  expect(await submission).toBe("queued")
})
