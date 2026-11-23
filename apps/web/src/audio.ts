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

/**
 * The audio Commands are absolute: each says what the element has or does after it, never "the other state". So a
 * repeated Command changes nothing. Only `reconcile` in `update.ts` sends them, at most one for each Message.
 */

/** `play()` was stopped by a later load or pause. That is not a refusal: the later Command says what the element does. */
const isInterrupted = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "name" in error && error.name === "AbortError"

/** Starts the element. A browser that refuses (no user gesture, a broken file) gives `FailedPlayAudio`. */
const play = <Completed>(audio: HTMLAudioElement, completed: Completed) =>
  Effect.tryPromise({ try: () => audio.play(), catch: (error) => error }).pipe(
    Effect.as(completed),
    Effect.catch((error) => Effect.succeed(isInterrupted(error) ? completed : Message.FailedPlayAudio())),
  )

/** Points the element at a chapter file and seeks into it. It plays when `isAutoplay`, and rests when not. */
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
      return isAutoplay ? yield* play(audio, Message.CompletedLoadChapter()) : Message.CompletedLoadChapter()
    }),
})

/** The element plays. */
export const PlayAudio = Command.define("PlayAudio", {
  messages: [Message.CompletedPlayAudio, Message.FailedPlayAudio],
  execute: Effect.gen(function* () {
    return yield* play(yield* AudioPlayer, Message.CompletedPlayAudio())
  }),
})

/** The element does not play. */
export const PauseAudio = Command.define("PauseAudio", {
  messages: [Message.CompletedPauseAudio],
  execute: Effect.gen(function* () {
    const audio = yield* AudioPlayer
    audio.pause()
    return Message.CompletedPauseAudio()
  }),
})

/** The element is at `offsetMs` of its file. Whether it plays does not change. */
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
