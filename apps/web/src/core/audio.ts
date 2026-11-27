import { Command, Component, UiSchema } from "@effect/ui"
import { Context, Effect, Layer, Schema } from "effect"

/**
 * The audio element could not start playback. The app resets its playback state on it. It is the
 * only signal the audio layer produces, so the layer needs no knowledge of the app's Message.
 */
export const AudioFailure = UiSchema.TaggedEnum({ FailedPlayAudio: {} })
export type AudioFailure = typeof AudioFailure.Type

/**
 * The page's one audio element. It is detached: there is no `<audio>` in the DOM.
 * It lives as long as the app, so Commands and Subscriptions share it.
 */
export class AudioPlayer extends Context.Service<AudioPlayer, HTMLAudioElement>()("fama/web/AudioPlayer") {
  static readonly layer = Layer.effect(
    AudioPlayer,
    Effect.acquireRelease(
      Effect.sync(() => {
        const audio = new Audio()
        audio.preload = "auto"
        return audio
      }),
      (audio) => Effect.sync(() => stop(audio)),
    ),
  )
}

const stop = (audio: HTMLAudioElement) => {
  audio.pause()
  audio.removeAttribute("src")
  audio.load()
}

const isInterrupted = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "name" in error && error.name === "AbortError"

const play = (audio: HTMLAudioElement) =>
  Effect.tryPromise(() => audio.play()).pipe(
    Effect.as(Component.noop),
    Effect.catch(({ cause: error }) => Effect.succeed(isInterrupted(error) ? Component.noop : AudioFailure.FailedPlayAudio())),
  )

const AudioResult = Schema.Union([AudioFailure, Component.Noop])

/** Points the element at a chapter file and seeks into it. It plays when `isAutoplay`, and rests when not. */
export class LoadChapter extends Command.Service<LoadChapter>()("audio/LoadChapter", {
  args: { src: Schema.String, offsetMs: Schema.Number, rate: Schema.Number, isAutoplay: Schema.Boolean },
  success: AudioResult,
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const audio = yield* AudioPlayer
      return ({ src, offsetMs, rate, isAutoplay }) =>
        Effect.gen(function* () {
          audio.src = src
          audio.currentTime = offsetMs / 1000
          audio.defaultPlaybackRate = rate
          audio.playbackRate = rate
          return isAutoplay ? yield* play(audio) : Component.noop
        })
    }),
  )
}

/** The element plays. */
export class PlayAudio extends Command.Service<PlayAudio>()("audio/PlayAudio", {
  args: {},
  success: AudioResult,
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const audio = yield* AudioPlayer
      return () => play(audio)
    }),
  )
}

/** The element does not play. */
export class PauseAudio extends Command.Service<PauseAudio>()("audio/PauseAudio", {
  args: {},
  success: Component.Noop,
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const audio = yield* AudioPlayer
      return () =>
        Effect.sync(() => {
          audio.pause()
          return Component.noop
        })
    }),
  )
}

/** The element is at `offsetMs` of its file. Whether it plays does not change. */
export class SeekAudio extends Command.Service<SeekAudio>()("audio/SeekAudio", {
  args: { offsetMs: Schema.Number },
  success: Component.Noop,
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const audio = yield* AudioPlayer
      return ({ offsetMs }) =>
        Effect.sync(() => {
          audio.currentTime = offsetMs / 1000
          return Component.noop
        })
    }),
  )
}

export class SetAudioRate extends Command.Service<SetAudioRate>()("audio/SetAudioRate", {
  args: { rate: Schema.Number },
  success: Component.Noop,
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const audio = yield* AudioPlayer
      return ({ rate }) =>
        Effect.sync(() => {
          audio.defaultPlaybackRate = rate
          audio.playbackRate = rate
          return Component.noop
        })
    }),
  )
}

export class StopAudio extends Command.Service<StopAudio>()("audio/StopAudio", {
  args: {},
  success: Component.Noop,
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const audio = yield* AudioPlayer
      return () =>
        Effect.sync(() => {
          stop(audio)
          return Component.noop
        })
    }),
  )
}

export type AudioCommandServices =
  | LoadChapter
  | PlayAudio
  | PauseAudio
  | SeekAudio
  | SetAudioRate
  | StopAudio

export const audioCommandsLayer = Layer.mergeAll(
  LoadChapter.layer,
  PlayAudio.layer,
  PauseAudio.layer,
  SeekAudio.layer,
  SetAudioRate.layer,
  StopAudio.layer,
)
