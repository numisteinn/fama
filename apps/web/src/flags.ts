import type { VoiceRef } from "@fama/contracts"
import { Effect, Option } from "effect"
import { type Connection, apiToken } from "~/api"
import { type Flags, StoredPosition } from "~/model"

const POSITION_PREFIX = "fama.position."

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

function storedPositions(): Record<string, number> {
  const positions: Record<string, number> = {}
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index)
      if (!key?.startsWith(POSITION_PREFIX)) continue
      const value = asNumber(read(key))
      if (value !== undefined) positions[key.slice(POSITION_PREFIX.length)] = value
    }
  } catch {
    // Storage blocked: start with no saved positions.
  }
  return positions
}

/** The position saved for an episode, read now. A broken value counts as not saved, as in the React app. */
export const storedPosition = (episodeId: string): StoredPosition => {
  let raw: string | null
  try {
    raw = localStorage.getItem(POSITION_PREFIX + episodeId)
  } catch {
    return StoredPosition.Unreadable()
  }
  if (raw === null) return StoredPosition.NotSaved()
  try {
    const positionMs = asNumber(JSON.parse(raw))
    return positionMs === undefined ? StoredPosition.NotSaved() : StoredPosition.Saved({ positionMs })
  } catch {
    return StoredPosition.NotSaved()
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
    savedPositions: storedPositions(),
  }
})
