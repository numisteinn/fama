import { Context, Effect, Layer, Schema } from "effect"
import { Bindings } from "./bindings.ts"

export class StorageError extends Schema.TaggedError<StorageError>()("StorageError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

export const keys = {
  upload: (episodeId: string, fileName: string) => `uploads/${episodeId}/${fileName}`,
  chapter: (episodeId: string, index: number) =>
    `episodes/${episodeId}/chapters/${String(index).padStart(3, "0")}.m4a`,
  book: (episodeId: string) => `episodes/${episodeId}/book.m4b`,
  cover: (episodeId: string, ext: string) => `episodes/${episodeId}/cover.${ext}`,
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
  readonly deleteEpisode: (episodeId: string) => Effect.Effect<void, StorageError>
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

    const deleteEpisode = Effect.fn("MediaStore.deleteEpisode")(function* (episodeId: string) {
      yield* deletePrefix(`episodes/${episodeId}/`)
      yield* deletePrefix(`uploads/${episodeId}/`)
    })

    return MediaStore.of({ put, get, head, deleteEpisode })
  }),
)
