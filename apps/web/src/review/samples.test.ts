import type { Document, Episode, EpisodeId, Sample, Voice, VoiceRef } from "@fama/contracts"
import { Option } from "effect"
import * as Scene from "foldkit/scene"
import { Command, given, message, model, story } from "foldkit/story"
import { describe, expect, test } from "vitest"
import { PauseAudio, PlayAudio } from "~/audio"
import { FetchVoices, PushProgress, SaveProgress } from "~/command"
import { baseModel, connection, harbourDays, progressAt, withEpisodes, withPlayback } from "~/fixture"
import { Message } from "~/message"
import { Playback } from "~/model"
import { StartReviewNarration } from "~/review/command"
import { ReviewMessage as R } from "~/review/message"
import {
  ChangeReviewVoice,
  FetchSamples,
  PlaySampleAudio,
  RequestSamples,
  SamplesMessage as S,
  StopSampleAudio,
  hasRequestedSamples,
  languageOf,
  reviewVoices,
} from "~/review/samples"
import { subscriptions } from "~/subscription"
import { update } from "~/update"
import { view } from "~/view"

const wrap = (message: R) => Message.GotReviewMessage({ message })
const wrapSample = (message: S) => wrap(R.GotSamplesMessage({ message }))

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

const greinDocument: Document = {
  title: "Höfnin hljóða",
  author: "Fama Fixtures",
  language: "is",
  chapters: [{ title: "Höfnin hljóða", text: "Höfnin vaknar á undan bænum." }],
}

const openedModel = (episode: Episode = greinEpisode, doc: Document = greinDocument) => {
  const start = { ...withEpisodes(baseModel(), [episode, harbourDays]), voices }
  const loading = update(start, wrap(R.ClickedEpisode({ episodeId: episode.id }))).model
  return update(
    loading,
    wrap(R.SucceededFetchDocument({ episodeId: episode.id, request: 1, document: doc })),
  ).model
}

const readySample = (voice: VoiceRef): Sample => ({
  voice,
  state: { _tag: "Ready", url: `/media/t/episodes/grein-1/samples/${encodeURIComponent(voice)}.m4a` },
})

const requestedSample = (voice: VoiceRef): Sample => ({
  voice,
  state: { _tag: "Requested" },
})

const failedSample = (voice: VoiceRef, reason: string): Sample => ({
  voice,
  state: { _tag: "Failed", reason },
})

describe("voice filtering and language matching", () => {
  test("matches voices by base language tag, sorts by name, and includes extra API sample voices", () => {
    expect(languageOf("is_IS")).toBe("is")
    expect(languageOf("en-US")).toBe("en")

    const matched = reviewVoices(voices, "is-IS", [])
    expect(matched.map((voice) => voice.name)).toEqual(["Búi", "Salka", "Steinn", "Ugla"])

    const unknownVoice = "piper:is_IS-extra-medium" as VoiceRef
    const withExtra = reviewVoices(voices, "is", [readySample(unknownVoice)])
    expect(withExtra.map((voice) => voice.id)).toContain(unknownVoice)
  })
})

