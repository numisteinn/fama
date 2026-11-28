import { Option } from "effect"
import { SetAudioVolume } from "~/core/audio"
import { chapterStartMs } from "~/core/timeline"
import { type AppModel, current } from "~/model"
import { Player } from "~/playback/player"
import { SleepTimer, applySleepChoice, endedChapterSleep, isSleepFaded, tickSleep } from "~/playback/sleepTimer"
import { runPlayer } from "~/playerGlue"
import { type Step, type StepReturn } from "~/transition"

export const pickedSleep = (model: AppModel, value: string, nowMs: number): StepReturn => {
  const next = applySleepChoice(model.sleep, value, nowMs)
  if (Option.isNone(next) || model.playback._tag !== "Loaded") return { model }
  return {
    model: { ...model, sleep: next.value, sleepAtMs: nowMs, sleepResumePending: false },
    commands: isSleepFaded(model.sleep, model.sleepAtMs) ? [SetAudioVolume.make({ volume: 1 })] : [],
  }
}

const isPlaying = (model: AppModel) => model.playback._tag === "Loaded" && model.playback.isPlaying

export const tickedSleep = (model: AppModel, nowMs: number): StepReturn => {
  if (!isPlaying(model) || model.sleep._tag !== "Countdown" || nowMs < model.sleepAtMs) return { model }
  const tick = tickSleep(model.sleep, nowMs, model.sleepResumePending)
  const next = { ...model, sleep: tick.sleep, sleepAtMs: nowMs, sleepResumePending: false }
  if (tick.isPauseDue) return runPlayer(next, Player.askPause)
  return tick.volume < 1 ? { model: next, commands: [SetAudioVolume.make({ volume: tick.volume })] } : { model: next }
}

export const endedChapterWithSleep = (model: AppModel): StepReturn => {
  const ended = endedChapterSleep(model.sleep)
  const after = runPlayer(model, Player.endChapter)
  if (!ended.isPauseDue) return after
  const loaded = current(after.model)
  if (Option.isNone(loaded)) return after
  const { playback, episode } = loaded.value
  const paused = runPlayer({ ...after.model, sleep: ended.sleep }, Player.askPause)
  const boundaryMs = chapterStartMs(episode.chapters, playback.chapter) + playback.offsetMs
  return runPlayer(paused.model, Player.seek(boundaryMs))
}

export const reconcileWithSleep = (before: AppModel): Step => (state) => {
  const reconciled = runPlayer(state, Player.reconcile)
  const { model } = reconciled
  if (model.playback._tag === "Stopped") {
    if (state.playback._tag === "Stopped" && Option.isNone(state.maybeListening)) return reconciled
    return {
      ...reconciled,
      model: { ...model, maybeScrubMs: Option.none(), sleep: SleepTimer.Off(), sleepResumePending: false },
    }
  }
  if (before.playback._tag === "Loaded" && before.playback.episodeId !== model.playback.episodeId) {
    return { ...reconciled, model: { ...model, sleep: SleepTimer.Off(), sleepResumePending: false } }
  }
  if (isPlaying(before) && !isPlaying(state) && !isPlaying(model) && isSleepFaded(model.sleep, model.sleepAtMs)) {
    return { model, commands: [...(reconciled.commands ?? []), SetAudioVolume.make({ volume: 1 })] }
  }
  if (model.sleep._tag === "Countdown" && !isPlaying(before) && isPlaying(model)) {
    return { ...reconciled, model: { ...model, sleepResumePending: true } }
  }
  return reconciled
}
