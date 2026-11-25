import {
  ChangeVoice,
  EpisodeId,
  Sample,
  SampleList,
  SamplesRequest,
  type Voice,
  VoiceRef,
} from "@fama/contracts"
import { Duration, Effect, Option, Queue, Schema, Stream } from "effect"
import { type HttpClient, HttpClientRequest } from "effect/http"
import { Command, Subscription, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { ApiFailure, Connection, episodePath, send, sendJson } from "~/api"
import { buttonClass, cx } from "~/view/button"
import * as Icon from "~/view/icon"

export const SAMPLE_POLL_MS = 2000

// MODEL

export const Samples = Schema.Struct({
  /** Selected voice for narration in Review, initialized from the episode's voice. */
  maybeSelectedVoice: Schema.Option(VoiceRef),
  /** True once the user selects a voice in Review, so Start sends it atomically. */
  hasSelectedVoice: Schema.Boolean,
  /** True once the initial `GET /api/episodes/:id/samples` has been triggered for this Review session. */
  hasLoaded: Schema.Boolean,
  /** True while requesting samples for all language voices is in flight. */
  isRequesting: Schema.Boolean,
  /** Voices currently being retried individually. */
  retryingVoices: Schema.Array(VoiceRef),
  /** Samples returned by the API for this episode. */
  items: Schema.Array(Sample),
  /** Voice whose sample clip is currently playing in Review. */
  maybePlayingVoice: Schema.Option(VoiceRef),
  /** Error from fetching/requesting samples, playing a sample, or saving the selected voice. */
  maybeError: Schema.Option(Schema.String),
})
export type Samples = typeof Samples.Type

export const initSamples = (voice: VoiceRef | null): Samples => ({
  maybeSelectedVoice: Option.fromNullishOr(voice),
  hasSelectedVoice: false,
  hasLoaded: false,
  isRequesting: false,
  retryingVoices: [],
  items: [],
  maybePlayingVoice: Option.none(),
  maybeError: Option.none(),
})

export const hasRequestedSamples = (samples: Samples): boolean =>
  samples.items.some((sample) => sample.state._tag === "Requested")

export const selectedVoiceForStart = (samples: Samples): VoiceRef | undefined =>
  samples.hasSelectedVoice ? Option.getOrUndefined(samples.maybeSelectedVoice) : undefined

/** Base language tag (`en-US` / `is_IS` -> `en` / `is`), matching the API's sample language filter. */
export const languageOf = (language: string): string =>
  language.toLowerCase().split(/[-_]/)[0] ?? language.toLowerCase()

const languageNames = new Intl.DisplayNames(undefined, { type: "language" })
const languageName = (code: string): string => {
  try {
    return languageNames.of(code) ?? code
  } catch {
    return code
  }
}

export interface ReviewVoiceOption {
  readonly id: VoiceRef
  readonly name: string
  readonly label: string
  readonly gender: Voice["gender"]
  readonly maybeSample: Option.Option<Sample>
}

/** Voices available for the Document's language, plus any sample voices returned by the API. */
export const reviewVoices = (
  voices: ReadonlyArray<Voice>,
  language: string,
  samples: ReadonlyArray<Sample>,
): ReadonlyArray<ReviewVoiceOption> => {
  const target = languageOf(language)
  const sampleByVoice = new Map<string, Sample>(samples.map((sample) => [sample.voice, sample]))
  const matched = voices
    .filter((voice) => languageOf(voice.language) === target)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
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

// MESSAGE

export const SamplesMessage = defineMessageUnion({
  RequestedInitialFetch: {},
  ClickedHearVoices: {},
  ClickedRetrySample: { voice: VoiceRef },
  TickedPoll: {},
  SucceededFetchSamples: { episodeId: EpisodeId, samples: Schema.Array(Sample) },
  FailedFetchSamples: { episodeId: EpisodeId, failure: ApiFailure },
  SucceededRequestSamples: { episodeId: EpisodeId, samples: Schema.Array(Sample) },
  FailedRequestSamples: { episodeId: EpisodeId, maybeVoice: Schema.Option(VoiceRef), failure: ApiFailure },
  ClickedSelectVoice: { voice: VoiceRef },
  SucceededChangeVoice: { episodeId: EpisodeId, voice: VoiceRef, speed: Schema.Number },
  FailedChangeVoice: { episodeId: EpisodeId, voice: VoiceRef, failure: ApiFailure },
  ClickedPlaySample: { voice: VoiceRef },
  ClickedPauseSample: {},
  CompletedPlaySample: {},
  CompletedStopSample: {},
  EndedSampleAudio: { voice: VoiceRef },
  PausedSampleAudio: { voice: VoiceRef },
  FailedPlaySample: { voice: VoiceRef, message: Schema.String },
})
export type SamplesMessage = typeof SamplesMessage.Type

// AUDIO ELEMENT

let sampleAudioElement: HTMLAudioElement | undefined
let activeSampleVoice: VoiceRef | null = null
let isStoppingProgrammatically = false

const getSampleAudio = (): HTMLAudioElement => {
  if (!sampleAudioElement) {
    sampleAudioElement = new Audio()
    sampleAudioElement.preload = "auto"
  }
  return sampleAudioElement
}

const stopSampleElement = () => {
  if (!sampleAudioElement) {
    activeSampleVoice = null
    return
  }
  activeSampleVoice = null
  isStoppingProgrammatically = true
  try {
    sampleAudioElement.pause()
    sampleAudioElement.removeAttribute("src")
    sampleAudioElement.load()
  } finally {
    isStoppingProgrammatically = false
  }
}

const isInterrupted = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "name" in error && error.name === "AbortError"

// COMMANDS

const encodeSamplesRequest = Schema.encodeSync(SamplesRequest)
const encodeChangeVoice = Schema.encodeSync(ChangeVoice)

export const FetchSamples = Command.define("FetchSamples", {
  args: { connection: Connection, episodeId: EpisodeId },
  messages: [SamplesMessage.SucceededFetchSamples, SamplesMessage.FailedFetchSamples],
  execute: ({ connection, episodeId }) =>
    sendJson(SampleList, connection, "GET", `${episodePath(episodeId)}/samples`).pipe(
      Effect.map(({ samples }) => SamplesMessage.SucceededFetchSamples({ episodeId, samples })),
      Effect.catch((failure) => Effect.succeed(SamplesMessage.FailedFetchSamples({ episodeId, failure }))),
    ),
})

export const RequestSamples = Command.define("RequestSamples", {
  args: { connection: Connection, episodeId: EpisodeId, maybeVoice: Schema.Option(VoiceRef) },
  messages: [SamplesMessage.SucceededRequestSamples, SamplesMessage.FailedRequestSamples],
  execute: ({ connection, episodeId, maybeVoice }) =>
    sendJson(SampleList, connection, "POST", `${episodePath(episodeId)}/samples`, (request) =>
      HttpClientRequest.bodyJsonUnsafe(
        request,
        Option.match(maybeVoice, {
          onNone: () => ({}),
          onSome: (voice) => encodeSamplesRequest({ voices: [voice] }),
        }),
      ),
    ).pipe(
      Effect.map(({ samples }) => SamplesMessage.SucceededRequestSamples({ episodeId, samples })),
      Effect.catch((failure) => Effect.succeed(SamplesMessage.FailedRequestSamples({ episodeId, maybeVoice, failure }))),
    ),
})

export const ChangeReviewVoice = Command.define("ChangeReviewVoice", {
  args: { connection: Connection, episodeId: EpisodeId, voice: VoiceRef, speed: Schema.Number },
  messages: [SamplesMessage.SucceededChangeVoice, SamplesMessage.FailedChangeVoice],
  execute: ({ connection, episodeId, voice, speed }) =>
    send(connection, "PUT", `${episodePath(episodeId)}/voice`, (request) =>
      HttpClientRequest.bodyJsonUnsafe(request, encodeChangeVoice({ voice, speed })),
    ).pipe(
      Effect.as(SamplesMessage.SucceededChangeVoice({ episodeId, voice, speed })),
      Effect.catch((failure) => Effect.succeed(SamplesMessage.FailedChangeVoice({ episodeId, voice, failure }))),
    ),
})

export const PlaySampleAudio = Command.define("PlaySampleAudio", {
  args: { voice: VoiceRef, src: Schema.String },
  messages: [SamplesMessage.CompletedPlaySample, SamplesMessage.FailedPlaySample],
  execute: ({ voice, src }) =>
    Effect.tryPromise({
      try: () => {
        const audio = getSampleAudio()
        isStoppingProgrammatically = true
        try {
          audio.pause()
        } finally {
          isStoppingProgrammatically = false
        }
        activeSampleVoice = voice
        audio.src = src
        audio.currentTime = 0
        audio.defaultPlaybackRate = 1
        audio.playbackRate = 1
        return audio.play()
      },
      catch: (error) => error,
    }).pipe(
      Effect.as(SamplesMessage.CompletedPlaySample()),
      Effect.catch((error) => {
        if (isInterrupted(error)) {
          return Effect.succeed<typeof SamplesMessage.CompletedPlaySample.Type | typeof SamplesMessage.FailedPlaySample.Type>(
            SamplesMessage.CompletedPlaySample(),
          )
        }
        if (activeSampleVoice === voice) activeSampleVoice = null
        return Effect.succeed<typeof SamplesMessage.CompletedPlaySample.Type | typeof SamplesMessage.FailedPlaySample.Type>(
          SamplesMessage.FailedPlaySample({ voice, message: "Could not play sample" }),
        )
      }),
    ),
})

export const StopSampleAudio = Command.define("StopSampleAudio", {
  messages: [SamplesMessage.CompletedStopSample],
  execute: Effect.sync(() => {
    stopSampleElement()
    return SamplesMessage.CompletedStopSample()
  }),
})

// UPDATE

export interface SamplesContext {
  readonly connection: Connection
  readonly episodeId: EpisodeId
  readonly speed: number
  readonly isBusy: boolean
}

export interface SamplesOutMessage {
  readonly pausePlayback?: boolean
  readonly changedVoice?: { readonly episodeId: EpisodeId; readonly voice: VoiceRef; readonly speed: number }
}

type SamplesReturn = Update.ReturnWithOutMessage<Samples, SamplesMessage, SamplesOutMessage, HttpClient.HttpClient>

export const updateSamples = (
  samples: Samples,
  message: SamplesMessage,
  context: SamplesContext,
): SamplesReturn => {
  const { connection, episodeId, speed, isBusy } = context
  const validSpeed = Number.isFinite(speed) && speed > 0 ? speed : 1
  return SamplesMessage.match<SamplesReturn>(message, {
    RequestedInitialFetch: () =>
      samples.hasLoaded
        ? { model: samples }
        : {
            model: { ...samples, hasLoaded: true },
            commands: [FetchSamples({ connection, episodeId })],
          },
    ClickedHearVoices: () =>
      samples.isRequesting || isBusy
        ? { model: samples }
        : {
            model: { ...samples, hasLoaded: true, isRequesting: true, maybeError: Option.none() },
            commands: [RequestSamples({ connection, episodeId, maybeVoice: Option.none() })],
          },
    ClickedRetrySample: ({ voice }) =>
      samples.retryingVoices.includes(voice) || isBusy
        ? { model: samples }
        : {
            model: {
              ...samples,
              hasLoaded: true,
              retryingVoices: [...samples.retryingVoices, voice],
              maybeError: Option.none(),
            },
            commands: [RequestSamples({ connection, episodeId, maybeVoice: Option.some(voice) })],
          },
    TickedPoll: () =>
      hasRequestedSamples(samples)
        ? { model: samples, commands: [FetchSamples({ connection, episodeId })] }
        : { model: samples },
    SucceededFetchSamples: ({ episodeId: targetId, samples: items }) => {
      if (targetId !== episodeId) return { model: samples }
      const stillPlayable = Option.exists(samples.maybePlayingVoice, (voice) =>
        items.some((item) => item.voice === voice && item.state._tag === "Ready"),
      )
      const stopped = Option.isSome(samples.maybePlayingVoice) && !stillPlayable
      return {
        model: {
          ...samples,
          hasLoaded: true,
          items,
          maybePlayingVoice: stopped ? Option.none() : samples.maybePlayingVoice,
          maybeError: Option.none(),
        },
        commands: stopped ? [StopSampleAudio()] : [],
      }
    },
    FailedFetchSamples: ({ episodeId: targetId, failure }) =>
      targetId === episodeId
        ? { model: { ...samples, hasLoaded: true, maybeError: Option.some(failure.message) } }
        : { model: samples },
    SucceededRequestSamples: ({ episodeId: targetId, samples: items }) =>
      targetId === episodeId
        ? {
            model: {
              ...samples,
              hasLoaded: true,
              isRequesting: false,
              retryingVoices: [],
              items,
              maybeError: Option.none(),
            },
          }
        : { model: samples },
    FailedRequestSamples: ({ episodeId: targetId, maybeVoice, failure }) =>
      targetId === episodeId
        ? {
            model: {
              ...samples,
              isRequesting: Option.isNone(maybeVoice) ? false : samples.isRequesting,
              retryingVoices: Option.match(maybeVoice, {
                onNone: () => samples.retryingVoices,
                onSome: (voice) => samples.retryingVoices.filter((item) => item !== voice),
              }),
              maybeError: Option.some(failure.message),
            },
          }
        : { model: samples },
    ClickedSelectVoice: ({ voice }) => {
      if (isBusy) return { model: samples }
      if (Option.contains(samples.maybeSelectedVoice, voice) && Option.isNone(samples.maybeError)) {
        return { model: samples }
      }
      return {
        model: {
          ...samples,
          maybeSelectedVoice: Option.some(voice),
          hasSelectedVoice: true,
          maybeError: Option.none(),
        },
        commands: [ChangeReviewVoice({ connection, episodeId, voice, speed: validSpeed })],
      }
    },
    SucceededChangeVoice: ({ episodeId: targetId, voice, speed: savedSpeed }) =>
      targetId === episodeId
        ? { model: samples, outMessage: { changedVoice: { episodeId: targetId, voice, speed: savedSpeed } } }
        : { model: samples },
    FailedChangeVoice: ({ episodeId: targetId, voice, failure }) =>
      targetId === episodeId && Option.contains(samples.maybeSelectedVoice, voice)
        ? { model: { ...samples, maybeError: Option.some(failure.message) } }
        : { model: samples },
    ClickedPlaySample: ({ voice }) => {
      const sample = samples.items.find((item) => item.voice === voice)
      if (!sample || sample.state._tag !== "Ready") return { model: samples }
      return {
        model: { ...samples, maybePlayingVoice: Option.some(voice), maybeError: Option.none() },
        commands: [PlaySampleAudio({ voice, src: connection.origin + sample.state.url })],
        outMessage: { pausePlayback: true },
      }
    },
    ClickedPauseSample: () =>
      Option.isSome(samples.maybePlayingVoice)
        ? { model: { ...samples, maybePlayingVoice: Option.none() }, commands: [StopSampleAudio()] }
        : { model: samples },
    CompletedPlaySample: () => ({ model: samples }),
    CompletedStopSample: () => ({ model: samples }),
    EndedSampleAudio: ({ voice }) => ({
      model: Option.contains(samples.maybePlayingVoice, voice)
        ? { ...samples, maybePlayingVoice: Option.none() }
        : samples,
    }),
    PausedSampleAudio: ({ voice }) => ({
      model: Option.contains(samples.maybePlayingVoice, voice)
        ? { ...samples, maybePlayingVoice: Option.none() }
        : samples,
    }),
    FailedPlaySample: ({ voice, message: errorMessage }) => ({
      model: Option.contains(samples.maybePlayingVoice, voice)
        ? { ...samples, maybePlayingVoice: Option.none(), maybeError: Option.some(errorMessage) }
        : samples,
    }),
  })
}

export const stopSampleCommandIfPlaying = (samples: Samples): ReadonlyArray<Command.Command<SamplesMessage>> =>
  Option.isSome(samples.maybePlayingVoice) ? [StopSampleAudio()] : []

export const stopSampleIfMainPlaying = (
  samples: Samples,
  isMainPlaying: boolean,
): { readonly samples: Samples; readonly commands: ReadonlyArray<Command.Command<SamplesMessage>> } =>
  isMainPlaying && Option.isSome(samples.maybePlayingVoice)
    ? { samples: { ...samples, maybePlayingVoice: Option.none() }, commands: [StopSampleAudio()] }
    : { samples, commands: [] }

// SUBSCRIPTIONS

export const makeSampleSubscriptions = <ParentModel, ParentMessage>(
  readEditing: (model: ParentModel) => Option.Option<{ readonly episodeId: EpisodeId; readonly samples: Samples }>,
  toParent: (message: SamplesMessage) => ParentMessage,
) =>
  Subscription.make<ParentModel, ParentMessage>()((entry) => ({
    /** Fetches any already-generated or in-progress samples when entering Review. */
    initialSamplesFetch: entry(
      { maybeEpisodeId: Schema.Option(EpisodeId) },
      {
        modelToDependencies: (model) => ({
          maybeEpisodeId: Option.flatMap(readEditing(model), ({ episodeId, samples }) =>
            samples.hasLoaded ? Option.none() : Option.some(episodeId),
          ),
        }),
        dependenciesToStream: ({ maybeEpisodeId }) =>
          Option.isSome(maybeEpisodeId)
            ? Stream.make(toParent(SamplesMessage.RequestedInitialFetch()))
            : Stream.empty,
      },
    ),

    /** Polls `GET /api/episodes/:id/samples` while any Sample is `Requested` in Review. */
    pollSamples: entry(
      { isPolling: Schema.Boolean },
      {
        modelToDependencies: (model) => ({
          isPolling: Option.exists(readEditing(model), ({ samples }) => hasRequestedSamples(samples)),
        }),
        dependenciesToStream: ({ isPolling }) =>
          Stream.when(
            Stream.tick(Duration.millis(SAMPLE_POLL_MS)).pipe(
              Stream.drop(1),
              Stream.map(() => toParent(SamplesMessage.TickedPoll())),
            ),
            Effect.sync(() => isPolling),
          ),
      },
    ),

    /** Tracks end/pause/error of the detached sample audio element and cleans up on leave. */
    sampleAudioEvents: entry(
      { isPlaying: Schema.Boolean },
      {
        modelToDependencies: (model) => ({
          isPlaying: Option.exists(readEditing(model), ({ samples }) => Option.isSome(samples.maybePlayingVoice)),
        }),
        dependenciesToStream: ({ isPlaying }) =>
          !isPlaying
            ? Stream.empty
            : Stream.callback<ParentMessage>((queue) =>
                Effect.acquireRelease(
                  Effect.sync(() => {
                    const audio = getSampleAudio()
                    const onEnded = () => {
                      if (activeSampleVoice === null) return
                      const voice = activeSampleVoice
                      activeSampleVoice = null
                      Queue.offerUnsafe(queue, toParent(SamplesMessage.EndedSampleAudio({ voice })))
                    }
                    const onPause = () => {
                      if (isStoppingProgrammatically || audio.ended || activeSampleVoice === null) return
                      const voice = activeSampleVoice
                      activeSampleVoice = null
                      Queue.offerUnsafe(queue, toParent(SamplesMessage.PausedSampleAudio({ voice })))
                    }
                    const onError = () => {
                      if (isStoppingProgrammatically || activeSampleVoice === null) return
                      const voice = activeSampleVoice
                      activeSampleVoice = null
                      Queue.offerUnsafe(
                        queue,
                        toParent(SamplesMessage.FailedPlaySample({ voice, message: "Could not play sample" })),
                      )
                    }
                    audio.addEventListener("ended", onEnded)
                    audio.addEventListener("pause", onPause)
                    audio.addEventListener("error", onError)
                    return () => {
                      audio.removeEventListener("ended", onEnded)
                      audio.removeEventListener("pause", onPause)
                      audio.removeEventListener("error", onError)
                      stopSampleElement()
                    }
                  }),
                  (cleanup) => Effect.sync(cleanup),
                ).pipe(Effect.flatMap(() => Effect.never)),
              ),
      },
    ),
  }))

// VIEW

const sampleAction = <ParentMessage>(
  option: ReviewVoiceOption,
  samples: Samples,
  isBusy: boolean,
  toParent: (message: SamplesMessage) => ParentMessage,
  h: HtmlBuilder<ParentMessage>,
): Html =>
  Option.match(option.maybeSample, {
    onNone: () => h.empty,
    onSome: (sample) => {
      switch (sample.state._tag) {
        case "Requested":
          return h.span(
            [
              h.Role("status"),
              h.AriaLabel(`Generating ${option.label} sample`),
              h.Class("inline-flex shrink-0 items-center gap-1.5 text-[13px] text-muted-foreground"),
            ],
            [Icon.loaderCircle("size-3.5 animate-spin"), "Generating…"],
          )
        case "Ready": {
          const isPlaying = Option.contains(samples.maybePlayingVoice, option.id)
          return h.button(
            [
              h.Type("button"),
              h.AriaLabel(isPlaying ? `Pause ${option.label} sample` : `Play ${option.label} sample`),
              h.AriaPressed(isPlaying ? "true" : "false"),
              h.Disabled(isBusy),
              h.OnClick(
                toParent(
                  isPlaying ? SamplesMessage.ClickedPauseSample() : SamplesMessage.ClickedPlaySample({ voice: option.id }),
                ),
              ),
              h.Class(buttonClass({ variant: isPlaying ? "primary" : "outline", size: "sm" }, "shrink-0")),
            ],
            [isPlaying ? Icon.pause("size-3.5") : Icon.play("size-3.5 fill-current"), isPlaying ? "Pause" : "Play"],
          )
        }
        case "Failed": {
          const isRetrying = samples.retryingVoices.includes(option.id)
          return h.button(
            [
              h.Type("button"),
              h.AriaLabel(`Retry ${option.label} sample`),
              h.Disabled(isBusy || isRetrying),
              h.OnClick(toParent(SamplesMessage.ClickedRetrySample({ voice: option.id }))),
              h.Class(buttonClass({ variant: "outline", size: "sm" }, "shrink-0")),
            ],
            [isRetrying ? Icon.loaderCircle("size-3.5 animate-spin") : Icon.rotateCw("size-3.5"), isRetrying ? "Retrying…" : "Retry"],
          )
        }
      }
    },
  })

const voiceRow = <ParentMessage>(
  option: ReviewVoiceOption,
  samples: Samples,
  isBusy: boolean,
  toParent: (message: SamplesMessage) => ParentMessage,
  h: HtmlBuilder<ParentMessage>,
): Html => {
  const isSelected = Option.contains(samples.maybeSelectedVoice, option.id)
  const failedReason = Option.match(option.maybeSample, {
    onNone: () => null,
    onSome: (sample) => (sample.state._tag === "Failed" ? sample.state.reason : null),
  })
  const genderLabel = option.gender === "female" ? "Female" : option.gender === "male" ? "Male" : null

  return h.keyed("li")(
    option.id,
    [
      h.Class(
        cx(
          "flex min-h-12 items-center justify-between gap-3 px-3 py-2 transition-colors duration-150",
          isSelected && "bg-accent/60",
        ),
      ),
    ],
    [
      h.button(
        [
          h.Type("button"),
          h.Role("radio"),
          h.AriaChecked(isSelected),
          h.AriaLabel(option.label),
          h.Disabled(isBusy),
          h.OnClick(toParent(SamplesMessage.ClickedSelectVoice({ voice: option.id }))),
          h.Class(
            "flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-lg py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40",
          ),
        ],
        [
          h.span(
            [
              h.AriaHidden(true),
              h.Class(
                cx(
                  "grid size-4.5 shrink-0 place-items-center rounded-full border transition-colors duration-150",
                  isSelected ? "border-foreground bg-foreground" : "border-input bg-transparent",
                ),
              ),
            ],
            [
              ...(isSelected ? [h.span([h.Class("block size-1.5 rounded-full bg-background")], [])] : []),
            ],
          ),
          h.span(
            [h.Class("min-w-0 flex-1")],
            [
              h.span([h.Class("block truncate text-[15px] leading-snug text-foreground")], [option.label]),
              ...(failedReason
                ? [
                    h.span(
                      [h.Title(failedReason), h.Class("block truncate text-[12px] text-destructive")],
                      [failedReason],
                    ),
                  ]
                : genderLabel
                  ? [h.span([h.Class("block truncate text-[12px] text-muted-foreground")], [genderLabel])]
                  : []),
            ],
          ),
        ],
      ),
      sampleAction(option, samples, isBusy, toParent, h),
    ],
  )
}

export const voiceSamplesSection = <ParentMessage>(
  options: {
    readonly voices: ReadonlyArray<Voice>
    readonly language: string
    readonly samples: Samples
    readonly isBusy: boolean
    readonly toParent: (message: SamplesMessage) => ParentMessage
  },
  h: HtmlBuilder<ParentMessage>,
): Html => {
  const { voices, language, samples, isBusy, toParent } = options
  const list = reviewVoices(voices, language, samples.items)
  if (list.length === 0) return h.empty

  const hasUnsampled = list.some((voice) => Option.isNone(voice.maybeSample))
  const isGenerating = hasRequestedSamples(samples)

  return h.div(
    [h.Class("flex flex-col gap-2")],
    [
      h.div(
        [h.Class("flex items-center justify-between gap-2")],
        [
          h.div(
            [h.Class("flex items-baseline gap-2")],
            [
              h.h2([h.Class("text-sm font-medium text-foreground")], ["Voice"]),
              h.span([h.Class("text-[13px] text-muted-foreground")], [languageName(language)]),
            ],
          ),
          ...(hasUnsampled
            ? [
                h.button(
                  [
                    h.Type("button"),
                    h.Disabled(isBusy || samples.isRequesting),
                    h.OnClick(toParent(SamplesMessage.ClickedHearVoices())),
                    h.Class(buttonClass({ variant: "outline", size: "sm" })),
                  ],
                  [
                    samples.isRequesting ? Icon.loaderCircle("size-3.5 animate-spin") : Icon.audioLines("size-3.5"),
                    samples.isRequesting ? "Requesting…" : "Hear voices",
                  ],
                ),
              ]
            : isGenerating
              ? [
                  h.span(
                    [h.Class("inline-flex items-center gap-1.5 text-[13px] text-muted-foreground")],
                    [Icon.loaderCircle("size-3.5 animate-spin"), "Generating samples…"],
                  ),
                ]
              : []),
        ],
      ),
      ...Option.match(samples.maybeError, {
        onNone: () => [],
        onSome: (error) => [h.p([h.Role("alert"), h.Class("text-[13px] text-destructive")], [error])],
      }),
      h.ul(
        [
          h.Role("radiogroup"),
          h.AriaLabel("Voice"),
          h.Class(
            "flex max-h-72 flex-col divide-y divide-border overflow-y-auto rounded-2xl border border-border bg-surface",
          ),
        ],
        list.map((voice) => voiceRow(voice, samples, isBusy, toParent, h)),
      ),
    ],
  )
}
