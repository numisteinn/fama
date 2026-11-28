import {
  PushProgress,
  ReadStoredProgress,
  SaveProgress,
  StoreProgress,
} from "~/command"
import type { Connection } from "~/core/api"
import { type AppModel, episodes } from "~/model"
import type { Player as PlayerState, PlayerResult, ProgressEffect } from "~/playback/player"
import type { AppCommand, StepReturn } from "~/transition"

// PLAYER GLUE
//
// The player owns a flat slice of the App Model plus the read-only facts it reads. These helpers extract it,
// run the player's steps, and merge the owned fields back. Progress writes come back as `ProgressEffect`s, which
// the App translates to its own Commands.

export const playerOf = (model: AppModel): PlayerState => ({
  playback: model.playback,
  loadedChapterDurationMs: model.loadedChapterDurationMs,
  maybeListening: model.maybeListening,
  playIntents: model.playIntents,
  maybePendingPlay: model.maybePendingPlay,
  localProgress: model.localProgress,
  stamping: model.stamping,
  isSaveDue: model.isSaveDue,
  lastSavedAtMs: model.lastSavedAtMs,
  episodes: episodes(model),
  connection: model.connection,
  rate: model.rate,
  libraryRequestsInFlight: model.libraryRequestsInFlight,
})

const withPlayer = (model: AppModel, player: PlayerState): AppModel => ({
  ...model,
  playback: player.playback,
  loadedChapterDurationMs: player.loadedChapterDurationMs,
  maybeListening: player.maybeListening,
  playIntents: player.playIntents,
  maybePendingPlay: player.maybePendingPlay,
  localProgress: player.localProgress,
  stamping: player.stamping,
  isSaveDue: player.isSaveDue,
  lastSavedAtMs: player.lastSavedAtMs,
})

const progressCommand = (effect: ProgressEffect, connection: Connection): AppCommand => {
  switch (effect._tag) {
    case "SaveProgress":
      return SaveProgress.make({ episodeId: effect.episodeId, positionMs: effect.positionMs })
    case "StoreProgress":
      return StoreProgress.make({ episodeId: effect.episodeId, progress: effect.progress })
    case "PushProgress":
      return PushProgress.make({ connection, episodeId: effect.episodeId, progress: effect.progress })
    case "ReadStoredProgress":
      return ReadStoredProgress.make({ episodeId: effect.episodeId, intent: effect.intent })
  }
}

export const runPlayer = (model: AppModel, fn: (player: PlayerState) => PlayerResult): StepReturn => {
  const player = playerOf(model)
  const result = fn(player)
  return {
    model: result.player === player ? model : withPlayer(model, result.player),
    commands: [...result.progress.map((effect) => progressCommand(effect, model.connection)), ...result.commands],
  }
}
