import { Effect } from "effect"
import { type ByteRange, MediaStore } from "./media-store.ts"

const contentTypes: Record<string, string> = {
  m4a: "audio/mp4",
  m4b: "audio/x-m4a",
  jpg: "image/jpeg",
  png: "image/png",
}

/** Parses a single `bytes=` range. Returns `null` for no range or a form we serve whole (multi-range). */
export const parseRange = (header: string | null): ByteRange | "invalid" | null => {
  if (header === null) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (match === null) return header.includes(",") ? null : "invalid"
  const [, start = "", end = ""] = match
  if (start === "" && end === "") return "invalid"
  if (start === "") return { suffix: Number(end) }
  const offset = Number(start)
  if (end === "") return { offset }
  const last = Number(end)
  return last < offset ? "invalid" : { offset, length: last - offset + 1 }
}

/** The inclusive byte span a range covers in an object of `size` bytes, or `null` when it is unsatisfiable. */
export const resolveRange = (range: ByteRange, size: number) => {
  if ("suffix" in range) {
    const length = Math.min(range.suffix, size)
    return length === 0 ? null : { first: size - length, last: size - 1 }
  }
  if (range.offset >= size) return null
  const last = range.length === undefined ? size - 1 : Math.min(range.offset + range.length, size) - 1
  return { first: range.offset, last }
}

const notSatisfiable = (size: number) =>
  new Response(null, { status: 416, headers: { "content-range": `bytes */${size}`, "accept-ranges": "bytes" } })

export const mediaResponse = Effect.fn("media.response")(function* (request: Request, key: string) {
  const store = yield* MediaStore
  const headers = new Headers({ "accept-ranges": "bytes", "cache-control": "private, max-age=3600" })
  const notFound = new Response("Not found", { status: 404 })

  const ext = key.split(".").pop() ?? ""
  const setMetadata = (object: R2Object) => {
    object.writeHttpMetadata(headers)
    headers.set("content-type", contentTypes[ext] ?? headers.get("content-type") ?? "application/octet-stream")
    headers.set("etag", object.httpEtag)
    headers.set("last-modified", object.uploaded.toUTCString())
  }

  const range = parseRange(request.headers.get("range"))

  if (request.method === "HEAD" || range === "invalid") {
    const object = yield* store.head(key)
    if (object === null) return notFound
    if (range === "invalid") return notSatisfiable(object.size)
    setMetadata(object)
    headers.set("content-length", String(object.size))
    return new Response(null, { status: 200, headers })
  }

  if (range === null) {
    const object = yield* store.get(key, null)
    if (object === null) return notFound
    setMetadata(object)
    headers.set("content-length", String(object.size))
    return new Response(object.body, { status: 200, headers })
  }

  const object = yield* store.get(key, range).pipe(Effect.catchTag("StorageError", () => Effect.succeed("unsatisfiable" as const)))
  if (object === "unsatisfiable") {
    const head = yield* store.head(key)
    return head === null ? notFound : notSatisfiable(head.size)
  }
  if (object === null) return notFound
  const span = resolveRange(range, object.size)
  if (span === null) return notSatisfiable(object.size)
  setMetadata(object)
  headers.set("content-length", String(span.last - span.first + 1))
  headers.set("content-range", `bytes ${span.first}-${span.last}/${object.size}`)
  return new Response(object.body, { status: 206, headers })
})
