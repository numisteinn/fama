import { EpisodeProgress, VoiceRef } from "@fama/contracts"
import { UiSchema } from "@effect/ui"
import { Effect, Option, Schema } from "effect"
import { ApiToken, type Connection, apiToken } from "~/core/api"

/**
 * What storage holds for an episode's progress when it starts. `NotSaved` has no local entry, as after the
 * user cleared site data: the server's progress decides. Only `Unreadable` storage falls back to the entry
 * this tab knows.
 */
export const StoredProgress = UiSchema.TaggedEnum({
  Saved: { progress: EpisodeProgress },
  NotSaved: {},
  Unreadable: {},
})
export type StoredProgress = typeof StoredProgress.Type

/** Settings read from localStorage at boot. */
export const Flags = Schema.Struct({
  token: ApiToken,
  origin: Schema.String,
  voice: Schema.NullOr(VoiceRef),
  speed: Schema.Number,
  rate: Schema.Number,
  localProgress: Schema.Record(Schema.String, EpisodeProgress),
})
export type Flags = typeof Flags.Type

/** `fama.progress.<episodeId>` holds that episode's `EpisodeProgress` as JSON. */
export const PROGRESS_PREFIX = "fama.progress."
const decodeProgress = Schema.decodeUnknownOption(EpisodeProgress)

/** Reads a JSON value the React app stored. Missing, broken or blocked storage gives `undefined`. */
function read(key: string): unknown {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? undefined : JSON.parse(raw)
  } catch {
    return undefined
  }
}

const asString = (raw: unknown) => (typeof raw === "string" ? raw : undefined)
const asNumber = (raw: unknown) => (typeof raw === "number" && Number.isFinite(raw) ? raw : undefined)

function storedProgressEntries(): Record<string, EpisodeProgress> {
  const entries: Record<string, EpisodeProgress> = {}
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index)
      if (!key?.startsWith(PROGRESS_PREFIX)) continue
      Option.map(decodeProgress(read(key)), (progress) => {
        entries[key.slice(PROGRESS_PREFIX.length)] = progress
      })
    }
  } catch {
    // Storage blocked: start with no local progress.
  }
  return entries
}

/** The progress stored for an episode, read now. A broken value counts as not saved. */
export const storedProgress = (episodeId: string): StoredProgress => {
  let raw: string | null
  try {
    raw = localStorage.getItem(PROGRESS_PREFIX + episodeId)
  } catch {
    return StoredProgress.Unreadable()
  }
  if (raw === null) return StoredProgress.NotSaved()
  try {
    return Option.match(decodeProgress(JSON.parse(raw)), {
      onNone: () => StoredProgress.NotSaved(),
      onSome: (progress) => StoredProgress.Saved({ progress }),
    })
  } catch {
    return StoredProgress.NotSaved()
  }
}

/** The keys that hold the settings another tab can change: token, server, Voice, Voice speed and Playback speed. */
export const SETTING_KEYS: ReadonlyArray<string> = ["fama.token", "fama.origin", "fama.voice", "fama.speed", "fama.rate"]

/** The saved settings, read now, under the same keys and JSON encoding as the React app. */
export const storedSettings = (): {
  connection: Connection
  maybeVoice: Option.Option<VoiceRef>
  speed: number
  rate: number
} => ({
  connection: {
    token: apiToken(asString(read("fama.token")) ?? ""),
    origin: (asString(read("fama.origin")) ?? "").trim().replace(/\/+$/, ""),
  },
  maybeVoice: Option.fromNullishOr(asString(read("fama.voice")) as VoiceRef | undefined),
  speed: asNumber(read("fama.speed")) ?? 1,
  rate: asNumber(read("fama.rate")) ?? 1,
})

/** Settings from localStorage at boot. */
export const flags: Effect.Effect<Flags> = Effect.sync(() => {
  const { connection, maybeVoice, speed, rate } = storedSettings()
  return {
    ...connection,
    voice: Option.getOrNull(maybeVoice),
    speed,
    rate,
    localProgress: storedProgressEntries(),
  }
})
