import type { EpisodeId, VoiceRef } from "@fama/contracts"
import { Component } from "@effect/ui"
import { HtmlCommand } from "@effect/ui/html"
import { Story } from "@effect/ui/testing"
import { Effect, Layer, Option, Redacted } from "effect"
import { afterEach, describe, expect, test, vi } from "vitest"
import { AppComponent } from "~/App"
import { apiToken } from "~/core/api"
import {
  AudioPlayer,
  LoadChapter,
  PauseAudio,
  PlayAudio,
  SeekAudio,
  SetAudioRate,
  StopAudio,
  audioCommandsLayer,
} from "~/core/audio"
import {
  CreateEpisodeFromSource,
  DeleteEpisode,
  FetchEpisodes,
  FetchVoices,
  PushProgress,
  ReadStoredProgress,
  SaveProgress,
  StoreProgress,
  StoreSetting,
  UploadEpisode,
  WaitBeforeDisarmDelete,
} from "~/command"
import {
  baseModel,
  connection,
  defaultFlags,
  harbourDays,
  progressAt,
  queuedArticle,
  runningHarbourDays,
  withEpisodes,
  withPlayback,
} from "~/fixture"
import { AppMessage as Message } from "~/message"
import { type AppModel as Model } from "~/model"
import { Playback } from "~/playback/model"
import { storageEventMessage } from "~/subscription"
import { updateApp as update } from "~/update"
import { required } from "../../../test/required.ts"

type AppCursor = Story.Steps<typeof AppComponent>
type Step = (s: AppCursor) => void

const given = (initial: Model): Step => (s) => {
  s.given(initial)
}
const message = (msg: Message): Step => (s) => {
  s.send(msg)
}
const model = (check: (next: Model) => void): Step => (s) => {
  check(s.model)
}
const steps = (...list: ReadonlyArray<Step>): Step => (s) => {
  for (const step of list) step(s)
}
const Command = {
  expectNone: (): Step => (s) => {
    s.expectNone()
  },
  expectExact: (...targets: ReadonlyArray<Story.Target>): Step => (s) => {
    const pending = s.pending.filter((item) => item.status === "running")
    if (pending.length !== targets.length) {
      s.expectExact(...targets)
      return
    }
    const remaining = [...targets]
    const ordered: Array<Story.Target> = []
    const targetName = (t: Story.Target): string =>
      "key" in t ? (t as { readonly key: string }).key : "name" in t ? t.name : ""
    for (const item of pending) {
      const idx = remaining.findIndex((t) => targetName(t) === item.command.name)
      if (idx === -1) {
        s.expectExact(...targets)
        return
      }
      ordered.push(required(remaining.splice(idx, 1)[0]))
    }
    s.expectExact(...ordered)
  },
  resolve: (target: Story.Target, result: unknown): Step => (s) => {
    s.resolve(target as never, result as never)
  },
}

const story = (_update: unknown, ...run: ReadonlyArray<Step>) =>
  Effect.gen(function* () {
    const s = yield* Story.make(AppComponent, defaultFlags())
    for (const step of run) step(s)
  }).pipe(Effect.scoped, Effect.runSync)

const unauthorized = { status: 401, message: "The API token is wrong or missing" }

describe("library", () => {
  test("the first 401 opens Settings, a second 401 in a row does not", () => {
    story(
      update,
      given(baseModel()),
      message(Message.FailedFetchEpisodes({ generation: 0, request: 1, failure: unauthorized })),
      model((next) => expect(next.isSettingsOpen).toBe(true)),
      Command.expectNone(),
    )
    const stillUnauthorized = { ...baseModel(), maybeLibraryFailure: Option.some(unauthorized) }
    story(
      update,
      given(stillUnauthorized),
      message(Message.FailedFetchEpisodes({ generation: 0, request: 1, failure: unauthorized })),
      model((next) => expect(next.isSettingsOpen).toBe(false)),
      Command.expectNone(),
    )
  })

  test("a late library response for a previous connection is dropped: a 401 does not reopen Settings", () => {
    // The connection changed once since the request went out.
    story(
      update,
      given({ ...withEpisodes(baseModel(), [harbourDays]), connectionGeneration: 1 }),
      message(Message.FailedFetchEpisodes({ generation: 0, request: 1, failure: unauthorized })),
      model((next) => {
        expect(next.isSettingsOpen).toBe(false)
        expect(next.maybeLibraryFailure).toEqual(Option.none())
      }),
      Command.expectNone(),
      message(Message.SucceededFetchEpisodes({ generation: 0, request: 1, episodes: [queuedArticle] })),
      model((next) => expect(Option.getOrThrow(next.maybeEpisodes)).toEqual([harbourDays])),
    )
  })

  test("a poll tick refetches, and the result replaces the list", () => {
    story(
      update,
      given(withEpisodes(baseModel(), [queuedArticle])),
      message(Message.TickedPoll()),
      Command.expectExact(FetchEpisodes.make({ connection, generation: 0, request: 2 })),
      Command.resolve(
        FetchEpisodes,
        Message.SucceededFetchEpisodes({ generation: 0, request: 2, episodes: [harbourDays] }),
      ),
      model((next) => expect(Option.getOrThrow(next.maybeEpisodes).map((item) => item.title)).toEqual(["Harbour Days"])),
    )
  })

  test("two clicks delete: the first arms and focuses, the timer disarms", () => {
    story(
      update,
      given(withEpisodes(baseModel(), [harbourDays])),
      message(Message.ClickedArmDelete({ episodeId: harbourDays.id })),
      model((next) => expect(next.armedDeletes).toEqual([harbourDays.id])),
      Command.expectExact(WaitBeforeDisarmDelete, HtmlCommand.Focus),
      Command.resolve(HtmlCommand.Focus, { found: true }),
      Command.resolve(WaitBeforeDisarmDelete, Message.CompletedWaitBeforeDisarmDelete({ episodeId: harbourDays.id })),
      model((next) => expect(next.armedDeletes).toEqual([])),
    )
  })
})

describe("settings", () => {
  /** What the storage Subscription sends when another tab saves a setting. */
  const storedSettings = (fields: Partial<Omit<Extract<Message, { _tag: "ChangedStoredSettings" }>, "_tag">>) =>
    Message.ChangedStoredSettings({ connection, maybeVoice: Option.none(), speed: 1, rate: 1, ...fields })

  test("switching A to B and back to A drops a library response fetched before the switch", () => {
    const tokenB = { origin: "", token: apiToken("token-b") }
    const polledA = update(withEpisodes(baseModel(), [harbourDays]), Message.TickedPoll())
    const pollA = polledA.commands.find((command) => command.name === FetchEpisodes.key)
    if (!pollA || !("args" in pollA)) throw new Error("the poll issued no FetchEpisodes")
    const pollAArgs = pollA.args as { readonly generation: number; readonly request: number }
    story(
      update,
      given(polledA.model),
      message(storedSettings({ connection: tokenB })),
      Command.expectExact(
        FetchEpisodes.make({ connection: tokenB, generation: 1, request: 3 }),
        FetchVoices.make({ connection: tokenB, generation: 1 }),
      ),
      Command.resolve(
        FetchEpisodes,
        Message.SucceededFetchEpisodes({ generation: 1, request: 3, episodes: [harbourDays] }),
      ),
      Command.resolve(
        FetchVoices,
        Message.SucceededFetchVoices({
          generation: 1,
          voices: [{ id: "piper:is_IS-salka-medium" as VoiceRef, engine: "piper", name: "Salka", language: "is", gender: "female", previewUrl: null }],
        }),
      ),
      message(storedSettings({ connection })),
      Command.expectExact(
        FetchEpisodes.make({ connection, generation: 2, request: 4 }),
        FetchVoices.make({ connection, generation: 2 }),
      ),
      Command.resolve(
        FetchEpisodes,
        Message.SucceededFetchEpisodes({ generation: 2, request: 4, episodes: [harbourDays] }),
      ),
      Command.resolve(
        FetchVoices,
        Message.SucceededFetchVoices({
          generation: 2,
          voices: [{ id: "kokoro:af_heart" as VoiceRef, engine: "kokoro", name: "Heart", language: "en", gender: "female", previewUrl: null }],
        }),
      ),
      // Late library and voice responses from generation 0 are dropped.
      message(
        Message.SucceededFetchEpisodes({
          generation: pollAArgs.generation,
          request: pollAArgs.request,
          episodes: [queuedArticle],
        }),
      ),
      message(
        Message.SucceededFetchVoices({
          generation: 0,
          voices: [{ id: "piper:stale" as VoiceRef, engine: "piper", name: "Stale", language: "en", gender: null, previewUrl: null }],
        }),
      ),
      model((next) => {
        expect(Option.getOrThrow(next.maybeEpisodes)).toEqual([harbourDays])
        expect(next.voices.map((voice) => voice.name)).toEqual(["Heart"])
      }),
    )
  })

  test("changing the server clears stale Voices so a failed Voice fetch retries on opening Review", () => {
    const serverB = { origin: "https://other.example", token: apiToken("token-b") }
    const reviewEpisode = {
      ...harbourDays,
      id: "rev-1" as EpisodeId,
      chapters: [],
      durationMs: null,
      bookUrl: null,
      job: { _tag: "Review" as const },
    }
    const oldVoice = {
      id: "piper:old" as VoiceRef,
      engine: "piper",
      name: "Old",
      language: "en",
      gender: null,
      previewUrl: null,
    }
    story(
      update,
      given({ ...withEpisodes(baseModel(), [reviewEpisode]), voices: [oldVoice] }),
      message(storedSettings({ connection: serverB })),
      model((next) => {
        expect(next.voices).toEqual([])
        expect(next.connectionGeneration).toBe(1)
      }),
      Command.expectExact(
        FetchEpisodes.make({ connection: serverB, generation: 1, request: 2 }),
        FetchVoices.make({ connection: serverB, generation: 1 }),
      ),
      Command.resolve(
        FetchEpisodes,
        Message.SucceededFetchEpisodes({ generation: 1, request: 2, episodes: [reviewEpisode] }),
      ),
      Command.resolve(FetchVoices, Message.FailedFetchVoices()),
      // Opening Review sees empty voices and retries FetchVoices for the new server.
      message(Message.ClickedOpenReview({ episodeId: reviewEpisode.id })),
      Command.expectExact(FetchVoices.make({ connection: serverB, generation: 1 })),
      Command.resolve(FetchVoices, Message.SucceededFetchVoices({ generation: 1, voices: [] })),
    )
  })

  test("a token saved in another tab refetches the library and bumps connectionGeneration", () => {
    const otherTab = { origin: "", token: apiToken("token-from-another-tab") }
    story(
      update,
      given({ ...baseModel(), isSettingsOpen: true }),
      message(storedSettings({ connection: otherTab })),
      model((next) => {
        expect(next.connection.origin).toBe("")
        expect(Redacted.value(next.connection.token)).toBe("token-from-another-tab")
        expect(next.connectionGeneration).toBe(1)
      }),
      Command.expectExact(FetchEpisodes, FetchVoices),
      Command.resolve(FetchEpisodes, Message.SucceededFetchEpisodes({ generation: 1, request: 2, episodes: [] })),
      Command.resolve(FetchVoices, Message.SucceededFetchVoices({ generation: 1, voices: [] })),
    )
  })

  test("a Voice, Voice speed and Playback speed saved in another tab reach the add bar and the audio", () => {
    const sarah = "kokoro:af_sarah" as VoiceRef
    story(
      update,
      given({ ...baseModel(), addText: "A short note." }),
      message(storedSettings({ maybeVoice: Option.some(sarah), speed: 1.2, rate: 2 })),
      model((next) => {
        expect(next.maybeVoice).toEqual(Option.some(sarah))
        expect(next.speed).toBe(1.2)
        expect(next.rate).toBe(2)
      }),
      Command.expectExact(SetAudioRate.make({ rate: 2 })),
      Command.resolve(SetAudioRate, Component.noop),
      message(Message.SubmittedAddForm()),
      Command.expectExact(
        CreateEpisodeFromSource.make({
          connection,
          input: { source: { _tag: "Text", title: null, text: "A short note." }, voice: sarah, speed: 1.2, review: false },
        }),
      ),
      Command.resolve(CreateEpisodeFromSource, Message.SucceededCreateEpisode({ episode: queuedArticle })),
      Command.resolve(HtmlCommand.Focus, { found: true }),
    )
  })

  test("the storage Subscription follows the token, server, Voice, Voice speed and Playback speed keys", () => {
    localStorage.setItem("fama.voice", JSON.stringify("kokoro:af_sarah"))
    localStorage.setItem("fama.speed", "1.2")
    localStorage.setItem("fama.rate", "2")
    try {
      for (const key of ["fama.token", "fama.origin", "fama.voice", "fama.speed", "fama.rate", null]) {
        const maybeMessage = storageEventMessage(key)
        expect(Option.isSome(maybeMessage)).toBe(true)
        const changed = Option.getOrThrow(maybeMessage)
        expect(changed._tag === "ChangedStoredSettings" && [Option.getOrNull(changed.maybeVoice), changed.speed, changed.rate]).toEqual([
          "kokoro:af_sarah",
          1.2,
          2,
        ])
      }
      expect(storageEventMessage("fama.position.harbour-days")).toEqual(Option.none())
    } finally {
      localStorage.clear()
    }
  })

  test("a storage event with the same settings does nothing", () => {
    story(
      update,
      given(baseModel()),
      message(storedSettings({ connection: { origin: "", token: apiToken("dev-api-token") } })),
      Command.expectNone(),
    )
  })
})