describe("voice samples lifecycle in Review", () => {
  test("requests samples, polls while Requested, stops polling when Ready, plays/switches/pauses, and retries Failed", () => {
    const start = openedModel()

    story(
      update,
      given(start),
      // Initial subscription fetch loads any existing samples (none yet).
      message(wrapSample(S.RequestedInitialFetch())),
      Command.expectExact(FetchSamples({ connection, episodeId: greinEpisode.id, request: 1 })),
      Command.resolve(FetchSamples, S.SucceededFetchSamples({ episodeId: greinEpisode.id, request: 1, samples: [] })),
      model((next) => {
        expect(next.review.view._tag === "Editing" && next.review.view.samples.hasLoaded).toBe(true)
        expect(subscriptions.pollSamples.modelToDependencies(next)).toEqual({ isPolling: false })
      }),

      // Request samples for all Icelandic voices.
      message(wrapSample(S.ClickedHearVoices())),
      Command.expectExact(
        RequestSamples({ connection, episodeId: greinEpisode.id, request: 2, maybeVoice: Option.none() }),
      ),
      Command.resolve(
        RequestSamples,
        S.SucceededRequestSamples({
          episodeId: greinEpisode.id,
          request: 2,
          maybeVoice: Option.none(),
          samples: [requestedSample(bui), requestedSample(salka), requestedSample(steinn), requestedSample(ugla)],
        }),
      ),
      model((next) => {
        expect(next.review.view._tag === "Editing" && hasRequestedSamples(next.review.view.samples)).toBe(true)
        expect(subscriptions.pollSamples.modelToDependencies(next)).toEqual({ isPolling: true })
      }),

      // Poll while Requested: Salka is Ready, Ugla Failed, others still Requested.
      message(wrapSample(S.TickedPoll())),
      Command.expectExact(FetchSamples({ connection, episodeId: greinEpisode.id, request: 3 })),
      Command.resolve(
        FetchSamples,
        S.SucceededFetchSamples({
          episodeId: greinEpisode.id,
          request: 3,
          samples: [
            requestedSample(bui),
            readySample(salka),
            readySample(steinn),
            failedSample(ugla, "Model missing"),
          ],
        }),
      ),
      model((next) => expect(subscriptions.pollSamples.modelToDependencies(next)).toEqual({ isPolling: true })),

      // Next poll: all samples settled (Ready or Failed), polling stops.
      message(wrapSample(S.TickedPoll())),
      Command.expectExact(FetchSamples({ connection, episodeId: greinEpisode.id, request: 4 })),
      Command.resolve(
        FetchSamples,
        S.SucceededFetchSamples({
          episodeId: greinEpisode.id,
          request: 4,
          samples: [
            readySample(bui),
            readySample(salka),
            readySample(steinn),
            failedSample(ugla, "Model missing"),
          ],
        }),
      ),
      model((next) => expect(subscriptions.pollSamples.modelToDependencies(next)).toEqual({ isPolling: false })),

      // Play Salka sample, then switch directly to Búi, then pause.
      message(wrapSample(S.ClickedPlaySample({ voice: salka }))),
      Command.expectExact(
        PlaySampleAudio({
          voice: salka,
          src: `/media/t/episodes/grein-1/samples/${encodeURIComponent(salka)}.m4a`,
        }),
      ),
      Command.resolve(PlaySampleAudio, S.CompletedPlaySample()),
      model((next) => {
        expect(next.review.view._tag === "Editing" && next.review.view.samples.maybePlayingVoice).toEqual(
          Option.some(salka),
        )
        expect(subscriptions.sampleAudioEvents.modelToDependencies(next)).toEqual({ isPlaying: true })
      }),

      message(wrapSample(S.ClickedPlaySample({ voice: bui }))),
      Command.expectExact(
        PlaySampleAudio({
          voice: bui,
          src: `/media/t/episodes/grein-1/samples/${encodeURIComponent(bui)}.m4a`,
        }),
      ),
      Command.resolve(PlaySampleAudio, S.CompletedPlaySample()),
      model((next) =>
        expect(next.review.view._tag === "Editing" && next.review.view.samples.maybePlayingVoice).toEqual(
          Option.some(bui),
        ),
      ),

      message(wrapSample(S.ClickedPauseSample())),
      Command.expectExact(StopSampleAudio()),
      Command.resolve(StopSampleAudio, S.CompletedStopSample()),
      model((next) => {
        expect(next.review.view._tag === "Editing" && next.review.view.samples.maybePlayingVoice).toEqual(Option.none())
        expect(subscriptions.sampleAudioEvents.modelToDependencies(next)).toEqual({ isPlaying: false })
      }),

      // Retry the failed Ugla sample individually.
      message(wrapSample(S.ClickedRetrySample({ voice: ugla }))),
      Command.expectExact(
        RequestSamples({ connection, episodeId: greinEpisode.id, request: 5, maybeVoice: Option.some(ugla) }),
      ),
      Command.resolve(
        RequestSamples,
        S.SucceededRequestSamples({
          episodeId: greinEpisode.id,
          request: 5,
          maybeVoice: Option.some(ugla),
          samples: [readySample(bui), readySample(salka), readySample(steinn), requestedSample(ugla)],
        }),
      ),
      model((next) => expect(subscriptions.pollSamples.modelToDependencies(next)).toEqual({ isPolling: true })),
    )
  })

  test("playing a sample pauses main episode playback, and resuming main playback or leaving Review stops the sample", () => {
    const withMainPlaying = withPlayback(
      openedModel(),
      Playback.Loaded({ episodeId: harbourDays.id, chapter: 0, offsetMs: 1000, isPlaying: true, isWaiting: false }),
    )
    const loaded = update(
      withMainPlaying,
      wrapSample(S.SucceededFetchSamples({ episodeId: greinEpisode.id, request: 0, samples: [readySample(salka)] })),
    ).model
    const saved = progressAt(1000)

    story(
      update,
      given(loaded),
      // Playing a sample pauses main playback cleanly and saves progress.
      message(wrapSample(S.ClickedPlaySample({ voice: salka }))),
      Command.resolve(PlaySampleAudio, S.CompletedPlaySample()),
      Command.resolve(PauseAudio, Message.CompletedPauseAudio()),
      Command.resolve(SaveProgress, Message.SavedProgress({ episodeId: harbourDays.id, progress: saved })),
      Command.resolve(
        PushProgress,
        Message.SucceededPushProgress({ episodeId: harbourDays.id, sent: saved, stored: saved }),
      ),
      model((next) => {
        expect(next.playback._tag === "Loaded" && next.playback.isPlaying).toBe(false)
        expect(next.review.view._tag === "Editing" && next.review.view.samples.maybePlayingVoice).toEqual(
          Option.some(salka),
        )
      }),

      // Starting main playback stops the playing sample.
      message(Message.ClickedPlayPause()),
      Command.resolve(PlayAudio, Message.CompletedPlayAudio()),
      Command.resolve(StopSampleAudio, S.CompletedStopSample()),
      model((next) => {
        expect(next.playback._tag === "Loaded" && next.playback.isPlaying).toBe(true)
        expect(next.review.view._tag === "Editing" && next.review.view.samples.maybePlayingVoice).toEqual(Option.none())
      }),

      // Play sample again, then click Back: stops sample playback on leave.
      message(wrapSample(S.ClickedPlaySample({ voice: salka }))),
      Command.resolve(PlaySampleAudio, S.CompletedPlaySample()),
      Command.resolve(PauseAudio, Message.CompletedPauseAudio()),
      message(wrap(R.ClickedBack())),
      Command.expectExact(StopSampleAudio()),
      Command.resolve(StopSampleAudio, S.CompletedStopSample()),
      model((next) => expect(next.review.view._tag).toBe("Closed")),
    )
  })

  test("sample end, play error, and leaving Review via reconcile all clean up playing state", () => {
    const loaded = update(
      openedModel(),
      wrapSample(S.SucceededFetchSamples({ episodeId: greinEpisode.id, request: 0, samples: [readySample(salka)] })),
    ).model
    const startedElsewhere: Episode = { ...greinEpisode, job: { _tag: "Queued" } }

    story(
      update,
      given(loaded),
      message(wrapSample(S.ClickedPlaySample({ voice: salka }))),
      Command.resolve(PlaySampleAudio, S.CompletedPlaySample()),
      message(wrapSample(S.EndedSampleAudio({ voice: salka }))),
      model((next) =>
        expect(next.review.view._tag === "Editing" && next.review.view.samples.maybePlayingVoice).toEqual(Option.none()),
      ),

      message(wrapSample(S.ClickedPlaySample({ voice: salka }))),
      Command.resolve(PlaySampleAudio, S.FailedPlaySample({ voice: salka, message: "Could not play sample" })),
      model((next) => {
        expect(next.review.view._tag === "Editing" && next.review.view.samples.maybePlayingVoice).toEqual(Option.none())
        expect(next.review.view._tag === "Editing" && next.review.view.samples.maybeError).toEqual(
          Option.some({ source: "audio", message: "Could not play sample" }),
        )
      }),

      message(wrapSample(S.ClickedPlaySample({ voice: salka }))),
      Command.resolve(PlaySampleAudio, S.CompletedPlaySample()),
      message(Message.SucceededFetchEpisodes({ generation: 0, request: 2, episodes: [startedElsewhere, harbourDays] })),
      Command.expectExact(StopSampleAudio()),
      Command.resolve(StopSampleAudio, S.CompletedStopSample()),
      model((next) => expect(next.review.view._tag).toBe("Closed")),
    )
  })

  test("selecting a voice persists via PUT /voice, updates the library episode, and sends voice on Start", () => {
    const queuedWithSalka: Episode = { ...greinEpisode, voice: salka, job: { _tag: "Queued" } }
    story(
      update,
      given(openedModel()),
      message(wrapSample(S.ClickedSelectVoice({ voice: salka }))),
      Command.expectExact(
        ChangeReviewVoice({ connection, episodeId: greinEpisode.id, voice: salka, speed: 1 }),
      ),
      Command.resolve(
        ChangeReviewVoice,
        S.SucceededChangeVoice({ episodeId: greinEpisode.id, voice: salka, speed: 1 }),
      ),
      model((next) => {
        expect(next.review.view._tag === "Editing" && next.review.view.samples.maybeSelectedVoice).toEqual(
          Option.some(salka),
        )
        const episode = Option.getOrThrow(next.maybeEpisodes).find((item) => item.id === greinEpisode.id)
        expect(episode?.voice).toBe(salka)
      }),
      message(wrap(R.ClickedStart())),
      Command.expectExact(
        StartReviewNarration({
          connection,
          episodeId: greinEpisode.id,
          document: greinDocument,
          voice: salka,
        }),
      ),
      Command.resolve(StartReviewNarration, wrap(R.SucceededStartReview({ episode: queuedWithSalka }))),
      model((next) => {
        expect(next.review.view._tag).toBe("Closed")
        const episode = Option.getOrThrow(next.maybeEpisodes).find((item) => item.id === greinEpisode.id)
        expect(episode?.voice).toBe(salka)
        expect(episode?.job._tag).toBe("Queued")
      }),
    )
  })

  test("defaults cleanly when episode voice is null and fetches voices if none are loaded", () => {
    const noVoiceEpisode: Episode = { ...greinEpisode, voice: null }
    const modelWithoutVoice = { ...openedModel(noVoiceEpisode), voices: [] }
    expect(
      modelWithoutVoice.review.view._tag === "Editing" && modelWithoutVoice.review.view.samples.maybeSelectedVoice,
    ).toEqual(Option.none())

    story(
      update,
      given(modelWithoutVoice),
      message(wrapSample(S.RequestedInitialFetch())),
      Command.expectExact(
        FetchSamples({ connection, episodeId: greinEpisode.id, request: 1 }),
        FetchVoices({ connection }),
      ),
      Command.resolve(FetchSamples, S.SucceededFetchSamples({ episodeId: greinEpisode.id, request: 1, samples: [] })),
      Command.resolve(FetchVoices, Message.SucceededFetchVoices({ voices })),
      model((next) => expect(next.voices).toEqual(voices)),
    )
  })

  test("poll preserves voice and audio errors, drops stale responses, and skips overlapping polls", () => {
    let state = update(
      openedModel(),
      wrapSample(
        S.SucceededFetchSamples({
          episodeId: greinEpisode.id,
          request: 0,
          samples: [requestedSample(bui), failedSample(ugla, "Model missing")],
        }),
      ),
    ).model

    // Trigger a voice save error while polling is active.
    state = update(state, wrapSample(S.ClickedSelectVoice({ voice: salka }))).model
    state = update(
      state,
      wrapSample(
        S.FailedChangeVoice({
          episodeId: greinEpisode.id,
          voice: salka,
          failure: { status: 500, message: "Save failed" },
        }),
      ),
    ).model

    // Poll starts (request 1); a second tick while in-flight sends no overlapping request.
    const poll1 = update(state, wrapSample(S.TickedPoll()))
    expect(poll1.commands).toHaveLength(1)
    const poll2 = update(poll1.model, wrapSample(S.TickedPoll()))
    expect(poll2.commands ?? []).toHaveLength(0)

    // Retry Ugla bumps sequence to 2; the earlier poll response (request 1) arrives late and is dropped.
    const retry = update(poll2.model, wrapSample(S.ClickedRetrySample({ voice: ugla })))
    expect(retry.commands).toHaveLength(1)
    const afterStalePoll = update(
      retry.model,
      wrapSample(
        S.SucceededFetchSamples({
          episodeId: greinEpisode.id,
          request: 1,
          samples: [readySample(bui), failedSample(ugla, "Model missing")],
        }),
      ),
    ).model
    const afterRetry = update(
      afterStalePoll,
      wrapSample(
        S.SucceededRequestSamples({
          episodeId: greinEpisode.id,
          request: 2,
          maybeVoice: Option.some(ugla),
          samples: [readySample(bui), requestedSample(ugla)],
        }),
      ),
    ).model

    expect(afterRetry.review.view._tag === "Editing" && afterRetry.review.view.samples.items).toEqual([
      readySample(bui),
      requestedSample(ugla),
    ])
    expect(afterRetry.review.view._tag === "Editing" && afterRetry.review.view.samples.maybeError).toEqual(
      Option.some({ source: "voice", message: "Save failed" }),
    )
  })

  test("serializes rapid voice clicks and applies a late SucceededChangeVoice even after Back", () => {
    // Click Salka then immediately Búi: only Salka PUT runs first; Búi waits as pending.
    const first = update(openedModel(), wrapSample(S.ClickedSelectVoice({ voice: salka })))
    expect(first.commands).toHaveLength(1)
    const second = update(first.model, wrapSample(S.ClickedSelectVoice({ voice: bui })))
    expect(second.commands ?? []).toHaveLength(0)

    // When Salka finishes, Búi PUT is dispatched next.
    const afterFirst = update(
      second.model,
      wrapSample(S.SucceededChangeVoice({ episodeId: greinEpisode.id, voice: salka, speed: 1 })),
    )
    expect(afterFirst.commands).toHaveLength(1)

    // User clicks Back before Búi finishes; late SucceededChangeVoice still updates the library Episode.
    const afterBack = update(afterFirst.model, wrap(R.ClickedBack())).model
    expect(afterBack.review.view._tag).toBe("Closed")
    const afterLateSave = update(
      afterBack,
      wrapSample(S.SucceededChangeVoice({ episodeId: greinEpisode.id, voice: bui, speed: 1 })),
    ).model
    const episode = Option.getOrThrow(afterLateSave.maybeEpisodes).find((item) => item.id === greinEpisode.id)
    expect(episode?.voice).toBe(bui)
  })
})

