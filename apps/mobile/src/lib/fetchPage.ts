import { linkedUploadMediaType } from "@fama/contracts"

const PAGE_TIMEOUT_MS = 10_000
const MAX_PAGE_BYTES = 10 * 1024 * 1024

type FetchedPage = {
  readonly url: string
  readonly part: {
    readonly name: string
    readonly type: string
    bytes(): Promise<Uint8Array>
  }
}

async function fetchPage(url: string): Promise<FetchedPage | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS)
  try {
    const response = await fetch(url, { redirect: "follow", signal: controller.signal })
    const contentType = response.headers.get("content-type") ?? ""
    const length = Number(response.headers.get("content-length"))
    if (!response.ok || !response.url || !response.body || !linkedUploadMediaType(contentType) || length > MAX_PAGE_BYTES) {
      return null
    }

    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_PAGE_BYTES) return null
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
    if (size === 0) return null

    const body = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      body.set(chunk, offset)
      offset += chunk.byteLength
    }
    return {
      url: response.url,
      part: { name: "page", type: contentType, bytes: () => Promise.resolve(body) },
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

export async function submitLink<T>(
  url: string,
  sendLink: () => Promise<T>,
  sendPage: (page: FetchedPage) => Promise<T>,
): Promise<T> {
  const page = await fetchPage(url)
  return page === null ? sendLink() : sendPage(page)
}
