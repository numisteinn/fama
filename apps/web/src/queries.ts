import { Document, EpisodeId, FeedInfo, SampleList, Timing, VoiceRef } from "@fama/contracts"
import { Command, Component, Query } from "@effect/ui"
import { AsyncResult } from "effect/reactivity"
import { Effect, Option, Redacted, Schema } from "effect"
import { ApiFailure, apiToken, episodePath } from "~/api"
import { FamaApi } from "~/services"

const MEDIA_TOKEN_PATH = /^\/media\/[^/]+(\/.*)$/

/** Strips `/media/<feedToken>` so query diagnostics never expose the private feed token. */
export const publicMediaPath = (url: string): string => {
  const match = MEDIA_TOKEN_PATH.exec(url)
  return match ? match[1]! : url
}

export const RedactedFeedInfo = Schema.Struct({
  url: Schema.Redacted(Schema.String),
})
export type RedactedFeedInfo = typeof RedactedFeedInfo.Type

export const RedactedSampleState = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Requested") }),
  Schema.Struct({ _tag: Schema.Literal("Ready"), url: Schema.Redacted(Schema.String) }),
  Schema.Struct({ _tag: Schema.Literal("Failed"), reason: Schema.String }),
])
export type RedactedSampleState = typeof RedactedSampleState.Type

export const RedactedSample = Schema.Struct({
  voice: VoiceRef,
  state: RedactedSampleState,
})
export type RedactedSample = typeof RedactedSample.Type

export const RedactedSampleList = Schema.Struct({
  samples: Schema.Array(RedactedSample),
})
export type RedactedSampleList = typeof RedactedSampleList.Type

export const redactSampleList = (list: typeof SampleList.Type): RedactedSampleList => ({
  samples: list.samples.map((sample) =>
    sample.state._tag === "Ready"
      ? { voice: sample.voice, state: { _tag: "Ready" as const, url: Redacted.make(sample.state.url) } }
      : { voice: sample.voice, state: sample.state },
  ),
})

/** Private podcast feed URL shown in Settings. Keyed per dialog opening (`openId`) so reopening never shows an expired URL. */
export class FeedQuery extends Query.Service<FeedQuery>()("fama/FeedQuery", {
  args: { origin: Schema.String, generation: Schema.Number, openId: Schema.Number },
  success: RedactedFeedInfo,
  error: ApiFailure,
  staleTime: 0,
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const api = yield* FamaApi
      return () =>
        api
          .sendJson(FeedInfo, "GET", "/api/feed")
          .pipe(Effect.map((info) => ({ url: Redacted.make(info.url) })))
    }),
  )
}

/** Stored extracted Document for an episode, keyed per screen opening (`openId`) and server (`origin`), so token changes for the same User never unmount an open editor. */
export class DocumentQuery extends Query.Service<DocumentQuery>()("fama/DocumentQuery", {
  args: { episodeId: EpisodeId, origin: Schema.String, openId: Schema.Number },
  success: Document,
  error: ApiFailure,
  staleTime: 0,
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const api = yield* FamaApi
      return ({ episodeId }) => api.sendJson(Document, "GET", `${episodePath(episodeId)}/document`)
    }),
  )
}

/**
 * Stored Document for Narrate again, where a missing Document (`404`) is a valid legacy state
 * (`Option.none()`). Modeling `404` as `Success(Option.none())` ensures background refetches
 * (e.g., a transient `503` on tab focus) retain `previousSuccess` and keep unsaved edits mounted.
 */
export class NarrateAgainDocumentQuery extends Query.Service<NarrateAgainDocumentQuery>()(
  "fama/NarrateAgainDocumentQuery",
  {
    args: { episodeId: EpisodeId, origin: Schema.String, openId: Schema.Number },
    success: Schema.Option(Document),
    error: ApiFailure,
    staleTime: 0,
  },
) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const api = yield* FamaApi
      return ({ episodeId }) =>
        api.sendJson(Document, "GET", `${episodePath(episodeId)}/document`).pipe(
          Effect.map(Option.some),
          Effect.catch((failure) =>
            failure.status === 404 ? Effect.succeed(Option.none<Document>()) : Effect.fail(failure),
          ),
        )
    }),
  )
}

/** Invalidates cached Documents after a confirmed HTTP write. */
export const InvalidateDocument = Command.make("fama/InvalidateDocument", { args: {} }, () =>
  Effect.all([DocumentQuery.invalidate(), NarrateAgainDocumentQuery.invalidate()]).pipe(
    Effect.as(Component.noop),
  ),
)

/** Voice samples for an episode in Review. Automatically polls every 2 s while any sample is Requested, even across transient errors. */
export class SamplesQuery extends Query.Service<SamplesQuery>()("fama/SamplesQuery", {
  args: { episodeId: EpisodeId, origin: Schema.String, generation: Schema.Number },
  success: RedactedSampleList,
  error: ApiFailure,
  staleTime: 0,
  refetchInterval: (result) =>
    Option.exists(AsyncResult.value(result), (list) =>
      list.samples.some((sample) => sample.state._tag === "Requested"),
    )
      ? "2 seconds"
      : undefined,
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const api = yield* FamaApi
      return ({ episodeId }) =>
        api
          .sendJson(SampleList, "GET", `${episodePath(episodeId)}/samples`)
          .pipe(Effect.map(redactSampleList))
    }),
  )
}

/** Timing file of one chapter. Immutable per URL; `path` is token-free for diagnostics and `url` is Redacted. */
export class TimingQuery extends Query.Service<TimingQuery>()("fama/TimingQuery", {
  args: { origin: Schema.String, path: Schema.String, url: Schema.Redacted(Schema.String) },
  success: Timing,
  error: ApiFailure,
  staleTime: "Infinity",
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const api = yield* FamaApi
      return ({ origin, url }) =>
        api.sendJson(Timing, "GET", Redacted.value(url), undefined, false, { origin, token: apiToken("") })
    }),
  )
}
