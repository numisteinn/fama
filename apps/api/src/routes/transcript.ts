// The transcript of an episode, for podcast apps. It is made from the timing files once for each Ready, stored in
// R2, and served from there: a 500-chapter book is 500 R2 reads and tens of ms of CPU to make, too much for every
// request.
import { EpisodeId, Timing, type UserId } from "@fama/contracts"
import { Effect, Schema } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { feedUser } from "../auth.ts"
import { EpisodeRepo } from "../episode-repo.ts"
import { keys, mediaKey, MediaStore } from "../media-store.ts"
import { mediaResponse } from "../media.ts"
import { hasTranscript, renderTranscript } from "../transcript.ts"
import { handle, NotStored, webRequest } from "./kit.ts"

const TranscriptParams = Schema.Struct({ id: EpisodeId })

const decodeTiming = Schema.decodeUnknownEffect(Schema.fromJsonString(Timing))

const readTiming = Effect.fn("transcript.readTiming")(function* (userId: UserId, url: string | null, index: number) {
  const key = url === null ? null : mediaKey(userId, url.split("/").slice(3).join("/"))
  const object = key === null ? null : yield* (yield* MediaStore).get(key, null)
  if (object === null) return yield* new NotStored({ message: `The timing file of chapter ${index} is missing` })
  const text = yield* Effect.promise(() => object.text())
  // The API checked the file when the worker uploaded it, so a file that does not decode is a bug.
  return yield* Effect.orDie(decodeTiming(text))
})

const transcript = handle(
  Effect.gen(function* () {
    const { userId } = yield* feedUser
    const { id } = yield* HttpRouter.schemaPathParams(TranscriptParams)
    const repo = yield* EpisodeRepo
    const episode = yield* repo.get(userId, id)
    const timed = episode.chapters.map((chapter) => ({ hasTiming: chapter.timingUrl !== null }))
    if (episode.job._tag !== "Ready" || !hasTranscript(timed)) {
      return yield* new NotStored({ message: "The episode has no transcript" })
    }
    const { finishedAt } = episode.job
    const key = keys.transcriptRevision(userId, id, finishedAt)
    const store = yield* MediaStore
    if ((yield* store.head(key)) === null) {
      const chapters = yield* Effect.forEach(
        episode.chapters,
        (chapter) =>
          Effect.map(readTiming(userId, chapter.timingUrl, chapter.index), (timing) => ({
            durationMs: chapter.durationMs,
            segments: timing.segments,
          })),
        // A Worker has at most 6 connections open at once.
        { concurrency: 6 },
      )
      yield* store.put(key, new Blob([renderTranscript(chapters)]), "text/vtt; charset=utf-8")
      // An edit can queue this episode while the transcript is being built.
      const current = yield* repo.get(userId, id).pipe(Effect.catchTag("EpisodeNotFound", () => Effect.succeed(null)))
      if (current?.job._tag !== "Ready" || current.job.finishedAt !== finishedAt) {
        yield* store.deleteTranscript(userId, id, finishedAt)
        return yield* new NotStored({ message: "The episode has no transcript" })
      }
    }
    const response = yield* mediaResponse(yield* webRequest, key)
    response.headers.set("cache-control", "private, no-cache")
    return HttpServerResponse.raw(response)
  }),
)

export const transcriptRoutes = HttpRouter.addAll(
  (["GET", "HEAD"] as const).map((method) =>
    HttpRouter.route(method, "/media/:token/episodes/:id/transcript.vtt", transcript),
  ),
)
