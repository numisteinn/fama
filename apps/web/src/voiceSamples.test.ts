import type { Episode, EpisodeId, Voice, VoiceRef } from "@fama/contracts"
import { Component } from "@effect/ui"
import { HtmlLocator, HtmlPlay } from "@effect/ui/html/testing"
import { Locator, Story, TestHost } from "@effect/ui/testing"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option, Redacted } from "effect"
import { TestClock } from "effect/testing"
import { AppComponent } from "~/App"
import { apiToken } from "~/core/api"
import { PauseAudio, PlayAudio } from "~/core/audio"
import { ChangeReviewVoice, FetchEpisodes, FetchVoices, PushProgress, SaveProgress, StoreConnection } from "~/command"
import { baseModel, connection, defaultFlags, harbourDays, progressAt, withEpisodes, withPlayback } from "~/fixture"
import { AppMessage } from "~/message"
import { Screen } from "~/model"
import { Playback } from "~/playback/model"
import { type RedactedSample, SamplesQuery } from "~/core/queries"
import { languageOf } from "~/core/voices"
import {
  PlaySampleAudio,
  RequestSamples,
  SampleAudioPlayer,
  StopSampleAudio,
  VoiceSamplesEvents,
  VoiceSamplesMessage,
  VoiceSamplesNoDeps,
  reviewVoices,
} from "~/review/VoiceSamples"
import { required } from "../../../test/required.ts"

const steinn = "piper:is_IS-steinn-medium" as VoiceRef
const salka = "piper:is_IS-salka-medium" as VoiceRef
const ugla = "piper:is_IS-ugla-medium" as VoiceRef
const bui = "piper:is_IS-bui-medium" as VoiceRef
const heart = "kokoro:af_heart" as VoiceRef

const voices: ReadonlyArray<Voice> = [
  { id: steinn, engine: "piper", name: "Steinn", language: "is", gender: "male" },
  { id: salka, engine: "piper", name: "Salka", language: "is", gender: "female" },
  { id: ugla, engine: "piper", name: "Ugla", language: "is", gender: "female" },
  { id: bui, engine: "piper", name: "Búi", language: "is", gender: "male" },
  { id: heart, engine: "kokoro", name: "Heart (US)", language: "en", gender: "female" },
]

const greinEpisode: Episode = {
  ...harbourDays,
  id: "grein-1" as EpisodeId,
  title: "Höfnin hljóða",
  language: "is",
  voice: steinn,
  speed: 1,
  durationMs: null,
  chapters: [],
  bookUrl: null,
  job: { _tag: "Review" },
}

const readySample = (voice: VoiceRef): RedactedSample => ({
  voice,
  state: {
    _tag: "Ready",
    url: Redacted.make(`/media/secret-feed-token/episodes/grein-1/samples/${encodeURIComponent(voice)}.m4a`),
  },
})

const requestedSample = (voice: VoiceRef): RedactedSample => ({
  voice,
  state: { _tag: "Requested" },
})

const failedSample = (voice: VoiceRef, reason: string): RedactedSample => ({
  voice,
  state: { _tag: "Failed", reason },
})

const sampleProps = (
  overrides?: Partial<{
    readonly isMainPlaying: boolean
    readonly initialVoice: VoiceRef | null
    readonly isSavingVoice: boolean
    readonly maybeVoiceError: Option.Option<string>
  }>,
) => ({
  episodeId: greinEpisode.id,
  origin: "",
  connectionGeneration: 0,
  language: "is",
  speed: 1,
  initialVoice: overrides && "initialVoice" in overrides ? required(overrides.initialVoice) : steinn,
  voices,
  isBusy: false,
  isSavingVoice: overrides?.isSavingVoice ?? false,
  maybeVoiceError: overrides?.maybeVoiceError ?? Option.none(),
  isMainPlaying: overrides?.isMainPlaying ?? false,
})

