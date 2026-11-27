import type { Episode, EpisodeId, EpisodeProgress } from "@fama/contracts"
import type { Command, Component } from "@effect/ui"
import type { Connection } from "~/core/api"
import type { AudioCommandServices, AudioFailure } from "~/core/audio"
import { chapterStartMs } from "~/core/timeline"
import type { LoadedPlayback, PlaybackState } from "~/playback/model"

/**
 * The slice of the App the player owns, plus the read-only facts it needs. The App extracts it, runs the steps of
 * this module, and merges the owned fields back. The player never sees the App's Message or Model.
 */
export interface Player extends PlaybackState {
  readonly episodes: ReadonlyArray<Episode>
  readonly connection: Connection
  readonly rate: number
  readonly libraryRequestsInFlight: ReadonlyArray<number>
}

/** An audio Command the player can issue directly: the audio layer's own Commands, needing nothing from the App. */
export type PlayerCommand = Command.Command<AudioFailure | Component.Noop, AudioCommandServices>

/**
 * A progress write the player needs but cannot issue itself: the App translates these to its own Commands, which
 * carry its Message.
 */
export type ProgressEffect =
  | { readonly _tag: "SaveProgress"; readonly episodeId: EpisodeId; readonly positionMs: number }
  | { readonly _tag: "StoreProgress"; readonly episodeId: EpisodeId; readonly progress: EpisodeProgress }
  | { readonly _tag: "PushProgress"; readonly episodeId: EpisodeId; readonly progress: EpisodeProgress }
  | { readonly _tag: "ReadStoredProgress"; readonly episodeId: EpisodeId; readonly intent: number }

export interface PlayerResult {
  readonly player: Player
  readonly commands: ReadonlyArray<PlayerCommand>
  readonly progress: ReadonlyArray<ProgressEffect>
}

export type PlayerStep = (player: Player) => PlayerResult

export const unchanged: PlayerStep = (player) => ({ player, commands: [], progress: [] })

export const globalMs = (playback: LoadedPlayback, episode: Episode) =>
  chapterStartMs(episode.chapters, playback.chapter) + playback.offsetMs

/** Where the device holds an episode: the position a save stamps now, else its entry. */
export const heldMs = (player: Player, episodeId: EpisodeId): number | undefined =>
  player.stamping[episodeId] ?? player.localProgress[episodeId]?.positionMs