describe("add bar", () => {
  test("text that is not a link becomes a Text source; success clears the box and focuses it", () => {
    story(
      update,
      given(baseModel()),
      message(Message.UpdatedAddText({ value: "  A short note.  " })),
      message(Message.PressedEnterInAddText()),
      model((next) => expect(next.isAdding).toBe(true)),
      Command.expectExact(CreateEpisodeFromSource),
      Command.resolve(CreateEpisodeFromSource, Message.SucceededCreateEpisode({ episode: queuedArticle })),
      model((next) => {
        expect(next.addText).toBe("")
        expect(next.isAdding).toBe(false)
        expect(Option.getOrThrow(next.maybeEpisodes)).toEqual([queuedArticle])
      }),
      Command.expectExact(HtmlCommand.Focus),
      Command.resolve(HtmlCommand.Focus, { found: true }),
    )
  })

  test("an empty box does not submit", () => {
    story(update, given(baseModel()), message(Message.SubmittedAddForm()), Command.expectNone())
  })

  test("a batch sends one file at a time with the voice and speed of its Add, and a failed file goes again", () => {
    const epub = new File(["book"], "harbour-days.epub")
    const pdf = new File(["pdf"], "harbour-notes.pdf")
    const png = new File(["png"], "cover.png")
    const notes = { ...queuedArticle, id: "notes" as EpisodeId }
    const serverFailed = { status: 500, message: "The server failed" }
    const fileStates = (next: Model) => next.batch.map((item) => `${item.file.name} ${item.state._tag}`)
    story(
      update,
      given({ ...baseModel(), speed: 1.2 }),
      message(Message.ChangedFileInput({ files: [epub, pdf, png] })),
      model((next) =>
        expect(fileStates(next)).toEqual(["harbour-days.epub Attached", "harbour-notes.pdf Attached", "cover.png Refused"]),
      ),
      message(Message.SubmittedAddForm()),
      Command.expectExact(UploadEpisode.make({ connection, key: 0, file: epub, voice: null, speed: 1.2, review: false })),
      Command.resolve(UploadEpisode, Message.FailedUploadFile({ key: 0, failure: serverFailed })),
      Command.expectExact(UploadEpisode.make({ connection, key: 1, file: pdf, voice: null, speed: 1.2, review: false })),
      Command.resolve(UploadEpisode, Message.SucceededUploadFile({ key: 1, episode: notes })),
      model((next) => {
        expect(fileStates(next)).toEqual(["harbour-days.epub Failed", "cover.png Refused"])
        expect(next.batch[0]?.state).toEqual({
          _tag: "Failed",
          reason: "The server failed",
          voice: null,
          speed: 1.2,
          review: false,
        })
        expect(Option.getOrThrow(next.maybeEpisodes)).toEqual([notes])
      }),
      message(Message.ClickedRetryFile({ key: 0 })),
      Command.expectExact(UploadEpisode.make({ connection, key: 0, file: epub, voice: null, speed: 1.2, review: false })),
      Command.resolve(UploadEpisode, Message.SucceededUploadFile({ key: 0, episode: harbourDays })),
      model((next) => expect(fileStates(next)).toEqual(["cover.png Refused"])),
      message(Message.ClickedRemoveFile({ key: 2 })),
      model((next) => expect(next.batch).toEqual([])),
      Command.expectExact(HtmlCommand.Focus),
      Command.resolve(HtmlCommand.Focus, { found: true }),
    )
  })

  test("a voice or speed picked while a batch runs does not change the files of that batch", () => {
    const voice = "kokoro:af_heart" as VoiceRef
    const epub = new File(["book"], "harbour-days.epub")
    const pdf = new File(["pdf"], "harbour-notes.pdf")
    const sent = { voice, speed: 1.2, review: false }
    story(
      update,
      given({
        ...baseModel(),
        maybeVoice: Option.none(),
        speed: 0.8,
        batchKeys: 2,
        batch: [
          { key: 0, file: epub, state: { _tag: "Uploading", ...sent } },
          { key: 1, file: pdf, state: { _tag: "Pending", ...sent } },
        ],
      }),
      message(Message.SucceededUploadFile({ key: 0, episode: harbourDays })),
      Command.expectExact(UploadEpisode.make({ connection, key: 1, file: pdf, voice, speed: 1.2, review: false })),
      Command.resolve(UploadEpisode, Message.SucceededUploadFile({ key: 1, episode: queuedArticle })),
      model((next) => expect(next.batch).toEqual([])),
      Command.resolve(HtmlCommand.Focus, { found: true }),
    )
  })

  test("a failed add shows the message and keeps the text", () => {
    story(
      update,
      given({ ...baseModel(), addText: "http://localhost:8790/article.html", isAdding: true }),
      message(Message.FailedCreateEpisode({ failure: unauthorized })),
      model((next) => {
        expect(next.maybeAddError).toEqual(Option.some(unauthorized.message))
        expect(next.addText).toBe("http://localhost:8790/article.html")
      }),
    )
  })
})

