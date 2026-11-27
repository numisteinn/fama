import {
  EpisodeId,
  SampleList,
  SamplesRequest,
  Voice,
  VoiceRef,
} from "@fama/contracts"
import { Command, Component, Subscription, UiSchema } from "@effect/ui"
import { Button, RadioGroup } from "@effect/ui-kit"
import { Html } from "@effect/ui/html"
import { Cause, Context, Effect, Layer, Option, Queue, Redacted, Schema, Stream } from "effect"
import { HttpClientRequest } from "effect/http"
import { AsyncResult } from "effect/reactivity"
import { ApiFailure, episodePath } from "~/core/api"
import {
  type RedactedSample,
  RedactedSampleList,
  SamplesQuery,
  redactSampleList,
} from "~/core/queries"
import { FamaApi } from "~/core/services"
import { languageName, languageOf } from "~/core/voices"
import { buttonClass, cx } from "~/ui/button"
import * as Icon from "~/ui/icon"

// --- Scoped sample audio service (replaces module-level mutable globals) ---

export interface SampleAudioState {
  readonly element: HTMLAudioElement
  activeVoice: VoiceRef | null
}

const stopSample = (state: SampleAudioState) => {
  state.activeVoice = null
  state.element.pause()
  state.element.removeAttribute("src")
  state.element.load()
}

export class SampleAudioPlayer extends Context.Service<SampleAudioPlayer, SampleAudioState>()(
  "fama/web/SampleAudioPlayer",
) {
  static readonly layer = Layer.effect(
    SampleAudioPlayer,
    Effect.acquireRelease(
      Effect.sync((): SampleAudioState => {
        const element = new Audio()
        element.preload = "auto"
        return { element, activeVoice: null }
      }),
      (state) => Effect.sync(() => stopSample(state)),
    ),
  )
}

const isInterrupted = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "name" in error && error.name === "AbortError"

// --- Pure helpers ---

export interface ReviewVoiceOption {
  readonly id: VoiceRef
  readonly name: string
  readonly label: string
  readonly gender: Voice["gender"]
  readonly maybeSample: Option.Option<RedactedSample>
}

