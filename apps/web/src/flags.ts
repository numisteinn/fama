import type { VoiceRef } from "@fama/contracts"
import { Effect, Option } from "effect"
import { type Connection, apiToken } from "~/api"
import type { Flags } from "~/model"

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

/** The position saved for an episode, read now. `None` when storage has none or is blocked. */
export const storedPosition = (episodeId: string): Option.Option<number> =>
  Option.fromNullishOr(asNumber(read(POSITION_PREFIX + episodeId)))

/** The keys that hold the saved connection. */
export const CONNECTION_KEYS: ReadonlyArray<string> = ["fama.token", "fama.origin"]

/** The saved token and server. */
export const storedConnection = (): Connection => ({
  token: apiToken(asString(read("fama.token")) ?? ""),
  origin: (asString(read("fama.origin")) ?? "").trim().replace(/\/+$/, ""),
})

/** Settings from localStorage, under the same keys and JSON encoding as before. */
export const flags: Effect.Effect<Flags> = Effect.sync(() => {
  const voice = read("fama.voice")
  return {
    ...storedConnection(),
    voice: typeof voice === "string" ? (voice as VoiceRef) : null,
    speed: asNumber(read("fama.speed")) ?? 1,
    rate: asNumber(read("fama.rate")) ?? 1,
    savedPositions: storedPositions(),
  }
})