const makeFakeSampleAudio = () => ({
  element: {
    src: "",
    currentTime: 0,
    defaultPlaybackRate: 1,
    playbackRate: 1,
    ended: false,
    play: () => Promise.resolve(),
    pause: () => {},
    removeAttribute: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as HTMLAudioElement,
  activeVoice: null as VoiceRef | null,
})

describe("voice filtering and language matching", () => {
  it("matches voices by base language tag, sorts by name, and includes extra API sample voices", () => {
    expect(languageOf("is_IS")).toBe("is")
    expect(languageOf("en-US")).toBe("en")

    const matched = reviewVoices(voices, "is-IS", [])
    expect(matched.map((voice) => voice.name)).toEqual(["Búi", "Salka", "Steinn", "Ugla"])

    const unknownVoice = "piper:is_IS-extra-medium" as VoiceRef
    const withExtra = reviewVoices(voices, "is", [readySample(unknownVoice)])
    expect(withExtra.map((voice) => voice.id)).toContain(unknownVoice)
  })
})

describe("voice samples lifecycle", () => {
  it.effect("requests samples, plays/switches/pauses, retries failed voice, and queues rapid voice changes", () =>
    Effect.gen(function* () {
      const s = yield* Story.make(VoiceSamplesNoDeps, sampleProps())
      s.loaded("samples", { samples: [] })

      // Request all Icelandic samples.
      s.send(VoiceSamplesMessage.ClickedHearVoices()).expectExact(RequestSamples)
      expect(required(s.pending[0]).command.args).toEqual({
        episodeId: greinEpisode.id,
        origin: "",
        generation: 0,
        voice: null,
      })
      s.resolve(RequestSamples, {
          samples: [readySample(bui), readySample(salka), readySample(steinn), failedSample(ugla, "Model missing")],
        })
        .loaded("samples", {
          samples: [readySample(bui), readySample(salka), readySample(steinn), failedSample(ugla, "Model missing")],
        })

      // Play Salka, then switch directly to Búi (`mode: "switch"` interrupts Salka), then pause.
      expect(JSON.stringify(readySample(salka))).not.toContain("secret-feed-token")
      s.send(VoiceSamplesMessage.ClickedPlaySample({ voice: salka }))
        .emitted(VoiceSamplesEvents.RequestedPauseMainPlayback())
        .expectExact(
          PlaySampleAudio.make({
            voice: salka,
            src: Redacted.make(`/media/secret-feed-token/episodes/grein-1/samples/${encodeURIComponent(salka)}.m4a`),
          }),
        )
      expect(s.model.maybePlayingVoice).toEqual(Option.some(salka))
      expect(s.subscriptions).toContain("sample-audio-events")

      s.send(VoiceSamplesMessage.ClickedPlaySample({ voice: bui }))
        .emitted(VoiceSamplesEvents.RequestedPauseMainPlayback())
      expect(s.interrupted.map((command) => command.name)).toContain("review/PlaySampleAudio")
      expect(s.model.maybePlayingVoice).toEqual(Option.some(bui))
      s.resolve(PlaySampleAudio, Component.noop)

      s.send(VoiceSamplesMessage.ClickedPauseSample())
        .expectExact(StopSampleAudio.make({}))
        .resolve(StopSampleAudio, Component.noop)
      expect(s.model.maybePlayingVoice).toEqual(Option.none())
      expect(s.subscriptions).not.toContain("sample-audio-events")

      // Retry failed Ugla individually.
      s.send(VoiceSamplesMessage.ClickedRetrySample({ voice: ugla })).expectExact(RequestSamples)
      expect(required(s.pending[0]).command.args).toEqual({
        episodeId: greinEpisode.id,
        origin: "",
        generation: 0,
        voice: ugla,
      })
      s.resolve(RequestSamples, {
          samples: [readySample(bui), readySample(salka), readySample(steinn), requestedSample(ugla)],
        })

      // Rapid voice clicks emit RequestedChangeVoice to App, which keeps one write in flight per episode and survives Back.
      s.send(VoiceSamplesMessage.PickedVoice({ voice: salka }))
        .emitted(
          VoiceSamplesEvents.SelectedVoice({ voice: salka }),
          VoiceSamplesEvents.RequestedChangeVoice({ episodeId: greinEpisode.id, voice: salka, speed: 1 }),
        )
        .send(VoiceSamplesMessage.PickedVoice({ voice: bui }))
        .emitted(
          VoiceSamplesEvents.SelectedVoice({ voice: bui }),
          VoiceSamplesEvents.RequestedChangeVoice({ episodeId: greinEpisode.id, voice: bui, speed: 1 }),
        )

      // Rapid A -> B -> A clicks coalesce the pending follow-up write, survive Back, and preserve failures for retry.
      const app = yield* Story.make(AppComponent, defaultFlags())
      app
        .given({
          ...withEpisodes(baseModel(), [greinEpisode]),
          screen: Screen.Review({ episodeId: greinEpisode.id, openId: 1 }),
        })
        .send(AppMessage.RequestedChangeReviewVoice({ episodeId: greinEpisode.id, voice: salka, speed: 1 }))
        .expectExact(
          ChangeReviewVoice.make({ connection, episodeId: greinEpisode.id, request: 1, voice: salka, speed: 1 }),
        )
        .keepPending(ChangeReviewVoice)
        .send(AppMessage.RequestedChangeReviewVoice({ episodeId: greinEpisode.id, voice: bui, speed: 1 }))
        .send(AppMessage.RequestedChangeReviewVoice({ episodeId: greinEpisode.id, voice: salka, speed: 1 }))
      expect(app.pending).toHaveLength(1)

      // Clicking Back does not cancel the in-flight or queued voice writes at App scope.
      app.send(AppMessage.ClosedSubScreen())
      expect(app.model.screen).toEqual(Screen.Library())

      // First Salka (req 1) succeeds and dispatches the coalesced follow-up Salka (req 2) with the current token.
      app
        .resolve(
          ChangeReviewVoice,
          AppMessage.SucceededChangeReviewVoice({
            episodeId: greinEpisode.id,
            origin: connection.origin,
            request: 1,
            voice: salka,
            speed: 1,
          }),
        )
        .expectExact(
          ChangeReviewVoice.make({ connection, episodeId: greinEpisode.id, request: 2, voice: salka, speed: 1 }),
        )
      expect(app.model.reviewVoices[greinEpisode.id]?.request).toBe(2)

      // Follow-up Salka (req 2) fails after Back: failure stays tracked for retry when Review reopens.
      app.resolve(
        ChangeReviewVoice,
        AppMessage.FailedChangeReviewVoice({
          episodeId: greinEpisode.id,
          request: 2,
          voice: salka,
          failure: { status: 500, message: "Voice write failed" },
        }),
      )
      expect(app.model.reviewVoices[greinEpisode.id]).toEqual({
        request: 2,
        voice: salka,
        isSaving: false,
        maybeQueued: Option.none(),
        maybeError: Option.some("Voice write failed"),
      })

      // Rotating the Client token while a first voice save is running dispatches the queued save with the new token.
      const rotatedConnection = { origin: connection.origin, token: apiToken("rotated-token") }
      const tokenApp = yield* Story.make(AppComponent, defaultFlags())
      tokenApp
        .given({
          ...withEpisodes(baseModel(), [greinEpisode]),
          screen: Screen.Review({ episodeId: greinEpisode.id, openId: 1 }),
        })
        .send(AppMessage.RequestedChangeReviewVoice({ episodeId: greinEpisode.id, voice: salka, speed: 1 }))
        .expectExact(
          ChangeReviewVoice.make({ connection, episodeId: greinEpisode.id, request: 1, voice: salka, speed: 1 }),
        )
        .keepPending(ChangeReviewVoice)
        .send(AppMessage.RequestedChangeReviewVoice({ episodeId: greinEpisode.id, voice: bui, speed: 1 }))
      expect(tokenApp.pending).toHaveLength(1)
      tokenApp
        .send(AppMessage.SavedSettings({ connection: rotatedConnection }))
        .resolve(StoreConnection, Component.noop)
        .resolve(FetchVoices, AppMessage.SucceededFetchVoices({ generation: 1, voices: [] }))
        .resolve(
          FetchEpisodes,
          AppMessage.SucceededFetchEpisodes({ generation: 1, request: 2, episodes: [greinEpisode] }),
        )
        .resolve(
          ChangeReviewVoice,
          AppMessage.FailedChangeReviewVoice({
            episodeId: greinEpisode.id,
            request: 1,
            voice: salka,
            failure: { status: 401, message: "Unauthorized" },
          }),
        )
        .expectExact(
          ChangeReviewVoice.make({
            connection: rotatedConnection,
            episodeId: greinEpisode.id,
            request: 2,
            voice: bui,
            speed: 1,
          }),
        )
        .resolve(
          ChangeReviewVoice,
          AppMessage.SucceededChangeReviewVoice({
            episodeId: greinEpisode.id,
            origin: rotatedConnection.origin,
            request: 2,
            voice: bui,
            speed: 1,
          }),
        )
      expect(tokenApp.model.reviewVoices[greinEpisode.id]).toBeUndefined()
      expect(required(Option.getOrThrow(tokenApp.model.maybeEpisodes)[0]).voice).toBe(bui)

      // Switching to a different server drops queued writes tied to the old server.
      const otherServer = { origin: "https://other.example", token: apiToken("other-server-token") }
      const serverApp = yield* Story.make(AppComponent, defaultFlags())
      serverApp
        .given({
          ...withEpisodes(baseModel(), [greinEpisode]),
          screen: Screen.Review({ episodeId: greinEpisode.id, openId: 1 }),
        })
        .send(AppMessage.RequestedChangeReviewVoice({ episodeId: greinEpisode.id, voice: salka, speed: 1 }))
        .keepPending(ChangeReviewVoice)
        .send(AppMessage.RequestedChangeReviewVoice({ episodeId: greinEpisode.id, voice: bui, speed: 1 }))
        .send(AppMessage.SavedSettings({ connection: otherServer }))
        .resolve(StoreConnection, Component.noop)
        .resolve(FetchVoices, AppMessage.SucceededFetchVoices({ generation: 1, voices: [] }))
        .resolve(FetchEpisodes, AppMessage.SucceededFetchEpisodes({ generation: 1, request: 2, episodes: [] }))
        .resolve(
          ChangeReviewVoice,
          AppMessage.SucceededChangeReviewVoice({
            episodeId: greinEpisode.id,
            origin: connection.origin,
            request: 1,
            voice: salka,
            speed: 1,
          }),
        )
        .expectNone()
      expect(serverApp.model.reviewVoices).toEqual({})
    }),
  )

  it.effect("polls SamplesQuery every 2 s while Requested and stops polling once all samples settle", () =>
    Effect.gen(function* () {
      let fetchCount = 0
      const responses: Array<ReadonlyArray<RedactedSample>> = [
        [],
        [requestedSample(bui), readySample(salka), readySample(steinn), failedSample(ugla, "Model missing")],
        [readySample(bui), readySample(salka), readySample(steinn), failedSample(ugla, "Model missing")],
      ]
      const TestVoiceSamples = VoiceSamplesNoDeps.pipe(
        Component.provide(
          Layer.mergeAll(
            SamplesQuery.toLayer(() =>
              Effect.sync(() => {
                const samples = required(responses[Math.min(fetchCount, responses.length - 1)])
                fetchCount += 1
                return { samples }
              }),
            ),
            RequestSamples.toLayer(() =>
              Effect.succeed({
                samples: [requestedSample(bui), requestedSample(salka), requestedSample(steinn), requestedSample(ugla)],
              }),
            ),
            PlaySampleAudio.toLayer(() => Effect.succeed(Component.noop)),
            StopSampleAudio.toLayer(() => Effect.succeed(Component.noop)),
            Layer.succeed(SampleAudioPlayer, makeFakeSampleAudio()),
          ),
        ),
      )

      const play = yield* HtmlPlay.make(TestVoiceSamples, sampleProps()).pipe(Effect.provide(TestHost.layer()))
      expect(fetchCount).toBe(1)

      // No Requested samples yet: advancing the clock does not poll.
      yield* TestClock.adjust("5 seconds")
      yield* play.expect(HtmlLocator.role("button", { name: "Hear voices" })).toBeDisabled(false)
      expect(fetchCount).toBe(1)

      // Click Hear voices -> writes Requested samples into cache -> starts 2s poll.
      yield* play.click(HtmlLocator.role("button", { name: "Hear voices" }))
      yield* play.expect(HtmlLocator.role("status", { name: "Generating Búi sample" })).toExist()

      // After 2s: first poll returns Búi still Requested, Salka Ready, Ugla Failed.
      yield* TestClock.adjust("2 seconds")
      yield* play.expect(HtmlLocator.role("button", { name: "Play Salka sample" })).toBeDisabled(false)
      expect(fetchCount).toBe(2)

      // After another 2s: all samples settle -> polling stops.
      yield* TestClock.adjust("2 seconds")
      yield* play.expect(HtmlLocator.role("button", { name: "Play Búi sample" })).toBeDisabled(false)
      expect(fetchCount).toBe(3)

      // Further time passes with no more fetches.
      yield* TestClock.adjust("10 seconds")
      yield* play.expect(HtmlLocator.role("button", { name: "Play Búi sample" })).toBeDisabled(false)
      expect(fetchCount).toBe(3)
    }),
  )

  it.effect("a transient Sample poll failure keeps the last Sample list visible (including Pause) and keeps polling", () =>
    Effect.gen(function* () {
      let fetchCount = 0
      const TestVoiceSamples = VoiceSamplesNoDeps.pipe(
        Component.provide(
          Layer.mergeAll(
            SamplesQuery.toLayer(() => {
              fetchCount += 1
              if (fetchCount === 1) {
                return Effect.succeed({ samples: [requestedSample(bui), readySample(salka)] })
              }
              if (fetchCount === 2) {
                return Effect.fail({ status: 503, message: "Temporary sample error" })
              }
              return Effect.succeed({ samples: [readySample(bui), readySample(salka)] })
            }),
            RequestSamples.toLayer(() => Effect.succeed({ samples: [] })),
            PlaySampleAudio.toLayer(() => Effect.succeed(Component.noop)),
            StopSampleAudio.toLayer(() => Effect.succeed(Component.noop)),
            Layer.succeed(SampleAudioPlayer, makeFakeSampleAudio()),
          ),
        ),
      )

      const play = yield* HtmlPlay.make(TestVoiceSamples, sampleProps()).pipe(Effect.provide(TestHost.layer()))
      expect(fetchCount).toBe(1)
      yield* play.click(HtmlLocator.role("button", { name: "Play Salka sample" }))
      yield* play.expect(HtmlLocator.role("button", { name: "Pause Salka sample" })).toExist()

      // First 2s poll fails transiently: Pause stays visible and polling continues.
      yield* TestClock.adjust("2 seconds")
      expect(fetchCount).toBe(2)
      yield* play.expect(HtmlLocator.role("button", { name: "Pause Salka sample" })).toExist()
      yield* play.expect(HtmlLocator.role("alert")).toHaveText("Temporary sample error")

      // Next 2s poll succeeds: Búi becomes Ready and error clears.
      yield* TestClock.adjust("2 seconds")
      expect(fetchCount).toBe(3)
      yield* play.expect(HtmlLocator.role("button", { name: "Play Búi sample" })).toBeDisabled(false)
      yield* play.expect(HtmlLocator.role("button", { name: "Pause Salka sample" })).toExist()
      yield* play.expect(HtmlLocator.role("alert")).toBeAbsent()
    }),
  )

  it.effect("playing a sample pauses main playback, and resuming main playback stops the sample", () =>
    Effect.gen(function* () {
      const saved = progressAt(1000)
      const withMainPlaying = withPlayback(
        withEpisodes(baseModel(), [greinEpisode, harbourDays]),
        Playback.Loaded({
          episodeId: harbourDays.id,
          chapter: 0,
          offsetMs: 1000,
          url: required(harbourDays.chapters[0]).url,
          isPlaying: true,
          isWaiting: false,
        }),
      )
      const app = yield* Story.make(AppComponent, defaultFlags())
      app
        .given({ ...withMainPlaying, screen: Screen.Review({ episodeId: greinEpisode.id, openId: 1 }) })
        .send(AppMessage.RequestedPauseMainPlayback())
        .resolve(PauseAudio, Component.noop)
        .resolve(SaveProgress, AppMessage.SavedProgress({ episodeId: harbourDays.id, progress: saved }))
        .resolve(PushProgress, AppMessage.SucceededPushProgress({ episodeId: harbourDays.id, sent: saved, stored: saved }))
      expect(app.model.playback._tag === "Loaded" && app.model.playback.isPlaying).toBe(false)

      // Resuming main playback flips `isMainPlaying` to true, so `VoiceSamples` triggers `stop-on-main-play`.
      app.send(AppMessage.ClickedPlayPause()).resolve(PlayAudio, Component.noop)
      expect(app.model.playback._tag === "Loaded" && app.model.playback.isPlaying).toBe(true)

      const samples = yield* Story.make(VoiceSamplesNoDeps, sampleProps({ isMainPlaying: false }))
      samples
        .loaded("samples", { samples: [readySample(salka)] })
        .send(VoiceSamplesMessage.ClickedPlaySample({ voice: salka }))
        .emitted(VoiceSamplesEvents.RequestedPauseMainPlayback())
        .resolve(PlaySampleAudio, Component.noop)
      samples.props((prev) => ({ ...prev, isMainPlaying: true }))
      expect(samples.subscriptions).toContain("stop-on-main-play")
      samples
        .subscription("stop-on-main-play", VoiceSamplesMessage.MainPlaybackStarted())
        .expectExact(StopSampleAudio.make({}))
        .resolve(StopSampleAudio, Component.noop)
      expect(samples.model.maybePlayingVoice).toEqual(Option.none())
    }),
  )

  it.effect("a failed Voice save shows a Retry action that re-sends the selected Voice", () =>
    Effect.gen(function* () {
      const TestVoiceSamples = VoiceSamplesNoDeps.pipe(
        Component.provide(
          Layer.mergeAll(
            SamplesQuery.toLayer(() => Effect.succeed({ samples: [] })),
            RequestSamples.toLayer(() => Effect.succeed({ samples: [] })),
            PlaySampleAudio.toLayer(() => Effect.succeed(Component.noop)),
            StopSampleAudio.toLayer(() => Effect.succeed(Component.noop)),
            Layer.succeed(SampleAudioPlayer, makeFakeSampleAudio()),
          ),
        ),
      )

      const play = yield* HtmlPlay.make(
        TestVoiceSamples,
        sampleProps({
          initialVoice: salka,
          maybeVoiceError: Option.some("Voice write failed"),
        }),
      ).pipe(Effect.provide(TestHost.layer()))

      yield* play.expect(HtmlLocator.role("alert")).toHaveText("Voice write failed")
      yield* play.expect(HtmlLocator.role("button", { name: "Retry saving voice" })).toBeDisabled(false)

      yield* play.click(HtmlLocator.role("button", { name: "Retry saving voice" }))
      expect(play.root.emitted).toEqual([
        VoiceSamplesEvents.RequestedChangeVoice({ episodeId: greinEpisode.id, voice: salka, speed: 1 }),
      ])
    }),
  )

  it.effect("shows matching voices, sample states, play/pause toggle, failure retry, and selection", () =>
    Effect.gen(function* () {
      let currentSamples: ReadonlyArray<RedactedSample> = []
      const TestVoiceSamples = VoiceSamplesNoDeps.pipe(
        Component.provide(
          Layer.mergeAll(
            SamplesQuery.toLayer(() => Effect.sync(() => ({ samples: currentSamples }))),
            RequestSamples.toLayer(({ voice }) =>
              Effect.sync(() => {
                currentSamples =
                  voice === null
                    ? [
                        requestedSample(bui),
                        readySample(salka),
                        readySample(steinn),
                        failedSample(ugla, "Synthesis failed"),
                      ]
                    : [readySample(bui), readySample(salka), readySample(steinn), requestedSample(ugla)]
                return { samples: currentSamples }
              }),
            ),
            PlaySampleAudio.toLayer(() => Effect.succeed(Component.noop)),
            StopSampleAudio.toLayer(() => Effect.succeed(Component.noop)),
            Layer.succeed(SampleAudioPlayer, makeFakeSampleAudio()),
          ),
        ),
      )

      const play = yield* HtmlPlay.make(TestVoiceSamples, sampleProps()).pipe(Effect.provide(TestHost.layer()))
      yield* play.expect(HtmlLocator.role("radiogroup", { name: "Voice" })).toExist()
      yield* play.expect(HtmlLocator.role("radio", { name: "Steinn" })).toHaveAttribute("aria-checked", "true")
      yield* play.expect(HtmlLocator.role("radio", { name: "Salka" })).toHaveAttribute("aria-checked", "false")
      yield* play.expect(HtmlLocator.role("radio", { name: "Heart (US)" })).toBeAbsent()
      yield* play.expect(HtmlLocator.role("button", { name: "Hear voices" })).toBeDisabled(false)

      // Click Hear voices -> Requested / Ready / Failed states appear.
      yield* play.click(HtmlLocator.role("button", { name: "Hear voices" }))
      yield* play.expect(HtmlLocator.role("status", { name: "Generating Búi sample" })).toExist()
      yield* play.expect(HtmlLocator.role("button", { name: "Play Salka sample" })).toBeDisabled(false)
      yield* play.expect(HtmlLocator.role("button", { name: "Play Steinn sample" })).toBeDisabled(false)
      yield* play.expect(Locator.text("Synthesis failed")).toExist()
      yield* play.expect(HtmlLocator.role("button", { name: "Retry Ugla sample" })).toBeDisabled(false)

      // Play Salka sample -> toggles to Pause Salka sample.
      yield* play.click(HtmlLocator.role("button", { name: "Play Salka sample" }))
      yield* play.expect(HtmlLocator.role("button", { name: "Pause Salka sample" })).toExist()

      // Select Salka -> radio checked updates.
      yield* play.click(HtmlLocator.role("radio", { name: "Salka" }))
      yield* play.expect(HtmlLocator.role("radio", { name: "Salka" })).toHaveAttribute("aria-checked", "true")
      yield* play.expect(HtmlLocator.role("radio", { name: "Steinn" })).toHaveAttribute("aria-checked", "false")

      // Retry Ugla -> Generating Ugla sample appears.
      yield* play.click(HtmlLocator.role("button", { name: "Retry Ugla sample" }))
      yield* play.expect(HtmlLocator.role("status", { name: "Generating Ugla sample" })).toExist()
    }),
  )
})