/** Voices available for the Document's language, plus any sample voices returned by the API. */
export const reviewVoices = (
  voices: ReadonlyArray<Voice>,
  language: string,
  samples: ReadonlyArray<RedactedSample>,
): ReadonlyArray<ReviewVoiceOption> => {
  const target = languageOf(language)
  const sampleByVoice = new Map<string, RedactedSample>(samples.map((sample) => [sample.voice, sample]))
  const matched = voices
    .filter((voice) => languageOf(voice.language) === target)
    .toSorted((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  const seen = new Set<string>(matched.map((voice) => voice.id))
  const extras = samples
    .filter((sample) => !seen.has(sample.voice))
    .map((sample) => {
      const [engine = "", rawName = sample.voice] = sample.voice.split(":")
      return { id: sample.voice, engine, name: rawName, language, gender: null }
    })
  const combined = [...matched, ...extras]
  const nameCounts = new Map<string, number>()
  for (const voice of combined) nameCounts.set(voice.name, (nameCounts.get(voice.name) ?? 0) + 1)
  return combined.map((voice) => ({
    id: voice.id,
    name: voice.name,
    label: (nameCounts.get(voice.name) ?? 0) > 1 ? `${voice.name} (${voice.engine})` : voice.name,
    gender: voice.gender,
    maybeSample: Option.fromNullishOr(sampleByVoice.get(voice.id)),
  }))
}

// --- Schemas ---

export const SampleError = Schema.Struct({
  source: Schema.Literals(["fetch", "audio"]),
  message: Schema.String,
})
export type SampleError = typeof SampleError.Type

export const VoiceSamplesProps = Schema.Struct({
  episodeId: EpisodeId,
  origin: Schema.String,
  connectionGeneration: Schema.Number,
  language: Schema.String,
  speed: Schema.Number,
  voices: Schema.Array(Voice),
  initialVoice: Schema.NullOr(VoiceRef),
  isBusy: Schema.Boolean,
  isSavingVoice: Schema.Boolean,
  maybeVoiceError: Schema.Option(Schema.String),
  isMainPlaying: Schema.Boolean,
})
export type VoiceSamplesProps = typeof VoiceSamplesProps.Type

export const VoiceSamplesModel = Schema.Struct({
  maybeSelectedVoice: Schema.Option(VoiceRef),
  maybePlayingVoice: Schema.Option(VoiceRef),
  maybeError: Schema.Option(SampleError),
})
export type VoiceSamplesModel = typeof VoiceSamplesModel.Type

export const VoiceSamplesMessage = UiSchema.TaggedEnum({
  ClickedHearVoices: {},
  ClickedRetrySample: { voice: VoiceRef },
  SucceededRequestSamples: {},
  FailedRequestSamples: { failure: ApiFailure },
  PickedVoice: { voice: VoiceRef },
  ClickedRetryVoice: {},
  ClickedPlaySample: { voice: VoiceRef },
  ClickedPauseSample: {},
  EndedSampleAudio: { voice: VoiceRef },
  PausedSampleAudio: { voice: VoiceRef },
  FailedPlaySample: { voice: VoiceRef, message: Schema.String },
  MainPlaybackStarted: {},
})
export type VoiceSamplesMessage = typeof VoiceSamplesMessage.Type

export const VoiceSamplesEvents = UiSchema.TaggedEnum({
  SelectedVoice: { voice: VoiceRef },
  RequestedChangeVoice: { episodeId: EpisodeId, voice: VoiceRef, speed: Schema.Number },
  RequestedPauseMainPlayback: {},
})
export type VoiceSamplesEvents = typeof VoiceSamplesEvents.Type

// --- Commands ---

const encodeSamplesRequest = Schema.encodeSync(SamplesRequest)

/** Requests generation of all language samples (`voice: null`) or retries one voice. Writes directly into `SamplesQuery`. */
export class RequestSamples extends Command.Service<RequestSamples>()("review/RequestSamples", {
  args: {
    episodeId: EpisodeId,
    origin: Schema.String,
    generation: Schema.Number,
    voice: Schema.NullOr(VoiceRef),
  },
  group: ["voice"],
  success: RedactedSampleList,
  error: ApiFailure,
  invalidates: () => [SamplesQuery],
  writes: (result, { episodeId, origin, generation }) => [
    SamplesQuery.set({ episodeId, origin, generation }, result),
  ],
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const api = yield* FamaApi
      return ({ episodeId, voice }) =>
        api
          .sendJson(SampleList, "POST", `${episodePath(episodeId)}/samples`, (request) =>
            HttpClientRequest.bodyJsonUnsafe(
              request,
              voice === null ? {} : encodeSamplesRequest({ voices: [voice] }),
            ),
          )
          .pipe(Effect.map(redactSampleList))
    }),
  )
}

export class PlaySampleAudio extends Command.Service<PlaySampleAudio>()("review/PlaySampleAudio", {
  args: { voice: VoiceRef, src: Schema.Redacted(Schema.String) },
  mode: "switch",
  success: Schema.Union([VoiceSamplesMessage, Component.Noop]),
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const state = yield* SampleAudioPlayer
      return ({ voice, src }) =>
        Effect.tryPromise(() => {
          state.activeVoice = null
          state.element.pause()
          state.activeVoice = voice
          state.element.src = Redacted.value(src)
          state.element.currentTime = 0
          state.element.defaultPlaybackRate = 1
          state.element.playbackRate = 1
          return state.element.play()
        }).pipe(
          Effect.match({
            onSuccess: (): VoiceSamplesMessage | Component.Noop => Component.noop,
            onFailure: ({ cause: error }): VoiceSamplesMessage | Component.Noop => {
              if (isInterrupted(error)) return Component.noop
              if (state.activeVoice === voice) state.activeVoice = null
              return VoiceSamplesMessage.FailedPlaySample({ voice, message: "Could not play sample" })
            },
          }),
        )
    }),
  )
}

