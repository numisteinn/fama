import type { Episode, EpisodeId, EpisodeProgress, VoiceRef } from "@fama/contracts"
import { Option } from "effect"
import { apiToken } from "~/api"
import type { LoadedPlayback, Model } from "~/model"
import { init } from "~/update"

export const connection = { origin: "", token: apiToken("dev-api-token") }

/** A fresh Model, as `init` makes it from empty storage plus a stored token and `localProgress`. */
export const baseModel = (localProgress: Record<string, EpisodeProgress> = {}): Model =>
  init({ token: connection.token, origin: "", voice: null, speed: 1, rate: 1, localProgress }).model

/** Progress at `positionMs`, stamped `updatedAt`. */
export const progressAt = (positionMs: number, updatedAt = "2026-11-23T10:00:00.000Z"): EpisodeProgress => ({
  positionMs,
  updatedAt,
})

/** `model` after the library loaded `episodes`: no library request is in flight. The next request is number 2. */
export const withEpisodes = (model: Model, episodes: ReadonlyArray<Episode>): Model => ({
  ...model,
  libraryRequestsInFlight: [],
  maybeEpisodes: Option.some(episodes),
})

/**
 * `model` with `playback` in the audio element, as the listener left it: the intent is Play when the audio plays or
 * waits for a chapter, and the player follows the entry the device holds.
 */
export const withPlayback = (model: Model, playback: LoadedPlayback): Model => ({
  ...model,
  playback,
  maybeListening: Option.some({
    episodeId: playback.episodeId,
    wantsPlay: playback.isPlaying || playback.isWaiting,
    isPlayDue: false,
    maybeSeekMs: Option.none(),
    maybeFollowedAt: Option.fromNullishOr(model.localProgress[playback.episodeId]?.updatedAt),
  }),
})

const at = "2026-11-20T00:00:00.000Z"

export const harbourDays: Episode = {
  id: "harbour-days" as EpisodeId,
  createdAt: at,
  source: { _tag: "File", fileName: "harbour-days.epub", contentType: "application/epub+zip" },
  title: "Harbour Days",
  author: "Fama Fixtures",
  language: "en",
  voice: "kokoro:af_heart" as VoiceRef,
  speed: 1,
  durationMs: 46525,
  chapters: [
    { index: 0, title: "Morning", durationMs: 26825, url: "/media/t/episodes/harbour-days/chapters/000.m4a", timingUrl: null },
    { index: 1, title: "Evening", durationMs: 19700, url: "/media/t/episodes/harbour-days/chapters/001.m4a", timingUrl: null },
  ],
  bookUrl: "/media/t/episodes/harbour-days/book.m4b",
  coverUrl: null,
  job: { _tag: "Ready", finishedAt: at },
  progress: null,
}

export const queuedArticle: Episode = {
  id: "article" as EpisodeId,
  createdAt: at,
  source: { _tag: "Url", url: "http://localhost:8790/article.html" },
  title: "localhost:8790/article.html",
  author: null,
  language: null,
  voice: null,
  speed: 1,
  durationMs: null,
  chapters: [],
  bookUrl: null,
  coverUrl: null,
  job: { _tag: "Queued" },
  progress: null,
}

/** Harbour Days while its second chapter is still being narrated. */
export const runningHarbourDays: Episode = {
  ...harbourDays,
  durationMs: null,
  bookUrl: null,
  chapters: [harbourDays.chapters[0]!],
  job: { _tag: "Running", workerId: "w" as never, stage: "synthesizing", done: 3, total: 6, heartbeatAt: at, remainingMs: null },
}
