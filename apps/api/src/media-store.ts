import { Context, Effect, Layer, Schema } from "effect"
import { Bindings } from "./bindings.ts"

export class StorageError extends Schema.TaggedError<StorageError>()("StorageError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

/** Every object of a user lives under this prefix. */
const userPrefix = (userId: string) => `users/${userId}/`

export const keys = {
  upload: (userId: string, episodeId: string, fileName: string) =>
    `${userPrefix(userId)}uploads/${episodeId}/${fileName}`,
  chapter: (userId: string, episodeId: string, index: number) =>
    `${userPrefix(userId)}episodes/${episodeId}/chapters/${String(index).padStart(3, "0")}.m4a`,
  timing: (userId: string, episodeId: string, index: number) =>
    `${userPrefix(userId)}episodes/${episodeId}/chapters/${String(index).padStart(3, "0")}.json`,
  /** The media path of the transcript. The object the API stores for one Ready is under `transcript/`. */
  transcript: (userId: string, episodeId: string) => `${userPrefix(userId)}episodes/${episodeId}/transcript.vtt`,
  book: (userId: string, episodeId: string) => `${userPrefix(userId)}episodes/${episodeId}/book.m4b`,
  cover: (userId: string, episodeId: string, ext: string) =>
    `${userPrefix(userId)}episodes/${episodeId}/cover.${ext}`,
  documentRevision: (userId: string, episodeId: string, digest: string) =>
    `${userPrefix(userId)}documents/${episodeId}/${digest}.json`,
  document: (userId: string, episodeId: string) => `${userPrefix(userId)}episodes/${episodeId}/document.json`,
}

/**
 * The public path of a stored media key: `/media/<feedToken>/episodes/...`. The user prefix stays out of the URL,
 * because the feed token already names the user.
 */
export const mediaPath = (feedToken: string, userId: string, key: string) => {
  const prefix = userPrefix(userId)
  if (!key.startsWith(prefix)) throw new Error(`key ${key} is not under ${prefix}`)
  return `/media/${feedToken}/${key.slice(prefix.length)}`
}

/**
 * The stored key behind a media path (the part after `/media/<feedToken>/`), or `null` when the path may not be
 * served: only `episodes/...` of the feed token's own user, never `uploads/`, never `.` or `..` segments.
 */
export const mediaKey = (userId: string, path: string): string | null => {
  const segments = path.split("/")
  if (segments[0] !== "episodes" || segments.length < 3) return null
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || segment.includes("\\"))) {
    return null
  }
  return userPrefix(userId) + path
}

export type ByteRange = { readonly offset: number; readonly length?: number } | { readonly suffix: number }

export interface Interface {
  readonly put: (
    key: string,
    body: ReadableStream | Blob,
    contentType: string,
  ) => Effect.Effect<{ readonly size: number }, StorageError>
  readonly get: (key: string, range: ByteRange | null) => Effect.Effect<R2ObjectBody | null, StorageError>
  readonly head: (key: string) => Effect.Effect<R2Object | null, StorageError>
  /** Removes every object of one episode of one user: its media and its upload. */
  readonly deleteEpisode: (userId: string, episodeId: string) => Effect.Effect<void, StorageError>
}

export class MediaStore extends Context.Service<MediaStore, Interface>()("@fama/api/MediaStore") {}

const tryR2 = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new StorageError({ operation, cause }) })

export const layer = Layer.effect(
  MediaStore,
  Effect.gen(function* () {
    const bucket = (yield* Bindings).MEDIA

    const put = Effect.fn("MediaStore.put")(function* (
      key: string,
      body: ReadableStream | Blob,
      contentType: string,
    ) {
      const object = yield* tryR2("put", () => bucket.put(key, body, { httpMetadata: { contentType } }))
      return { size: object.size }
    })

    const get = (key: string, range: ByteRange | null) =>
      tryR2("get", () => bucket.get(key, range === null ? {} : { range }))

    const head = (key: string) => tryR2("head", () => bucket.head(key))

    const deletePrefix = Effect.fn("MediaStore.deletePrefix")(function* (prefix: string) {
      let cursor: string | undefined
      do {
        const page = yield* tryR2("list", () =>
          bucket.list(cursor === undefined ? { prefix } : { prefix, cursor }),
        )
        if (page.objects.length > 0) {
          yield* tryR2("delete", () => bucket.delete(page.objects.map((object) => object.key)))
        }
        cursor = page.truncated ? page.cursor : undefined
      } while (cursor !== undefined)
    })

    const deleteEpisode = Effect.fn("MediaStore.deleteEpisode")(function* (userId: string, episodeId: string) {
      yield* deletePrefix(`${userPrefix(userId)}episodes/${episodeId}/`)
      yield* deletePrefix(`${userPrefix(userId)}documents/${episodeId}/`)
      yield* deletePrefix(`${userPrefix(userId)}uploads/${episodeId}/`)
    })

    return MediaStore.of({ put, get, head, deleteEpisode })
  }),
)