describe("player", () => {
  const updateKeepingReads = update
  /** Runs the oldest pending ReadStoredProgress against the real localStorage and feeds its Message back. */
  const readStorage: Step = (s) => {
    const item = s.pending.find((entry) => entry.command.name === ReadStoredProgress.name)
    if (!item) throw new Error("update issued no ReadStoredProgress")
    const args = item.command.args as { readonly episodeId: EpisodeId; readonly intent: number }
    const result = Effect.runSync(ReadStoredProgress.make(args).effect)
    s.resolve(ReadStoredProgress, result)
  }
  const storeProgress = (positionMs: number, updatedAt?: string) =>
    localStorage.setItem(`fama.progress.${harbourDays.id}`, JSON.stringify(progressAt(positionMs, updatedAt)))
  /** The save of a listener action at `positionMs`, stamped `T`, then the server's answer. */
  const T = "2026-11-23T12:00:00.000Z"
  const saved = (positionMs: number, episodeId: EpisodeId = harbourDays.id) =>
    steps(
      Command.resolve(SaveProgress, Message.SavedProgress({ episodeId, progress: progressAt(positionMs, T) })),
      Command.resolve(
        PushProgress,
        Message.SucceededPushProgress({ episodeId, sent: progressAt(positionMs, T), stored: progressAt(positionMs, T) }),
      ),
    )

  afterEach(() => {
    localStorage.clear()
  })

  /** A stand-in for the audio element that counts what the audio Commands tell it. */
  const fakeAudio = (refusal?: Error) => ({
    src: "",
    currentTime: 0,
    defaultPlaybackRate: 1,
    playbackRate: 1,
    paused: true,
    playCalls: 0,
    pauseCalls: 0,
    async play() {
      this.playCalls += 1
      if (refusal) throw refusal
      this.paused = false
    },
    pause() {
      this.pauseCalls += 1
      this.paused = true
    },
  })
  /** Runs the audio Commands of one `update` on `audio`, and gives the Messages/Noop they answer with. */
  const runAudio = async (commands: ReturnType<typeof update>["commands"], audio: ReturnType<typeof fakeAudio>) => {
    const names = new Set<string>([LoadChapter.key, PlayAudio.key, PauseAudio.key, SeekAudio.key, StopAudio.key])
    const layer = audioCommandsLayer.pipe(
      Layer.provide(Layer.succeed(AudioPlayer, audio as unknown as HTMLAudioElement)),
    )
    const answers: Array<Message | Component.Noop> = []
    for (const command of commands.filter((item) => names.has(item.name))) {
      const effect = (command as unknown as { readonly effect: Effect.Effect<Message | Component.Noop> }).effect
      answers.push(await Effect.runPromise(effect.pipe(Effect.provide(layer))))
    }
    return answers
  }

  test("play reads the latest saved progress from storage, not the one read at boot", () => {
    // Another tab paused at 30 s after this tab booted with 5 s.
    storeProgress(30_000, "2026-11-23T11:00:00.000Z")
    story(
      updateKeepingReads,
      given(withEpisodes(baseModel({ [harbourDays.id]: progressAt(5_000) }), [harbourDays])),
      message(Message.ClickedPlayEpisode({ episodeId: harbourDays.id })),
      model((next) => expect(next.playback).toEqual(Playback.Stopped())),
      Command.expectExact(ReadStoredProgress),
      readStorage,
      model((next) => {
        expect(next.playback._tag === "Loaded" && next.playback.chapter).toBe(1)
        expect(next.playback._tag === "Loaded" && next.playback.offsetMs).toBe(30_000 - 26_825)
      }),
      Command.resolve(StoreProgress, Component.noop),
      Command.resolve(LoadChapter, Component.noop),
    )
  })

  test("with no progress in storage or on the server, play starts at 0, even after this session saved one", () => {
    // The user cleared site data while Fama was open.
    story(
      updateKeepingReads,
      given(withEpisodes(baseModel({ [harbourDays.id]: progressAt(30_000) }), [harbourDays])),
      message(Message.ClickedPlayEpisode({ episodeId: harbourDays.id })),
      readStorage,
      model((next) => {
        expect(next.playback._tag === "Loaded" && next.playback.chapter).toBe(0)
        expect(next.playback._tag === "Loaded" && next.playback.offsetMs).toBe(0)
        expect(next.localProgress[harbourDays.id]).toBeUndefined()
      }),
      Command.expectExact(LoadChapter),
      Command.resolve(LoadChapter, Component.noop),
    )
  })

  test("play takes the newer of storage and the server", () => {
    storeProgress(10_000, "2026-11-23T09:00:00.000Z")
    const synced = { ...harbourDays, progress: progressAt(20_000, "2026-11-23T10:00:00.000Z") }
    story(
      updateKeepingReads,
      given(withEpisodes(baseModel(), [synced])),
      message(Message.ClickedPlayEpisode({ episodeId: harbourDays.id })),
      readStorage,
      model((next) => expect(next.playback._tag === "Loaded" && next.playback.offsetMs).toBe(20_000)),
      Command.resolve(StoreProgress, Component.noop),
      Command.resolve(LoadChapter, Component.noop),
    )
    storeProgress(25_000, "2026-11-23T11:00:00.000Z")
    story(
      updateKeepingReads,
      given(withEpisodes(baseModel(), [synced])),
      message(Message.ClickedPlayEpisode({ episodeId: harbourDays.id })),
      readStorage,
      model((next) => expect(next.playback._tag === "Loaded" && next.playback.offsetMs).toBe(25_000)),
      Command.resolve(StoreProgress, Component.noop),
      Command.resolve(LoadChapter, Component.noop),
    )
  })

  test("with storage unreadable, play falls back to the progress this tab knows", () => {
    storeProgress(5_000)
    const blocked = vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new DOMException("Storage is blocked", "SecurityError")
    })
    try {
      story(
        updateKeepingReads,
        given(withEpisodes(baseModel({ [harbourDays.id]: progressAt(30_000) }), [harbourDays])),
        message(Message.ClickedPlayEpisode({ episodeId: harbourDays.id })),
        readStorage,
        model((next) => {
          expect(next.playback._tag === "Loaded" && next.playback.chapter).toBe(1)
          expect(next.playback._tag === "Loaded" && next.playback.offsetMs).toBe(30_000 - 26_825)
        }),
        Command.resolve(LoadChapter, Component.noop),
      )
    } finally {
      blocked.mockRestore()
    }
  })

  test("a finished episode starts from the top", () => {
    storeProgress(45_000)
    story(
      updateKeepingReads,
      given(withEpisodes(baseModel(), [harbourDays])),
      message(Message.ClickedPlayEpisode({ episodeId: harbourDays.id })),
      readStorage,
      model((next) => expect(next.playback._tag === "Loaded" && next.playback.chapter).toBe(0)),
      Command.resolve(StoreProgress, Component.noop),
      Command.resolve(LoadChapter, Component.noop),
    )
    // Finished on another device: the server holds the total length.
    story(
      updateKeepingReads,
      given(withEpisodes(baseModel(), [{ ...harbourDays, progress: progressAt(46_525) }])),
      message(Message.ClickedPlayEpisode({ episodeId: harbourDays.id })),
      readStorage,
      model((next) => {
        expect(next.playback._tag === "Loaded" && next.playback.chapter).toBe(0)
        expect(next.playback._tag === "Loaded" && next.playback.offsetMs).toBe(0)
      }),
      Command.resolve(StoreProgress, Component.noop),
      Command.resolve(LoadChapter, Component.noop),
    )
  })

  test("the end of the last chapter stores the total length, not 0, and the next Play starts at 0", () => {
    story(
      updateKeepingReads,
      given(withEpisodes(baseModel(), [harbourDays])),
      message(Message.ClickedPlayEpisode({ episodeId: harbourDays.id })),
      readStorage,
      Command.resolve(LoadChapter, Component.noop),
      message(Message.EndedChapter()),
      Command.resolve(LoadChapter, Component.noop),
      message(Message.UpdatedAudioTime({ offsetMs: 19_700, atMs: 0 })),
      message(Message.EndedChapter()),
      Command.expectExact(SaveProgress.make({ episodeId: harbourDays.id, positionMs: 46_525 })),
      saved(46_525),
      model((next) => {
        expect(next.localProgress[harbourDays.id]?.positionMs).toBe(46_525)
        expect(next.playback._tag === "Loaded" && next.playback.isPlaying).toBe(false)
      }),
      message(Message.ClickedPlayPause()),
      model((next) => {
        expect(next.playback._tag === "Loaded" && next.playback.chapter).toBe(0)
        expect(next.playback._tag === "Loaded" && next.playback.offsetMs).toBe(0)
      }),
      Command.expectExact(LoadChapter),
      Command.resolve(LoadChapter, Component.noop),
    )
  })

  test("dragging the paused slider fully right reaches the very end, so the next Play starts from the top", () => {
    const paused = withPlayback(
      withEpisodes(baseModel(), [harbourDays]),
      Playback.Loaded({ episodeId: harbourDays.id, chapter: 0, url: required(harbourDays.chapters[0]).url, offsetMs: 1_000, isPlaying: false, isWaiting: false }),
    )
    // The range input steps in whole seconds, so its full right for 46,525 ms is the extra stop at 47,000.
    const released = update(paused, Message.CommittedScrub({ value: "47000" }))
    expect(released.model.playback).toEqual(
      Playback.Loaded({
        episodeId: harbourDays.id,
        chapter: 1,
        url: required(harbourDays.chapters[1]).url,
        offsetMs: 19_700,
        isPlaying: false,
        isWaiting: false,
      }),
    )
    expect(released.commands.map((command) => [command.name, "args" in command ? command.args : undefined])).toContainEqual([
      SaveProgress.name,
      { episodeId: harbourDays.id, positionMs: 46_525 },
    ])
  })

  test("the slider's last whole second before the end stays a stop of its own", () => {
    const paused = withPlayback(
      withEpisodes(baseModel(), [harbourDays]),
      Playback.Loaded({ episodeId: harbourDays.id, chapter: 0, url: required(harbourDays.chapters[0]).url, offsetMs: 1_000, isPlaying: false, isWaiting: false }),
    )
    const released = update(paused, Message.CommittedScrub({ value: "46000" })).model
    expect(released.playback).toEqual(
      Playback.Loaded({
        episodeId: harbourDays.id,
        chapter: 1,
        url: required(harbourDays.chapters[1]).url,
        offsetMs: 46_000 - 26_825,
        isPlaying: false,
        isWaiting: false,
      }),
    )
  })

  test("Pause on A while Play on B still reads storage: B's late read does not start B", () => {
    const tideTables = { ...harbourDays, id: "tide-tables" as EpisodeId, title: "Tide Tables" }
    const playingA = withPlayback(
      withEpisodes(baseModel(), [harbourDays, tideTables]),
      Playback.Loaded({ episodeId: harbourDays.id, chapter: 0, url: required(harbourDays.chapters[0]).url, offsetMs: 1_000, isPlaying: true, isWaiting: false }),
    )
    // Play on B. Its storage read is still running when the user clicks Pause on A.
    const clickedB = update(playingA, Message.ClickedPlayEpisode({ episodeId: tideTables.id }))
    const readB = clickedB.commands.find((command) => command.name === ReadStoredProgress.name)
    if (!readB || !("args" in readB)) throw new Error("Play on B issued no ReadStoredProgress")
    const readBArgs = readB.args as { readonly episodeId: EpisodeId; readonly intent: number }
    story(
      update,
      given(clickedB.model),
      message(Message.ClickedPlayEpisode({ episodeId: harbourDays.id })),
      Command.expectExact(PauseAudio, SaveProgress.make({ episodeId: harbourDays.id, positionMs: 1_000 })),
      Command.resolve(PauseAudio, Component.noop),
      saved(1_000),
      message(Message.PausedAudio()),
      // B's read returns now, late.
      message(Effect.runSync(ReadStoredProgress.make(readBArgs).effect)),
      model((next) => {
        expect(next.playback._tag === "Loaded" && next.playback.episodeId).toBe(harbourDays.id)
        expect(next.playback._tag === "Loaded" && next.playback.isPlaying).toBe(false)
      }),
      Command.expectNone(),
    )
  })

  test("the end of a chapter while the job runs waits for the next one, saves nothing, then plays it", () => {
    story(
      updateKeepingReads,
      given(withEpisodes(baseModel(), [runningHarbourDays])),
      message(Message.ClickedPlayEpisode({ episodeId: harbourDays.id })),
      readStorage,
      Command.resolve(LoadChapter, Component.noop),
      message(Message.EndedChapter()),
      model((next) => expect(next.playback._tag === "Loaded" && next.playback.isWaiting).toBe(true)),
      // The end of the audio made so far is not the end of the episode.
      Command.expectNone(),
      message(Message.SucceededFetchEpisodes({ generation: 0, request: 1, episodes: [harbourDays] })),
      model((next) => {
        expect(next.playback._tag === "Loaded" && next.playback.chapter).toBe(1)
        expect(next.playback._tag === "Loaded" && next.playback.isWaiting).toBe(false)
      }),
      Command.expectExact(LoadChapter),
      Command.resolve(LoadChapter, Component.noop),
    )
  })

  test("the last chapter ends while the job still encodes the book: the finish is saved when the job is Ready", () => {
    const encoding = {
      ...harbourDays,
      durationMs: null,
      bookUrl: null,
      job: { ...runningHarbourDays.job, stage: "encoding" as const },
    }
    const playing = withPlayback(
      withEpisodes(baseModel({ [harbourDays.id]: progressAt(42_500) }), [encoding]),
      Playback.Loaded({ episodeId: harbourDays.id, chapter: 1, url: required(harbourDays.chapters[1]).url, offsetMs: 19_700, isPlaying: true, isWaiting: false }),
    )
    story(
      update,
      given(playing),
      message(Message.EndedChapter()),
      model((next) => expect(next.playback._tag === "Loaded" && next.playback.isWaiting).toBe(true)),
      Command.expectNone(),
      // No chapter came after the last one played: the wait was the end of the episode.
      message(
        Message.SucceededFetchEpisodes({
          generation: 0,
          request: 1,
          episodes: [{ ...harbourDays, progress: progressAt(42_500) }],
        }),
      ),
      Command.expectExact(SaveProgress.make({ episodeId: harbourDays.id, positionMs: 46_525 })),
      saved(46_525),
      model((next) => {
        expect(next.localProgress[harbourDays.id]?.positionMs).toBe(46_525)
        expect(next.playback).toEqual(
          Playback.Loaded({
            episodeId: harbourDays.id,
            chapter: 1,
            url: required(harbourDays.chapters[1]).url,
            offsetMs: 19_700,
            isPlaying: false,
            isWaiting: false,
          }),
        )
      }),
      message(Message.ClickedPlayPause()),
      model((next) => expect(next.playback._tag === "Loaded" && next.playback.chapter).toBe(0)),
      Command.expectExact(LoadChapter),
      Command.resolve(LoadChapter, Component.noop),
    )
  })

  test("a skip inside the chapter seeks, then saves and sends the position", () => {
    story(
      updateKeepingReads,
      given(withEpisodes(baseModel(), [harbourDays])),
      message(Message.ClickedPlayEpisode({ episodeId: harbourDays.id })),
      readStorage,
      Command.resolve(LoadChapter, Component.noop),
      message(Message.ClickedSkip({ deltaMs: 15_000 })),
      Command.expectExact(SeekAudio, SaveProgress.make({ episodeId: harbourDays.id, positionMs: 15_000 })),
      Command.resolve(SeekAudio, Component.noop),
      Command.resolve(SaveProgress, Message.SavedProgress({ episodeId: harbourDays.id, progress: progressAt(15_000, T) })),
      Command.expectExact(PushProgress.make({ connection, episodeId: harbourDays.id, progress: progressAt(15_000, T) })),
      Command.resolve(
        PushProgress,
        Message.SucceededPushProgress({ episodeId: harbourDays.id, sent: progressAt(15_000, T), stored: progressAt(15_000, T) }),
      ),
      model((next) => {
        expect(next.localProgress[harbourDays.id]).toEqual(progressAt(15_000, T))
        expect(required(Option.getOrThrow(next.maybeEpisodes)[0]).progress).toEqual(progressAt(15_000, T))
      }),
      Command.expectNone(),
    )
  })

  test("while playing, a save goes out about every 5 s, not on every time update", () => {
    const playing = withPlayback(
      withEpisodes(baseModel(), [harbourDays]),
      Playback.Loaded({ episodeId: harbourDays.id, chapter: 0, url: required(harbourDays.chapters[0]).url, offsetMs: 0, isPlaying: true, isWaiting: false }),
    )
    story(
      update,
      given(playing),
      message(Message.UpdatedAudioTime({ offsetMs: 5_000, atMs: 5_000 })),
      Command.expectExact(SaveProgress.make({ episodeId: harbourDays.id, positionMs: 5_000 })),
      saved(5_000),
      message(Message.UpdatedAudioTime({ offsetMs: 6_000, atMs: 6_000 })),
      message(Message.UpdatedAudioTime({ offsetMs: 9_000, atMs: 9_000 })),
      Command.expectNone(),
      message(Message.UpdatedAudioTime({ offsetMs: 10_100, atMs: 10_100 })),
      Command.expectExact(SaveProgress.make({ episodeId: harbourDays.id, positionMs: 10_100 })),
      saved(10_100),
    )
  })

  test("a pause or a hidden page with nothing new stamps and sends nothing", () => {
    const at12s = Playback.Loaded({
      episodeId: harbourDays.id,
      chapter: 0,
      url: required(harbourDays.chapters[0]).url,
      offsetMs: 12_000,
      isPlaying: false,
      isWaiting: false,
    })
    const paused = withPlayback(withEpisodes(baseModel({ [harbourDays.id]: progressAt(12_000) }), [harbourDays]), at12s)
    story(update, given(paused), message(Message.HidPage()), Command.expectNone())
    story(update, given(paused), message(Message.PausedAudio()), Command.expectNone())
    story(
      update,
      given(withPlayback(paused, Playback.Loaded({ ...at12s, offsetMs: 14_000 }))),
      message(Message.HidPage()),
      Command.expectExact(SaveProgress.make({ episodeId: harbourDays.id, positionMs: 14_000 })),
      saved(14_000),
    )
  })

  test("after the end, Forward 30 seconds stays at the end, so Play starts from the top", () => {
    story(
      updateKeepingReads,
      given(withEpisodes(baseModel(), [harbourDays])),
      message(Message.ClickedPlayEpisode({ episodeId: harbourDays.id })),
      readStorage,
      Command.resolve(LoadChapter, Component.noop),
      message(Message.EndedChapter()),
      Command.resolve(LoadChapter, Component.noop),
      message(Message.UpdatedAudioTime({ offsetMs: 19_700, atMs: 0 })),
      message(Message.EndedChapter()),
      saved(46_525),
      message(Message.ClickedSkip({ deltaMs: 30_000 })),
      // Still at the end, where the audio rests and which the device already holds: nothing to move or to save.
      Command.expectNone(),
      model((next) => {
        expect(next.playback._tag === "Loaded" && next.playback.chapter).toBe(1)
        expect(next.playback._tag === "Loaded" && next.playback.offsetMs).toBe(19_700)
      }),
      message(Message.ClickedPlayPause()),
      model((next) => expect(next.playback._tag === "Loaded" && next.playback.chapter).toBe(0)),
      Command.expectExact(LoadChapter),
      Command.resolve(LoadChapter, Component.noop),
    )
  })

  test("a seek back from the end leaves the end, so Play resumes there", () => {
    story(
      updateKeepingReads,
      given(withEpisodes(baseModel(), [harbourDays])),
      message(Message.ClickedPlayEpisode({ episodeId: harbourDays.id })),
      readStorage,
      Command.resolve(LoadChapter, Component.noop),
      message(Message.EndedChapter()),
      Command.resolve(LoadChapter, Component.noop),
      message(Message.UpdatedAudioTime({ offsetMs: 19_700, atMs: 0 })),
      message(Message.EndedChapter()),
      saved(46_525),
      message(Message.ClickedSkip({ deltaMs: -15_000 })),
      Command.resolve(SeekAudio, Component.noop),
      saved(46_525 - 15_000),
      message(Message.ClickedPlayPause()),
      Command.expectExact(PlayAudio),
      Command.resolve(PlayAudio, Component.noop),
    )
  })

  describe("Play while the library refreshes", () => {
    const { id } = harbourDays
    const old = progressAt(10_000, "2026-11-23T10:00:00.000Z")
    /** The phone played on to 40 s and saved it after this tab last loaded the library. */
    const phone = progressAt(40_000, "2026-11-23T10:01:00.000Z")
    const paused = withPlayback(
      withEpisodes(baseModel({ [id]: old }), [{ ...harbourDays, progress: old }]),
      Playback.Loaded({ episodeId: id, chapter: 0, url: required(harbourDays.chapters[0]).url, offsetMs: 10_000, isPlaying: false, isWaiting: false }),
    )
    /** The tab came back to the foreground: its library request, number 2, is in flight. */
    const refreshing = update(paused, Message.BecameVisible()).model
    const answer = (progress: typeof old, request = 2) =>
      Message.SucceededFetchEpisodes({ generation: 0, request, episodes: [{ ...harbourDays, progress }] })
    const unavailable = { status: 503, message: "Server unavailable" }
    const secondChapter = (offsetMs: number, isAutoplay: boolean) =>
      LoadChapter.make({ src: required(harbourDays.chapters[1]).url, offsetMs, rate: 1, isAutoplay })

    test("Play waits for the answer, starts at the phone's newer position, and saves only from there", () => {
      story(
        update,
        given(refreshing),
        message(Message.ClickedPlayPause()),
        // Nothing plays from the old position, so nothing can be stamped over the phone's entry.
        Command.expectNone(),
        model((next) => {
          expect(next.maybePendingPlay).toEqual(Option.some({ episodeId: id, awaiting: [2] }))
          expect(next.playback._tag === "Loaded" && next.playback.isPlaying).toBe(false)
        }),
        message(Message.HidPage()),
        Command.expectNone(),
        message(answer(phone)),
        model((next) => {
          expect(next.maybePendingPlay).toEqual(Option.none())
          expect(next.localProgress[id]).toEqual(phone)
          expect(next.playback).toEqual(
            Playback.Loaded({
              episodeId: id,
              chapter: 1,
              url: required(harbourDays.chapters[1]).url,
              offsetMs: 40_000 - 26_825,
              isPlaying: true,
              isWaiting: false,
            }),
          )
        }),
        Command.expectExact(StoreProgress.make({ episodeId: id, progress: phone }), secondChapter(40_000 - 26_825, true)),
        Command.resolve(StoreProgress, Component.noop),
        Command.resolve(LoadChapter, Component.noop),
        message(Message.UpdatedAudioTime({ offsetMs: 45_000 - 26_825, atMs: 5_000 })),
        Command.expectExact(SaveProgress.make({ episodeId: id, positionMs: 45_000 })),
        saved(45_000),
      )
    })

    test("a failed refresh plays from what the tab knows", () => {
      story(
        update,
        given(refreshing),
        message(Message.ClickedPlayPause()),
        Command.expectNone(),
        message(
          Message.FailedFetchEpisodes({
            generation: 0,
            request: 2,
            failure: { status: 0, message: "Can't reach the server" },
          }),
        ),
        model((next) => {
          expect(next.maybePendingPlay).toEqual(Option.none())
          expect(Option.isSome(next.maybeLibraryFailure)).toBe(true)
        }),
        Command.expectExact(PlayAudio),
        Command.resolve(PlayAudio, Component.noop),
      )
    })

    test("a Pause key or a seek takes the waiting Play back: the answer only moves the paused player", () => {
      story(
        update,
        given(refreshing),
        message(Message.ClickedPlayPause()),
        message(Message.PressedMediaPause()),
        Command.expectNone(),
        model((next) => expect(next.maybePendingPlay).toEqual(Option.none())),
        message(answer(phone)),
        model((next) => expect(next.playback._tag === "Loaded" && next.playback.isPlaying).toBe(false)),
        Command.expectExact(StoreProgress, secondChapter(40_000 - 26_825, false)),
        Command.resolve(StoreProgress, Component.noop),
        Command.resolve(LoadChapter, Component.noop),
      )
      story(
        update,
        given(refreshing),
        message(Message.ClickedPlayPause()),
        message(Message.ClickedSkip({ deltaMs: 5_000 })),
        model((next) => expect(next.maybePendingPlay).toEqual(Option.none())),
        Command.expectExact(SeekAudio, SaveProgress.make({ episodeId: id, positionMs: 15_000 })),
        Command.resolve(SeekAudio, Component.noop),
        saved(15_000),
      )
    })

    test("a second Play does not wait again: a slow refresh never leaves Play dead", () => {
      story(
        update,
        given(refreshing),
        message(Message.ClickedPlayPause()),
        Command.expectNone(),
        message(Message.ClickedPlayPause()),
        model((next) => expect(next.maybePendingPlay).toEqual(Option.none())),
        Command.expectExact(PlayAudio),
        Command.resolve(PlayAudio, Component.noop),
      )
    })

    test("audio that starts by itself while the Play waits is not stamped, and the answer moves it to the phone's position", () => {
      story(
        update,
        given(refreshing),
        message(Message.ClickedPlayPause()),
        // The audio element reports play though the tab sent it no command: the tab stops it, as the Play waits.
        message(Message.StartedAudio()),
        Command.expectExact(PauseAudio),
        Command.resolve(PauseAudio, Component.noop),
        message(Message.UpdatedAudioTime({ offsetMs: 11_000, atMs: 6_000 })),
        Command.expectNone(),
        message(answer(phone)),
        model((next) => {
          expect(next.playback._tag === "Loaded" && next.playback.chapter).toBe(1)
          expect(next.playback._tag === "Loaded" && next.playback.offsetMs).toBe(40_000 - 26_825)
        }),
        Command.expectExact(StoreProgress.make({ episodeId: id, progress: phone }), secondChapter(40_000 - 26_825, true)),
        Command.resolve(StoreProgress, Component.noop),
        Command.resolve(LoadChapter, Component.noop),
        message(Message.UpdatedAudioTime({ offsetMs: 46_000 - 26_825, atMs: 12_000 })),
        Command.expectExact(SaveProgress.make({ episodeId: id, positionMs: 46_000 })),
        saved(46_000),
      )
    })

    test("the phone saved the same position with a newer stamp: the answer starts the audio once", async () => {
      // Review round 4, finding 1: taking the entry and releasing the Play each sent a toggle, so the audio paused.
      const same = progressAt(10_000, phone.updatedAt)
      story(
        update,
        given(refreshing),
        message(Message.ClickedPlayPause()),
        Command.expectNone(),
        message(answer(same)),
        model((next) => {
          expect(next.localProgress[id]).toEqual(same)
          expect(next.playback._tag === "Loaded" && next.playback.isPlaying).toBe(true)
        }),
        Command.expectExact(StoreProgress.make({ episodeId: id, progress: same }), PlayAudio),
        Command.resolve(StoreProgress, Component.noop),
        Command.resolve(PlayAudio, Component.noop),
      )
      // The Commands of that answer, run on an audio element: one `play`, no `pause`.
      const held = update(refreshing, Message.ClickedPlayPause()).model
      const audio = fakeAudio()
      await runAudio(update(held, answer(same)).commands, audio)
      expect([audio.playCalls, audio.pauseCalls, audio.paused]).toEqual([1, 0, false])
    })

    test("a later poll that fails does not start the Play: it waits for the request that was out at the press", () => {
      story(
        update,
        given(refreshing),
        message(Message.ClickedPlayPause()),
        // A poll (3) goes out while the foreground request (2) is still out, and the server refuses it.
        message(Message.TickedPoll()),
        Command.expectExact(FetchEpisodes.make({ connection, generation: 0, request: 3 })),
        Command.resolve(FetchEpisodes, Message.FailedFetchEpisodes({ generation: 0, request: 3, failure: unavailable })),
        // Nothing plays from the old 10 s, so no pause can stamp it over the phone's 40 s.
        Command.expectNone(),
        model((next) => {
          expect(next.maybePendingPlay).toEqual(Option.some({ episodeId: id, awaiting: [2] }))
          expect(next.playback._tag === "Loaded" && next.playback.isPlaying).toBe(false)
          expect(next.localProgress[id]).toEqual(old)
        }),
        message(Message.HidPage()),
        Command.expectNone(),
        message(answer(phone)),
        model((next) => {
          expect(next.maybePendingPlay).toEqual(Option.none())
          expect(next.localProgress[id]).toEqual(phone)
        }),
        Command.expectExact(StoreProgress.make({ episodeId: id, progress: phone }), secondChapter(40_000 - 26_825, true)),
        Command.resolve(StoreProgress, Component.noop),
        Command.resolve(LoadChapter, Component.noop),
        message(Message.UpdatedAudioTime({ offsetMs: 45_000 - 26_825, atMs: 5_000 })),
        Command.expectExact(SaveProgress.make({ episodeId: id, positionMs: 45_000 })),
        saved(45_000),
      )
    })

    test("a later poll that brings a list starts the Play at once: its list is fresher than the awaited one", () => {
      story(
        update,
        given(refreshing),
        message(Message.ClickedPlayPause()),
        message(Message.TickedPoll()),
        Command.resolve(FetchEpisodes, answer(phone, 3)),
        model((next) => expect(next.maybePendingPlay).toEqual(Option.none())),
        Command.expectExact(StoreProgress.make({ episodeId: id, progress: phone }), secondChapter(40_000 - 26_825, true)),
        Command.resolve(StoreProgress, Component.noop),
        Command.resolve(LoadChapter, Component.noop),
        message(Message.StartedAudio()),
        // The awaited request answers late, with the list from before the phone's save: playback stays. The tab
        // sends the entry it took, with the phone's stamp, as it does for every list older than what it holds.
        message(answer(old)),
        Command.expectExact(PushProgress.make({ connection, episodeId: id, progress: phone })),
        Command.resolve(PushProgress, Message.SucceededPushProgress({ episodeId: id, sent: phone, stored: phone })),
        Command.expectNone(),
        model((next) => {
          expect(next.localProgress[id]).toEqual(phone)
          expect(next.playback._tag === "Loaded" && next.playback.chapter).toBe(1)
          expect(next.playback._tag === "Loaded" && next.playback.isPlaying).toBe(true)
        }),
      )
    })

    test("an episode started from its row waits too, and starts at the phone's newer position", () => {
      const listed = update(withEpisodes(baseModel({ [id]: old }), [{ ...harbourDays, progress: old }]), Message.BecameVisible())
      story(
        updateKeepingReads,
        given(listed.model),
        message(Message.ClickedPlayEpisode({ episodeId: id })),
        Command.expectNone(),
        model((next) => expect(next.playback).toEqual(Playback.Stopped())),
        message(answer(phone)),
        Command.expectExact(StoreProgress.make({ episodeId: id, progress: phone }), ReadStoredProgress),
        Command.resolve(StoreProgress, Component.noop),
        readStorage,
        model((next) => {
          expect(next.playback._tag === "Loaded" && next.playback.chapter).toBe(1)
          expect(next.playback._tag === "Loaded" && next.playback.offsetMs).toBe(40_000 - 26_825)
        }),
        Command.expectExact(LoadChapter),
        Command.resolve(LoadChapter, Component.noop),
      )
    })

    describe("the waiting Play keeps the episode's id: it plays the episode as the answer lists it", () => {
      /** The job still narrates: the tab lists one chapter. */
      const growing = { ...runningHarbourDays, progress: old }
      /** The answer lists the job Ready with both chapters, and the phone played the episode to the end. */
      const finishedElsewhere = progressAt(46_525, phone.updatedAt)
      const firstChapter = LoadChapter.make({ src: required(harbourDays.chapters[0]).url, offsetMs: 0, rate: 1, isAutoplay: true })
      const listedGrowing = update(withEpisodes(baseModel({ [id]: old }), [growing]), Message.BecameVisible()).model
      const loadedGrowing = update(withEpisodes(paused, [growing]), Message.BecameVisible()).model
      const answerWithout = Message.SucceededFetchEpisodes({ generation: 0, request: 2, episodes: [queuedArticle] })

      test("from its row: a finished episode starts at 0, and its new chapter plays", () => {
        story(
          updateKeepingReads,
          given(listedGrowing),
          message(Message.ClickedPlayEpisode({ episodeId: id })),
          Command.expectNone(),
          message(answer(finishedElsewhere)),
          Command.expectExact(StoreProgress.make({ episodeId: id, progress: finishedElsewhere }), ReadStoredProgress),
          Command.resolve(StoreProgress, Component.noop),
          readStorage,
          model((next) =>
            expect(next.playback).toEqual(
              Playback.Loaded({
                episodeId: id,
                chapter: 0,
                url: required(harbourDays.chapters[0]).url,
                offsetMs: 0,
                isPlaying: true,
                isWaiting: false,
              }),
            ),
          ),
          Command.expectExact(firstChapter),
          Command.resolve(LoadChapter, Component.noop),
          // The second chapter came with the answer: the end of the first goes on to it.
          message(Message.EndedChapter()),
          Command.expectExact(secondChapter(0, true)),
          Command.resolve(LoadChapter, Component.noop),
        )
      })

      test("an episode the answer no longer lists does not play", () => {
        story(
          updateKeepingReads,
          given(listedGrowing),
          message(Message.ClickedPlayEpisode({ episodeId: id })),
          message(answerWithout),
          Command.expectNone(),
          model((next) => {
            expect(next.maybePendingPlay).toEqual(Option.none())
            expect(next.playback).toEqual(Playback.Stopped())
          }),
        )
        story(
          update,
          given(loadedGrowing),
          message(Message.ClickedPlayPause()),
          message(answerWithout),
          model((next) => {
            expect(next.maybePendingPlay).toEqual(Option.none())
            expect(next.playback).toEqual(Playback.Stopped())
          }),
          Command.expectExact(StopAudio),
          Command.resolve(StopAudio, Component.noop),
        )
      })
    })
  })

  describe("the end of the audio made so far", () => {
    const { id } = harbourDays
    const old = progressAt(10_000, "2026-11-23T10:00:00.000Z")
    /** The phone listened to the end of chapter 1 (26,825 ms) while the job still made chapter 2. */
    const phone = progressAt(26_825, "2026-11-23T10:01:00.000Z")
    /** The list while the job works: one chapter. */
    const growing = { ...runningHarbourDays, progress: phone }
    /** A later list: the job is Ready with both chapters, and the phone's entry is the same. */
    const grown = { ...harbourDays, progress: phone }
    const list = (episode: typeof harbourDays, request = 1) =>
      Message.SucceededFetchEpisodes({ generation: 0, request, episodes: [episode] })
    const paused = withPlayback(
      withEpisodes(baseModel({ [id]: old }), [{ ...runningHarbourDays, progress: old }]),
      Playback.Loaded({ episodeId: id, chapter: 0, url: required(harbourDays.chapters[0]).url, offsetMs: 10_000, isPlaying: false, isWaiting: false }),
    )
    const chapter = (index: number, offsetMs: number, isAutoplay: boolean) =>
      LoadChapter.make({ src: required(harbourDays.chapters[index]).url, offsetMs, rate: 1, isAutoplay })
    const atEndOfChapterOne = (isWaiting: boolean) =>
      Playback.Loaded({ episodeId: id, chapter: 0, url: required(harbourDays.chapters[0]).url, offsetMs: 26_825, isPlaying: false, isWaiting })
    const inChapterTwo = Playback.Loaded({ episodeId: id, chapter: 1, url: required(harbourDays.chapters[1]).url, offsetMs: 0, isPlaying: true, isWaiting: false })
    /** Five seconds of chapter 2 play: the save that goes out is after the phone's 26,825, in chapter 2. */
    const fiveSecondsOn = steps(
      Command.resolve(LoadChapter, Component.noop),
      message(Message.StartedAudio()),
      message(Message.UpdatedAudioTime({ offsetMs: 5_000, atMs: 6_000 })),
      Command.expectExact(SaveProgress.make({ episodeId: id, positionMs: 31_825 })),
      saved(31_825),
    )

    test("two refreshes with a growing list and a held Play: the Play goes on in chapter 2, not at 0:00", () => {
      // A poll (2) and the foreground request (3) are out when the listener presses Play.
      const polling = update(update(paused, Message.TickedPoll()).model, Message.BecameVisible()).model
      story(
        update,
        given(polling),
        message(Message.ClickedPlayPause()),
        Command.expectNone(),
        // The first answer lists one chapter: the phone's position is the end of the audio made so far.
        message(list(growing, 2)),
        model((next) => {
          expect(next.maybePendingPlay).toEqual(Option.some({ episodeId: id, awaiting: [3] }))
          expect(next.playback).toEqual(atEndOfChapterOne(false))
        }),
        Command.expectExact(StoreProgress.make({ episodeId: id, progress: phone }), SeekAudio.make({ offsetMs: 26_825 })),
        Command.resolve(StoreProgress, Component.noop),
        Command.resolve(SeekAudio, Component.noop),
        // The second answer lists two chapters and the same position: that position is now the start of chapter 2.
        message(list(grown, 3)),
        model((next) => {
          expect(next.maybePendingPlay).toEqual(Option.none())
          expect(next.playback).toEqual(inChapterTwo)
        }),
        Command.expectExact(chapter(1, 0, true)),
        fiveSecondsOn,
      )
    })

    test("Play at the end of the audio of a job that still works waits, saves nothing, and goes on in chapter 2", () => {
      story(
        update,
        given(paused),
        message(list(growing)),
        Command.resolve(StoreProgress, Component.noop),
        Command.resolve(SeekAudio, Component.noop),
        message(Message.ClickedPlayPause()),
        // No audio starts at 0:00, so no save can replace the phone's 26,825.
        Command.expectNone(),
        model((next) => expect(next.playback).toEqual(atEndOfChapterOne(true))),
        message(Message.HidPage()),
        Command.expectNone(),
        // A poll still lists one chapter: the wait goes on.
        message(list(growing)),
        Command.expectNone(),
        model((next) => expect(next.playback).toEqual(atEndOfChapterOne(true))),
        message(list(grown)),
        model((next) => expect(next.playback).toEqual(inChapterTwo)),
        Command.expectExact(chapter(1, 0, true)),
        fiveSecondsOn,
      )
    })

    test("from the row, while the list still has one chapter: the Play waits, then goes on in chapter 2", () => {
      story(
        updateKeepingReads,
        given(withEpisodes(baseModel({ [id]: phone }), [growing])),
        message(Message.ClickedPlayEpisode({ episodeId: id })),
        readStorage,
        model((next) => expect(next.playback).toEqual(atEndOfChapterOne(true))),
        Command.expectExact(chapter(0, 26_825, false)),
        Command.resolve(LoadChapter, Component.noop),
        message(list(grown)),
        model((next) => expect(next.playback).toEqual(inChapterTwo)),
        Command.expectExact(chapter(1, 0, true)),
        fiveSecondsOn,
      )
    })

    test("a wait the listener paused goes on in chapter 2 at the next Play, when it is listed by then", () => {
      const playing = withPlayback(
        withEpisodes(baseModel(), [runningHarbourDays]),
        Playback.Loaded({ episodeId: id, chapter: 0, url: required(harbourDays.chapters[0]).url, offsetMs: 26_000, isPlaying: true, isWaiting: false }),
      )
      story(
        update,
        given(playing),
        // The audio file is some milliseconds shorter than the listed chapter.
        message(Message.UpdatedAudioTime({ offsetMs: 26_810, atMs: 0 })),
        message(Message.EndedChapter()),
        Command.expectNone(),
        model((next) => expect(next.playback).toEqual(atEndOfChapterOne(true))),
        // Pause takes the wait back. The player rests at the end of chapter 1.
        message(Message.ClickedPlayPause()),
        Command.expectNone(),
        model((next) => expect(next.playback).toEqual(atEndOfChapterOne(false))),
        message(list(harbourDays)),
        Command.expectNone(),
        message(Message.ClickedPlayPause()),
        model((next) => expect(next.playback).toEqual(inChapterTwo)),
        Command.expectExact(chapter(1, 0, true)),
        fiveSecondsOn,
      )
    })

    test("one answer brings the next chapter and the phone's newer position: the waiting Play goes on at the phone's", () => {
      // Review round 4, finding 3: the wait went on at 26,825 and stamped 31,825 over the phone's 40,000.
      const waiting = withPlayback(
        withEpisodes(baseModel({ [id]: phone }), [growing]),
        Playback.Loaded({ episodeId: id, chapter: 0, url: required(harbourDays.chapters[0]).url, offsetMs: 26_825, isPlaying: false, isWaiting: true }),
      )
      const ahead = progressAt(40_000, "2026-11-23T10:02:00.000Z")
      story(
        update,
        given(waiting),
        message(list({ ...harbourDays, progress: ahead })),
        model((next) => {
          expect(next.localProgress[id]).toEqual(ahead)
          expect(next.playback).toEqual(
            Playback.Loaded({ episodeId: id, chapter: 1, url: required(harbourDays.chapters[1]).url, offsetMs: 40_000 - 26_825, isPlaying: true, isWaiting: false }),
          )
        }),
        // One audio Command. Nothing is stamped: the player took the phone's entry.
        Command.expectExact(StoreProgress.make({ episodeId: id, progress: ahead }), chapter(1, 40_000 - 26_825, true)),
        Command.resolve(StoreProgress, Component.noop),
        Command.resolve(LoadChapter, Component.noop),
        message(Message.StartedAudio()),
        message(Message.UpdatedAudioTime({ offsetMs: 45_000 - 26_825, atMs: 6_000 })),
        Command.expectExact(SaveProgress.make({ episodeId: id, positionMs: 45_000 })),
        saved(45_000),
      )
    })

    test("keeps the phone's position when the listener leaves an episode that waits for its next chapter", () => {
      const ahead = progressAt(40_000, "2026-11-23T10:02:00.000Z")
      const otherChapter = { ...required(harbourDays.chapters[0]), url: "/media/t/episodes/other/chapters/000.m4a" }
      const other = { ...harbourDays, id: queuedArticle.id, chapters: [otherChapter] }
      story(
        update,
        given(withEpisodes(baseModel(), [{ ...growing, progress: ahead }, other])),
        message(Message.ClickedPlayEpisode({ episodeId: id })),
        Command.resolve(ReadStoredProgress, Message.GotStoredProgress({ episodeId: id, intent: 1, stored: { _tag: "NotSaved" } })),
        Command.expectExact(StoreProgress.make({ episodeId: id, progress: ahead }), chapter(0, 26_825, false)),
        Command.resolve(StoreProgress, Component.noop),
        Command.resolve(LoadChapter, Component.noop),
        model((next) => expect(next.playback).toEqual(atEndOfChapterOne(true))),
        message(Message.HidPage()),
        Command.expectNone(),
        message(Message.ClickedPlayEpisode({ episodeId: other.id })),
        Command.resolve(ReadStoredProgress, Message.GotStoredProgress({ episodeId: other.id, intent: 2, stored: { _tag: "NotSaved" } })),
        Command.expectExact(LoadChapter.make({ src: otherChapter.url, offsetMs: 0, rate: 1, isAutoplay: true })),
        Command.resolve(LoadChapter, Component.noop),
        model((next) => expect(next.localProgress[id]).toEqual(ahead)),
      )
    })

    test("a Play that waits for a chapter takes a finished entry of a job that is Ready now: it starts at 0:00", () => {
      const waiting = withPlayback(
        withEpisodes(baseModel({ [id]: phone }), [growing]),
        Playback.Loaded({ episodeId: id, chapter: 0, url: required(harbourDays.chapters[0]).url, offsetMs: 26_825, isPlaying: false, isWaiting: true }),
      )
      const finished = progressAt(46_525, "2026-11-23T10:02:00.000Z")
      story(
        update,
        given(waiting),
        message(list({ ...harbourDays, progress: finished })),
        Command.expectExact(StoreProgress.make({ episodeId: id, progress: finished }), chapter(0, 0, true)),
        Command.resolve(StoreProgress, Component.noop),
        Command.resolve(LoadChapter, Component.noop),
      )
    })

    test("a seek back while the Play waits for a chapter plays from there, in the same chapter too", () => {
      const waiting = withPlayback(
        withEpisodes(baseModel({ [id]: phone }), [growing]),
        Playback.Loaded({ episodeId: id, chapter: 0, url: required(harbourDays.chapters[0]).url, offsetMs: 26_825, isPlaying: false, isWaiting: true }),
      )
      story(
        update,
        given(waiting),
        message(Message.ClickedSkip({ deltaMs: -15_000 })),
        model((next) =>
          expect(next.playback).toEqual(
            Playback.Loaded({ episodeId: id, chapter: 0, url: required(harbourDays.chapters[0]).url, offsetMs: 11_825, isPlaying: true, isWaiting: false }),
          ),
        ),
        Command.expectExact(chapter(0, 11_825, true), SaveProgress.make({ episodeId: id, positionMs: 11_825 })),
        Command.resolve(LoadChapter, Component.noop),
        saved(11_825),
      )
    })

    test("the Pause key takes a wait for a chapter back, and the Play key leaves it", () => {
      const waiting = withPlayback(
        withEpisodes(baseModel({ [id]: phone }), [growing]),
        Playback.Loaded({ episodeId: id, chapter: 0, url: required(harbourDays.chapters[0]).url, offsetMs: 26_825, isPlaying: false, isWaiting: true }),
      )
      story(
        update,
        given(waiting),
        message(Message.PressedMediaPlay()),
        model((next) => expect(next.playback).toEqual(atEndOfChapterOne(true))),
        message(Message.PressedMediaPause()),
        model((next) => expect(next.playback).toEqual(atEndOfChapterOne(false))),
        // The next chapter does not start a Play the listener took back.
        message(list(grown)),
        model((next) => expect(next.playback).toEqual(atEndOfChapterOne(false))),
        Command.expectNone(),
      )
    })

    test("the slider at the very end while the job still works: Play waits, and the Ready job makes it the end", () => {
      const encoding = {
        ...harbourDays,
        durationMs: null,
        bookUrl: null,
        job: { ...runningHarbourDays.job, stage: "encoding" as const },
      }
      const atEnd = (isWaiting: boolean) =>
        Playback.Loaded({ episodeId: id, chapter: 1, url: required(harbourDays.chapters[1]).url, offsetMs: 19_700, isPlaying: false, isWaiting })
      story(
        update,
        given({ ...paused, maybeEpisodes: Option.some([encoding]) }),
        message(Message.CommittedScrub({ value: "47000" })),
        Command.resolve(LoadChapter, Component.noop),
        saved(46_525),
        message(Message.ClickedPlayPause()),
        // The job may still make audio: the Play does not start at 0:00.
        Command.expectNone(),
        model((next) => expect(next.playback).toEqual(atEnd(true))),
        // The job is Ready with no audio after that place: the wait was the end. The device holds it already.
        message(list({ ...harbourDays, progress: progressAt(46_525, T) })),
        Command.expectNone(),
        model((next) => expect(next.playback).toEqual(atEnd(false))),
        // Now the position is finished: the next Play starts at 0:00.
        message(Message.ClickedPlayPause()),
        Command.expectExact(chapter(0, 0, true)),
        Command.resolve(LoadChapter, Component.noop),
      )
    })

  })

  describe("the audio Commands", () => {
    const paused = withPlayback(
      withEpisodes(baseModel({ [harbourDays.id]: progressAt(10_000) }), [harbourDays]),
      Playback.Loaded({ episodeId: harbourDays.id, chapter: 0, url: required(harbourDays.chapters[0]).url, offsetMs: 10_000, isPlaying: false, isWaiting: false }),
    )

    test("are absolute: a repeated Play or Pause changes nothing", async () => {
      const audio = fakeAudio()
      const play = update(paused, Message.ClickedPlayPause())
      expect(play.commands.map((command) => command.name)).toEqual([PlayAudio.key])
      await runAudio(play.commands, audio)
      await runAudio(play.commands, audio)
      expect(audio.paused).toBe(false)
      const pause = update(play.model, Message.ClickedPlayPause())
      expect(pause.commands.map((command) => command.name)).toEqual([PauseAudio.key])
      await runAudio(pause.commands, audio)
      await runAudio(pause.commands, audio)
      expect(audio.paused).toBe(true)
    })

    test("a browser that refuses to play takes the Play back; a play that a later Command stopped does not", async () => {
      const refused = fakeAudio(new DOMException("No user gesture", "NotAllowedError"))
      const play = update(paused, Message.ClickedPlayPause())
      const [failed] = await runAudio(play.commands, refused)
      expect(failed).toEqual(Message.FailedPlayAudio())
      story(
        update,
        given(play.model),
        message(Message.FailedPlayAudio()),
        model((next) => {
          expect(next.playback._tag === "Loaded" && next.playback.isPlaying).toBe(false)
          expect(Option.exists(next.maybeListening, (listening) => listening.wantsPlay)).toBe(false)
        }),
        Command.expectNone(),
      )
      // A new load or a pause stops the old `play()` with an AbortError: the later Command says what the audio does.
      const stopped = fakeAudio(new DOMException("Interrupted by a new load", "AbortError"))
      expect(await runAudio(play.commands, stopped)).toEqual([Component.noop])
    })

    test("a save that is being stamped is where the device is: a list that lands before the stamp moves nothing", () => {
      const phone = progressAt(40_000, "2026-11-23T11:00:00.000Z")
      const mine = progressAt(15_000, T)
      // A Story sends no Message while a Command is out. This one must: the list lands before the stamp does.
      const sought = update(paused, Message.ClickedSkip({ deltaMs: 5_000 }))
      expect(sought.commands.map((command) => command.name)).toEqual([SaveProgress.name, SeekAudio.key])
      expect(sought.model.stamping).toEqual({ [harbourDays.id]: 15_000 })
      const listed = update(
        sought.model,
        Message.SucceededFetchEpisodes({ generation: 0, request: 1, episodes: [{ ...harbourDays, progress: phone }] }),
      )
      // The phone's entry is older than the stamp that is on its way: it is not taken, and the player stays.
      expect(listed.commands).toEqual([])
      expect(listed.model.localProgress[harbourDays.id]).toEqual(progressAt(10_000))
      expect(listed.model.playback._tag === "Loaded" && listed.model.playback.offsetMs).toBe(15_000)
      story(
        update,
        given(listed.model),
        message(Message.SavedProgress({ episodeId: harbourDays.id, progress: mine })),
        model((next) => {
          expect(next.stamping).toEqual({})
          expect(next.localProgress[harbourDays.id]).toEqual(mine)
          expect(next.playback._tag === "Loaded" && next.playback.offsetMs).toBe(15_000)
        }),
        // The stamp is the newest entry, and it goes to the server.
        Command.expectExact(PushProgress.make({ connection, episodeId: harbourDays.id, progress: mine })),
        Command.resolve(PushProgress, Message.SucceededPushProgress({ episodeId: harbourDays.id, sent: mine, stored: mine })),
      )
    })
  })

  test("deleting the loaded episode stops the audio", () => {
    story(
      updateKeepingReads,
      given(withEpisodes(baseModel(), [harbourDays])),
      message(Message.ClickedPlayEpisode({ episodeId: harbourDays.id })),
      readStorage,
      Command.resolve(LoadChapter, Component.noop),
      message(Message.ClickedConfirmDelete({ episodeId: harbourDays.id })),
      Command.resolve(DeleteEpisode, Message.SucceededDeleteEpisode({ episodeId: harbourDays.id })),
      model((next) => expect(next.playback).toEqual(Playback.Stopped())),
      Command.expectExact(StopAudio),
      Command.resolve(StopAudio, Component.noop),
    )
  })

  test("picking a playback speed stores it and sets the audio rate", () => {
    story(
      update,
      given(baseModel()),
      message(Message.PickedPlaybackSpeed({ value: "1.5" })),
      model((next) => {
        expect(next.rate).toBe(1.5)
      }),
      Command.expectExact(StoreSetting, SetAudioRate),
      Command.resolve(StoreSetting, Component.noop),
      Command.resolve(SetAudioRate, Component.noop),
    )
  })
})

