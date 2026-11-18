import type { VoiceRef } from "@fama/contracts"
import { asNumber, asString, stored } from "~/lib/storage"

/** Bearer token for `/api/*`. */
export const apiToken = stored("fama.token", "", asString)

/** Server origin. Empty means the page's own origin, which is the production setup. */
export const apiOrigin = stored("fama.origin", "", (raw) =>
  typeof raw === "string" ? raw.trim().replace(/\/+$/, "") : undefined,
)

/** Last voice picked in the add bar. `null` is Auto. */
export const lastVoice = stored<VoiceRef | null>("fama.voice", null, (raw) =>
  raw === null ? null : (asString(raw) as VoiceRef | undefined),
)

/** Last synthesis speed picked in the add bar. */
export const lastSpeed = stored("fama.speed", 1, asNumber)

/** Playback rate of the player. */
export const playbackRate = stored("fama.rate", 1, asNumber)

export const mediaUrl = (path: string) => apiOrigin.get() + path