export class StopSampleAudio extends Command.Service<StopSampleAudio>()("review/StopSampleAudio", {
  args: {},
  success: Component.Noop,
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const state = yield* SampleAudioPlayer
      return () =>
        Effect.sync(() => {
          stopSample(state)
          return Component.noop
        })
    }),
  )
}

const clearErrorOf = (
  maybeError: Option.Option<SampleError>,
  source: SampleError["source"],
): Option.Option<SampleError> =>
  Option.exists(maybeError, (error) => error.source === source) ? Option.none() : maybeError

const querySamples = (
  result: AsyncResult.AsyncResult<RedactedSampleList, ApiFailure>,
): ReadonlyArray<RedactedSample> =>
  Option.match(AsyncResult.value(result), {
    onNone: () => [],
    onSome: (list) => list.samples,
  })

const queryError = (result: AsyncResult.AsyncResult<RedactedSampleList, ApiFailure>): string | undefined =>
  AsyncResult.isFailure(result)
    ? Option.getOrUndefined(Cause.findErrorOption(result.cause))?.message ?? "Could not load samples"
    : undefined

export const VoiceSamplesNoDeps = Html.component({
  name: "VoiceSamples",
  props: VoiceSamplesProps,
  model: VoiceSamplesModel,
  message: VoiceSamplesMessage,
  events: VoiceSamplesEvents,
  queries: {
    samples: {
      query: SamplesQuery,
      args: ({ props }) => ({
        episodeId: props.episodeId,
        origin: props.origin,
        generation: props.connectionGeneration,
      }),
    },
  },
}).make({
  init: ($) => ({
    maybeSelectedVoice: Option.fromNullishOr($.props.initialVoice),
    maybePlayingVoice: Option.none(),
    maybeError: Option.none(),
  }),
  update: {
    ClickedHearVoices: ($) => {
      if ($.props.isBusy) return $.model
      return $.evolve({ maybeError: clearErrorOf($.model.maybeError, "fetch") }).run(
        RequestSamples.make({
          episodeId: $.props.episodeId,
          origin: $.props.origin,
          generation: $.props.connectionGeneration,
          voice: null,
        }).pipe(
          Command.match({
            onSuccess: () => VoiceSamplesMessage.SucceededRequestSamples(),
            onFailure: (failure) => VoiceSamplesMessage.FailedRequestSamples({ failure }),
          }),
        ),
      )
    },
    ClickedRetrySample: ($, { voice }) => {
      if ($.props.isBusy) return $.model
      return $.evolve({ maybeError: clearErrorOf($.model.maybeError, "fetch") }).run(
        RequestSamples.make({
          episodeId: $.props.episodeId,
          origin: $.props.origin,
          generation: $.props.connectionGeneration,
          voice,
        }).pipe(
          Command.match({
            onSuccess: () => VoiceSamplesMessage.SucceededRequestSamples(),
            onFailure: (failure) => VoiceSamplesMessage.FailedRequestSamples({ failure }),
          }),
        ),
      )
    },
    SucceededRequestSamples: ($) =>
      $.evolve({ maybeError: clearErrorOf($.model.maybeError, "fetch") }),
    FailedRequestSamples: ($, { failure }) =>
      $.evolve({ maybeError: Option.some({ source: "fetch" as const, message: failure.message }) }),
    PickedVoice: ($, { voice }) => {
      if ($.props.isBusy) return $.model
      const hasVoiceError = Option.isSome($.props.maybeVoiceError)
      if (Option.contains($.model.maybeSelectedVoice, voice) && !hasVoiceError) return $.model
      const speed = Number.isFinite($.props.speed) && $.props.speed > 0 ? $.props.speed : 1
      return $.evolve({
        maybeSelectedVoice: Option.some(voice),
      })
        .emit(VoiceSamplesEvents.SelectedVoice({ voice }))
        .emit(VoiceSamplesEvents.RequestedChangeVoice({ episodeId: $.props.episodeId, voice, speed }))
    },
    ClickedRetryVoice: ($) => {
      if ($.props.isBusy || $.props.isSavingVoice || Option.isNone($.model.maybeSelectedVoice)) return $.model
      const voice = $.model.maybeSelectedVoice.value
      const speed = Number.isFinite($.props.speed) && $.props.speed > 0 ? $.props.speed : 1
      return $.emit(VoiceSamplesEvents.RequestedChangeVoice({ episodeId: $.props.episodeId, voice, speed }))
    },
    ClickedPlaySample: ($, { voice }) => {
      const sample = querySamples($.queries.samples).find((item) => item.voice === voice)
      if (!sample || sample.state._tag !== "Ready") return $.model
      return $.evolve({
        maybePlayingVoice: Option.some(voice),
        maybeError: clearErrorOf($.model.maybeError, "audio"),
      })
        .emit(VoiceSamplesEvents.RequestedPauseMainPlayback())
        .run(PlaySampleAudio.make({ voice, src: Redacted.make($.props.origin + Redacted.value(sample.state.url)) }))
    },
    ClickedPauseSample: ($) =>
      Option.isSome($.model.maybePlayingVoice)
        ? $.evolve({ maybePlayingVoice: Option.none() }).run(StopSampleAudio.make({}))
        : $.model,
    EndedSampleAudio: ($, { voice }) =>
      Option.contains($.model.maybePlayingVoice, voice)
        ? $.evolve({ maybePlayingVoice: Option.none() })
        : $.model,
    PausedSampleAudio: ($, { voice }) =>
      Option.contains($.model.maybePlayingVoice, voice)
        ? $.evolve({ maybePlayingVoice: Option.none() })
        : $.model,
    FailedPlaySample: ($, { voice, message }) =>
      Option.contains($.model.maybePlayingVoice, voice)
        ? $.evolve({
            maybePlayingVoice: Option.none(),
            maybeError: Option.some({ source: "audio" as const, message }),
          })
        : $.model,
    MainPlaybackStarted: ($) =>
      Option.isSome($.model.maybePlayingVoice)
        ? $.evolve({ maybePlayingVoice: Option.none() }).run(StopSampleAudio.make({}))
        : $.model,
  },
  subscriptions: ({ model, props }) => [
    props.isMainPlaying &&
      Option.isSome(model.maybePlayingVoice) &&
      Subscription.make("stop-on-main-play", Stream.make(VoiceSamplesMessage.MainPlaybackStarted())),
    Option.isSome(model.maybePlayingVoice) &&
      Subscription.make(
        "sample-audio-events",
        Stream.unwrap(
          Effect.gen(function* () {
            const state = yield* SampleAudioPlayer
            return Stream.callback<VoiceSamplesMessage>((queue) =>
              Effect.acquireRelease(
                Effect.sync(() => {
                  const audio = state.element
                  const onEnded = () => {
                    if (state.activeVoice === null) return
                    const voice = state.activeVoice
                    state.activeVoice = null
                    Queue.offerUnsafe(queue, VoiceSamplesMessage.EndedSampleAudio({ voice }))
                  }
                  const onPause = () => {
                    if (audio.ended || state.activeVoice === null) return
                    const voice = state.activeVoice
                    state.activeVoice = null
                    Queue.offerUnsafe(queue, VoiceSamplesMessage.PausedSampleAudio({ voice }))
                  }
                  const onError = () => {
                    if (state.activeVoice === null) return
                    const voice = state.activeVoice
                    state.activeVoice = null
                    Queue.offerUnsafe(
                      queue,
                      VoiceSamplesMessage.FailedPlaySample({ voice, message: "Could not play sample" }),
                    )
                  }
                  audio.addEventListener("ended", onEnded)
                  audio.addEventListener("pause", onPause)
                  audio.addEventListener("error", onError)
                  return () => {
                    audio.removeEventListener("ended", onEnded)
                    audio.removeEventListener("pause", onPause)
                    audio.removeEventListener("error", onError)
                    stopSample(state)
                  }
                }),
                (cleanup) => Effect.sync(cleanup),
              ).pipe(Effect.flatMap(() => Effect.never)),
            )
          }),
        ),
      ),
  ],
  view: (h, model) => {
    const items = querySamples(h.queries.samples)
    const list = reviewVoices(h.props.voices, h.props.language, items)
    if (list.length === 0) return h.div.class("hidden")

    const isRequestingAll = h.isRunning(RequestSamples, { voice: null })
    const hasUnsampled = list.some((voice) => Option.isNone(voice.maybeSample))
    const isGenerating = items.some((sample) => sample.state._tag === "Requested")
    const errorMessage = Option.match(model.maybeError, {
      onNone: () =>
        Option.match(h.props.maybeVoiceError, {
          onNone: () => queryError(h.queries.samples),
          onSome: (message) => message,
        }),
      onSome: (error) => error.message,
    })
    const showVoiceRetry =
      Option.isNone(model.maybeError) &&
      Option.isSome(h.props.maybeVoiceError) &&
      Option.isSome(model.maybeSelectedVoice)

    const sampleAction = (option: ReviewVoiceOption) =>
      Option.match(option.maybeSample, {
        onNone: () => null,
        onSome: (sample) => {
          switch (sample.state._tag) {
            case "Requested":
              return h.span
                .attrs({ role: "status", "aria-label": `Generating ${option.label} sample` })
                .class("inline-flex shrink-0 items-center gap-1.5 text-[13px] text-muted-foreground")
                .children(Icon.loaderCircle(h, "size-3.5 animate-spin"), "Generating…")
            case "Ready": {
              const isPlaying = Option.contains(model.maybePlayingVoice, option.id)
              return Button(h, {
                props: { disabled: !isPlaying && h.props.isBusy },
                onPress: isPlaying
                  ? VoiceSamplesMessage.ClickedPauseSample()
                  : VoiceSamplesMessage.ClickedPlaySample({ voice: option.id }),
              })
                .attr("aria-label", isPlaying ? `Pause ${option.label} sample` : `Play ${option.label} sample`)
                .class(buttonClass({ variant: isPlaying ? "primary" : "outline", size: "sm" }, "shrink-0"))
                .children(
                  isPlaying ? Icon.pause(h, "size-3.5") : Icon.play(h, "size-3.5 fill-current"),
                  isPlaying ? "Pause" : "Play",
                )
            }
            case "Failed": {
              const isRetrying = h.isRunning(RequestSamples, { voice: option.id })
              return Button(h, {
                props: { disabled: h.props.isBusy || isRetrying },
                onPress: VoiceSamplesMessage.ClickedRetrySample({ voice: option.id }),
              })
                .attr("aria-label", `Retry ${option.label} sample`)
                .class(buttonClass({ variant: "outline", size: "sm" }, "shrink-0"))
                .children(
                  isRetrying ? Icon.loaderCircle(h, "size-3.5 animate-spin") : Icon.rotateCw(h, "size-3.5"),
                  isRetrying ? "Retrying…" : "Retry",
                )
            }
          }
        },
      })

    return h.div.class("flex flex-col gap-2").children(
      h.div.class("flex items-center justify-between gap-2").children(
        h.div.class("flex items-baseline gap-2").children(
          h.h2.class("text-sm font-medium text-foreground").children("Voice"),
          h.span.class("text-[13px] text-muted-foreground").children(languageName(h.props.language)),
        ),
        hasUnsampled
          ? Button(h, {
              props: { disabled: h.props.isBusy || isRequestingAll },
              onPress: VoiceSamplesMessage.ClickedHearVoices(),
            })
              .class(buttonClass({ variant: "outline", size: "sm" }))
              .children(
                isRequestingAll ? Icon.loaderCircle(h, "size-3.5 animate-spin") : Icon.audioLines(h, "size-3.5"),
                isRequestingAll ? "Requesting…" : "Hear voices",
              )
          : isGenerating
            ? h.span
                .class("inline-flex items-center gap-1.5 text-[13px] text-muted-foreground")
                .children(Icon.loaderCircle(h, "size-3.5 animate-spin"), "Generating samples…")
            : null,
      ),
      errorMessage &&
        h.div.class("flex items-center justify-between gap-2").children(
          h.p.attr("role", "alert").class("text-[13px] text-destructive").children(errorMessage),
          showVoiceRetry &&
            Button(h, {
              props: { disabled: h.props.isBusy || h.props.isSavingVoice },
              onPress: VoiceSamplesMessage.ClickedRetryVoice(),
            })
              .attr("aria-label", "Retry saving voice")
              .class(buttonClass({ variant: "outline", size: "sm" }, "shrink-0"))
              .children(Icon.rotateCw(h, "size-3.5"), "Retry"),
        ),
      RadioGroup(h, {
        props: {
          value: Option.getOrNull(model.maybeSelectedVoice),
          items: list.map((option) => ({ value: option.id })),
          disabled: h.props.isBusy,
        },
        onEmit: {
          Picked: ({ value }) => VoiceSamplesMessage.PickedVoice({ voice: value as VoiceRef }),
        },
        view: (radioGroup) =>
          radioGroup
            .root(
              h.div
                .attr("aria-label", "Voice")
                .class(
                  "flex max-h-72 flex-col divide-y divide-border overflow-y-auto rounded-2xl border border-border bg-surface",
                ),
            )
            .children(
              ...list.map((option) => {
                const isSelected = Option.contains(model.maybeSelectedVoice, option.id)
                const failedReason = Option.match(option.maybeSample, {
                  onNone: () => null,
                  onSome: (sample) => (sample.state._tag === "Failed" ? sample.state.reason : null),
                })
                const genderLabel =
                  option.gender === "female" ? "Female" : option.gender === "male" ? "Male" : null
                return h.div
                  .key(option.id)
                  .class(
                    cx(
                      "flex min-h-12 items-center justify-between gap-3 px-3 py-2 transition-colors duration-150",
                      isSelected && "bg-accent/60",
                    ),
                  )
                  .children(
                    radioGroup
                      .radio({
                        element: h.button
                          .attr("aria-label", option.label)
                          .class(
                            "flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-lg py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40",
                          ),
                        value: option.id,
                      })
                      .children(
                        h.span
                          .attr("aria-hidden", "true")
                          .class(
                            cx(
                              "grid size-4.5 shrink-0 place-items-center rounded-full border transition-colors duration-150",
                              isSelected
                                ? "border-foreground bg-foreground"
                                : "border-input bg-transparent",
                            ),
                          )
                          .children(isSelected && h.span.class("block size-1.5 rounded-full bg-background")),
                        h.span.class("min-w-0 flex-1").children(
                          h.span
                            .class("block truncate text-[15px] leading-snug text-foreground")
                            .children(option.label),
                          failedReason
                            ? h.span
                                .attr("title", failedReason)
                                .class("block truncate text-[12px] text-destructive")
                                .children(failedReason)
                            : genderLabel
                              ? h.span
                                  .class("block truncate text-[12px] text-muted-foreground")
                                  .children(genderLabel)
                              : null,
                        ),
                      ),
                    sampleAction(option),
                  )
              }),
            ),
      }),
    )
  },
})

const voiceSamplesLayers = Layer.mergeAll(
  SamplesQuery.layer,
  RequestSamples.layer,
  PlaySampleAudio.layer.pipe(Layer.provide(SampleAudioPlayer.layer)),
  StopSampleAudio.layer.pipe(Layer.provide(SampleAudioPlayer.layer)),
  SampleAudioPlayer.layer,
)

export const VoiceSamples = VoiceSamplesNoDeps.pipe(Component.provide(voiceSamplesLayers))