describe("progress sync", () => {
  const tideTables = { ...harbourDays, id: "tide-tables" as EpisodeId, title: "Tide Tables" }
  const older = progressAt(10_000, "2026-11-23T09:00:00.000Z")
  const newer = progressAt(40_000, "2026-11-23T11:00:00.000Z")
  const loaded = (list: ReadonlyArray<typeof harbourDays>) =>
    Message.SucceededFetchEpisodes({ generation: 0, request: 1, episodes: list })

  test("a library load sends each local entry newer than the server's and takes each newer server entry", () => {
    story(
      update,
      given(withEpisodes(baseModel({ [harbourDays.id]: newer, [tideTables.id]: older }), [])),
      message(loaded([{ ...harbourDays, progress: older }, { ...tideTables, progress: newer }])),
      Command.expectExact(
        PushProgress.make({ connection, episodeId: harbourDays.id, progress: newer }),
        StoreProgress.make({ episodeId: tideTables.id, progress: newer }),
      ),
      model((next) => {
        expect(next.localProgress[harbourDays.id]).toEqual(newer)
        expect(next.localProgress[tideTables.id]).toEqual(newer)
      }),
      Command.resolve(
        PushProgress,
        Message.SucceededPushProgress({ episodeId: harbourDays.id, sent: newer, stored: newer }),
      ),
      Command.resolve(StoreProgress, Component.noop),
      Command.expectNone(),
    )
  })

  test("listening done offline goes out on the first library load after a reload", () => {
    // Boot read an entry the server never got: the push failed while offline.
    story(
      update,
      given(withEpisodes(baseModel({ [harbourDays.id]: newer }), [])),
      message(loaded([harbourDays])),
      Command.expectExact(PushProgress.make({ connection, episodeId: harbourDays.id, progress: newer })),
      Command.resolve(PushProgress, Message.FailedPushProgress({ episodeId: harbourDays.id })),
      // Still newer than the server's, so the next load sends it again.
      message(loaded([harbourDays])),
      Command.expectExact(PushProgress.make({ connection, episodeId: harbourDays.id, progress: newer })),
      Command.resolve(
        PushProgress,
        Message.SucceededPushProgress({ episodeId: harbourDays.id, sent: newer, stored: newer }),
      ),
      message(loaded([{ ...harbourDays, progress: newer }])),
      Command.expectNone(),
    )
  })

  test("a passive load stamps and sends nothing", () => {
    // Boot, then the first library load: the device and the server agree.
    story(
      update,
      given(withEpisodes(baseModel({ [harbourDays.id]: older }), [])),
      message(loaded([{ ...harbourDays, progress: older }, queuedArticle])),
      Command.expectNone(),
    )
    // A fresh device: it only takes the server's entry, with the server's stamp.
    story(
      update,
      given(baseModel()),
      message(loaded([{ ...harbourDays, progress: older }])),
      Command.expectExact(StoreProgress.make({ episodeId: harbourDays.id, progress: older })),
      model((next) => expect(next.localProgress[harbourDays.id]).toEqual(older)),
      Command.resolve(StoreProgress, Component.noop),
    )
  })

  test("the device takes the server's answer to a push, a clamped stamp included, and does not send it again", () => {
    const sent = progressAt(20_000, "2026-11-23T13:00:00.000Z") // The device clock runs an hour fast.
    const clamped = progressAt(20_000, "2026-11-23T12:00:00.000Z")
    story(
      update,
      given(withEpisodes(baseModel(), [harbourDays])),
      message(Message.SavedProgress({ episodeId: harbourDays.id, progress: sent })),
      Command.expectExact(PushProgress.make({ connection, episodeId: harbourDays.id, progress: sent })),
      Command.resolve(PushProgress, Message.SucceededPushProgress({ episodeId: harbourDays.id, sent, stored: clamped })),
      Command.expectExact(StoreProgress.make({ episodeId: harbourDays.id, progress: clamped })),
      Command.resolve(StoreProgress, Component.noop),
      model((next) => expect(next.localProgress[harbourDays.id]).toEqual(clamped)),
      message(loaded([{ ...harbourDays, progress: clamped }])),
      Command.expectNone(),
    )
  })

  test("an answer to an older push does not replace a newer save", () => {
    const first = progressAt(20_000, "2026-11-23T12:00:00.000Z")
    const second = progressAt(25_000, "2026-11-23T12:00:05.000Z")
    story(
      update,
      given(withEpisodes(baseModel({ [harbourDays.id]: second }), [harbourDays])),
      message(Message.SucceededPushProgress({ episodeId: harbourDays.id, sent: first, stored: first })),
      model((next) => {
        expect(next.localProgress[harbourDays.id]).toEqual(second)
        expect(required(Option.getOrThrow(next.maybeEpisodes)[0]).progress).toEqual(first)
      }),
      Command.expectNone(),
    )
  })

  test("a newer server entry moves a loaded, paused episode there, without a save", () => {
    const paused = withPlayback(
      withEpisodes(baseModel({ [harbourDays.id]: older }), [harbourDays]),
      Playback.Loaded({ episodeId: harbourDays.id, chapter: 0, url: required(harbourDays.chapters[0]).url, offsetMs: 10_000, isPlaying: false, isWaiting: false }),
    )
    story(
      update,
      given(paused),
      message(loaded([{ ...harbourDays, progress: newer }])),
      model((next) => {
        expect(next.playback._tag === "Loaded" && next.playback.chapter).toBe(1)
        expect(next.playback._tag === "Loaded" && next.playback.offsetMs).toBe(40_000 - 26_825)
        expect(next.playback._tag === "Loaded" && next.playback.isPlaying).toBe(false)
      }),
      Command.expectExact(StoreProgress.make({ episodeId: harbourDays.id, progress: newer }), LoadChapter),
      Command.resolve(StoreProgress, Component.noop),
      Command.resolve(LoadChapter, Component.noop),
      // The tab hides: the device already holds that position, so nothing goes out.
      message(Message.HidPage()),
      Command.expectNone(),
    )
  })

  test("a newer server entry leaves a playing episode where it is", () => {
    const playing = withPlayback(
      withEpisodes(baseModel({ [harbourDays.id]: older }), [harbourDays]),
      Playback.Loaded({ episodeId: harbourDays.id, chapter: 0, url: required(harbourDays.chapters[0]).url, offsetMs: 12_000, isPlaying: true, isWaiting: false }),
    )
    story(
      update,
      given(playing),
      message(loaded([{ ...harbourDays, progress: newer }])),
      model((next) => expect(next.playback._tag === "Loaded" && next.playback.offsetMs).toBe(12_000)),
      Command.expectExact(StoreProgress.make({ episodeId: harbourDays.id, progress: newer })),
      Command.resolve(StoreProgress, Component.noop),
    )
  })

  test("a save stamps the device clock and stores whole milliseconds under fama.progress.<id>", () => {
    const result = Effect.runSync(SaveProgress.make({ episodeId: harbourDays.id, positionMs: 1234.6 }).effect)
    expect(result._tag).toBe("SavedProgress")
    expect(result.progress.positionMs).toBe(1235)
    expect(Math.abs(Date.parse(result.progress.updatedAt) - Date.now())).toBeLessThan(1000)
    expect(JSON.parse(localStorage.getItem(`fama.progress.${harbourDays.id}`) ?? "null")).toEqual(result.progress)
    localStorage.clear()
  })
})
