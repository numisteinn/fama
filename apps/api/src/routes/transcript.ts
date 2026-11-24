// The transcript of an episode, for podcast apps. It is made from the timing files once for each Ready, stored in
// R2, and served from there: a 500-chapter book is 500 R2 reads and tens of ms of CPU to make, too much for every
// request.
import { EpisodeId, Timing, type UserId } from "@fama/contracts"
import { Effect, Schema } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { feedUser } from "../auth.ts"
import { EpisodeRepo } from "../episode-repo.ts"
import { keys, MediaStore } from "../media-store.ts"
import { mediaResponse } from "../media.ts"
import { hasTranscript, renderTranscript } from "../transcript.ts"
import { handle, NotStored, webRequest } from "./kit.ts"

const TranscriptParams = Schema.Struct({ id: EpisodeId })

const decodeTiming = Schema.decodeUnknownEffect(Schema.fromJsonString(Timing))

/**
 * The stored transcript of the Ready that finished at `finishedAt`. A later Ready (the chapters were narrated again)
 * has a new key, so a stored transcript is never stale.
 */
const storedKey = (userId: UserId, episodeId: string, finishedAt: string) =>
  `${keys.transcript(userId, episodeId).replace(/\.vtt$/, "")}/${Date.parse(finishedAt)}.vtt`

const readTiming = Effect.fn("transcript.readTiming")(function* (userId: UserId, episodeId: string, index: number) {
  const object = yield* (yield* MediaStore).get(keys.timing(userId, episodeId, index), null)
  if (object === null) return yield* new NotStored({ message: `The timing file of chapter ${index} is missing` })
  const text = yield* Effect.promise(() => object.text())
  // The API checked the file when the worker uploaded it, so a file that does not decode is a bug.
  return yield* Effect.orDie(decodeTiming(text))
})

const transcript = handle(
  Effect.gen(function* () {
    const { userId } = yield* feedUser
    const { id } = yield* HttpRouter.schemaPathParams(TranscriptParams)
    const episode = yield* (yield* EpisodeRepo).get(userId, id)
    const timed = episode.chapters.map((chapter) => ({ hasTiming: chapter.timingUrl !== null }))
    if (episode.job._tag !== "Ready" || !hasTranscript(timed)) {
      return yield* new NotStored({ message: "The episode has no transcript" })
    }
    const key = storedKey(userId, id, episode.job.finishedAt)
    const store = yield* MediaStore
    if ((yield* store.head(key)) === null) {
      const chapters = yield* Effect.forEach(
        episode.chapters,
        (chapter) =>
          Effect.map(readTiming(userId, id, chapter.index), (timing) => ({
            durationMs: chapter.durationMs,
            segments: timing.segments,
          })),
        // A Worker has at most 6 connections open at once.
        { concurrency: 6 },
      )
      yield* store.put(key, new Blob([renderTranscript(chapters)]), "text/vtt; charset=utf-8")
    }
    return HttpServerResponse.raw(yield* mediaResponse(yield* webRequest, key))
  }),
)

export const transcriptRoutes = HttpRouter.addAll(
  (["GET", "HEAD"] as const).map((method) =>
    HttpRouter.route(method, "/media/:token/episodes/:id/transcript.vtt", transcript),
  ),
)
