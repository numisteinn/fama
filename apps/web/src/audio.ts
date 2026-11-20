import { Context, Effect, Layer, Schema } from "effect"
import { Command } from "foldkit"
import { Message } from "~/message"

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

/** Points the element at a chapter file, seeks into it, and plays when `isAutoplay`. */
export const LoadChapter = Command.define("LoadChapter", {
  args: { src: Schema.String, offsetMs: Schema.Number, rate: Schema.Number, isAutoplay: Schema.Boolean },
  messages: [Message.CompletedLoadChapter, Message.FailedPlayAudio],
  execute: ({ src, offsetMs, rate, isAutoplay }) =>
    Effect.gen(function* () {
      const audio = yield* AudioPlayer
      audio.src = src
      audio.currentTime = offsetMs / 1000
      audio.defaultPlaybackRate = rate
      audio.playbackRate = rate
      if (isAutoplay) yield* Effect.tryPromise(() => audio.play())
      return Message.CompletedLoadChapter()
    }).pipe(Effect.catch(() => Effect.succeed(Message.FailedPlayAudio()))),
})

/** Plays when paused, pauses when playing. */
export const ToggleAudio = Command.define("ToggleAudio", {
  messages: [Message.CompletedToggleAudio],
  execute: Effect.gen(function* () {
    const audio = yield* AudioPlayer
    if (audio.paused) yield* Effect.tryPromise(() => audio.play()).pipe(Effect.ignore)
    else audio.pause()
    return Message.CompletedToggleAudio()
  }),
})

export const SeekAudio = Command.define("SeekAudio", {
  args: { offsetMs: Schema.Number },
  messages: [Message.CompletedSeekAudio],
  execute: ({ offsetMs }) =>
    Effect.gen(function* () {
      const audio = yield* AudioPlayer
      audio.currentTime = offsetMs / 1000
      return Message.CompletedSeekAudio()
    }),
})

export const SetAudioRate = Command.define("SetAudioRate", {
  args: { rate: Schema.Number },
  messages: [Message.CompletedSetAudioRate],
  execute: ({ rate }) =>
    Effect.gen(function* () {
      const audio = yield* AudioPlayer
      audio.defaultPlaybackRate = rate
      audio.playbackRate = rate
      return Message.CompletedSetAudioRate()
    }),
})

export const StopAudio = Command.define("StopAudio", {
  messages: [Message.CompletedStopAudio],
  execute: Effect.gen(function* () {
    stop(yield* AudioPlayer)
    return Message.CompletedStopAudio()
  }),
})