describe("voice samples view in Review", () => {
  test("shows matching voices, selected highlight, sample states, play/pause toggle, failure retry, and selection", () => {
    Scene.scene(
      { update, view },
      Scene.given(openedModel()),
      Scene.expect(Scene.role("radiogroup", { name: "Voice" })).toExist(),
      Scene.expect(Scene.role("radio", { name: "Steinn" })).toHaveAttr("aria-checked", "true"),
      Scene.expect(Scene.role("radio", { name: "Salka" })).toHaveAttr("aria-checked", "false"),
      Scene.expect(Scene.role("radio", { name: "Heart (US)" })).toBeAbsent(),
      Scene.expect(Scene.role("button", { name: "Hear voices" })).toBeEnabled(),

      // Click Hear voices -> Requested indicators appear.
      Scene.click(Scene.role("button", { name: "Hear voices" })),
      Scene.Command.resolve(
        RequestSamples,
        S.SucceededRequestSamples({
          episodeId: greinEpisode.id,
          request: 1,
          maybeVoice: Option.none(),
          samples: [
            requestedSample(bui),
            readySample(salka),
            readySample(steinn),
            failedSample(ugla, "Synthesis failed"),
          ],
        }),
      ),
      Scene.expect(Scene.role("status", { name: "Generating Búi sample" })).toExist(),
      Scene.expect(Scene.role("button", { name: "Play Salka sample" })).toBeEnabled(),
      Scene.expect(Scene.role("button", { name: "Play Steinn sample" })).toBeEnabled(),
      Scene.expect(Scene.text("Synthesis failed")).toExist(),
      Scene.expect(Scene.role("button", { name: "Retry Ugla sample" })).toBeEnabled(),

      // Play Salka sample -> toggles to Pause Salka sample.
      Scene.click(Scene.role("button", { name: "Play Salka sample" })),
      Scene.Command.resolve(PlaySampleAudio, S.CompletedPlaySample()),
      Scene.expect(Scene.role("button", { name: "Pause Salka sample" })).toExist(),

      // Select Salka -> radio checked updates.
      Scene.click(Scene.role("radio", { name: "Salka" })),
      Scene.Command.resolve(
        ChangeReviewVoice,
        S.SucceededChangeVoice({ episodeId: greinEpisode.id, voice: salka, speed: 1 }),
      ),
      Scene.expect(Scene.role("radio", { name: "Salka" })).toHaveAttr("aria-checked", "true"),
      Scene.expect(Scene.role("radio", { name: "Steinn" })).toHaveAttr("aria-checked", "false"),

      // Retry Ugla -> requests Ugla sample.
      Scene.click(Scene.role("button", { name: "Retry Ugla sample" })),
      Scene.Command.resolve(
        RequestSamples,
        S.SucceededRequestSamples({
          episodeId: greinEpisode.id,
          request: 2,
          maybeVoice: Option.some(ugla),
          samples: [readySample(bui), readySample(salka), readySample(steinn), requestedSample(ugla)],
        }),
      ),
      Scene.expect(Scene.role("status", { name: "Generating Ugla sample" })).toExist(),
    )
  })
})
