import type { Episode } from "@fama/contracts"
import { Option } from "effect"
import { FetchEpisodes } from "~/command"
import { type AppModel, episodes } from "~/model"
import type { AppCommand, Step } from "~/transition"

/** A new library request for the current connection, tagged with its generation and its number, and in flight. */
export const fetchLibrary = (model: AppModel): { model: AppModel; command: AppCommand } => {
  const request = model.libraryRequests + 1
  return {
    model: {
      ...model,
      libraryRequests: request,
      libraryRequestsInFlight: [...model.libraryRequestsInFlight, request],
    },
    command: FetchEpisodes.make({
      connection: model.connection,
      generation: model.connectionGeneration,
      request,
    }),
  }
}

export const fetchEpisodes: Step = (model) => {
  const library = fetchLibrary(model)
  return { model: library.model, commands: [library.command] }
}

/** Replaces the episode list. Captures the loaded chapter's duration before replacement so chapter fraction holds. */
export const withEpisodes =
  (toEpisodes: (list: ReadonlyArray<Episode>) => ReadonlyArray<Episode>): Step =>
  (model) => {
    const previous = episodes(model)
    const playback = model.playback
    const previousDuration =
      model.loadedChapterDurationMs === null && playback._tag === "Loaded"
        ? (() => {
            const chapter = previous.find((item) => item.id === playback.episodeId)?.chapters[playback.chapter]
            return chapter && chapter.url === playback.url ? chapter.durationMs : null
          })()
        : model.loadedChapterDurationMs
    return {
      model: {
        ...model,
        maybeEpisodes: Option.some(toEpisodes(previous)),
        loadedChapterDurationMs: previousDuration,
      },
    }
  }
