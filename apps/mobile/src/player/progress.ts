import { type Episode, EpisodeProgress } from "@fama/contracts"
import { Schema } from "effect"
import { useSyncExternalStore } from "react"
import type { Api } from "../lib/api"
import { jsonFile } from "../lib/jsonFile"
import { isSameProgress, planSync, takesAnswer } from "./progressRules"

// The device's listening progress, one entry per episode. An entry newer than the server's is a pending write: it
// stays in the file across an app kill and goes out on the next library load. Episode ids are UUIDs, and a load only
// merges the episodes the server listed for the current account, so an entry never goes to the wrong account.

const file = jsonFile<Record<string, unknown>>("progress.json", {})
const decode = Schema.decodeUnknownOption(EpisodeProgress)

function readEntries(): Record<string, EpisodeProgress> {
  const entries: Record<string, EpisodeProgress> = {}
  for (const [id, raw] of Object.entries(file.read())) {
    const decoded = decode(raw)
    if (decoded._tag === "Some") entries[id] = decoded.value
  }
  return entries
}

let entries = readEntries()
let api: Api | null = null
const listeners = new Set<() => void>()
/** Called when the device takes a server entry, so a loaded, paused player can move there. */
let adoptListener: (episodeId: string, progress: EpisodeProgress) => void = () => {}

function set(episodeId: string, progress: EpisodeProgress) {
  entries = { ...entries, [episodeId]: progress }
  file.write(entries)
  listeners.forEach((listener) => listener())
}

function adopt(episodeId: string, progress: EpisodeProgress) {
  set(episodeId, progress)
  adoptListener(episodeId, progress)
}

async function push(episodeId: string, sent: EpisodeProgress) {
  const target = api
  if (!target) return
  try {
    const stored = await target.putProgress(episodeId, sent)
    // A clamped stamp included, so a fast device clock does not win every later write.
    if (takesAnswer(entries[episodeId], sent) && !isSameProgress(stored, sent)) adopt(episodeId, stored)
  } catch {
    // Offline or refused: the entry stays newer than the server's and goes out on the next library load.
  }
}

export const progress = {
  get: (episodeId: string): EpisodeProgress | null => entries[episodeId] ?? null,
  /** The server this account talks to. Set before a sync. */
  connect(next: Api | null) {
    api = next
  },
  onAdopt(listener: typeof adoptListener) {
    adoptListener = listener
  },
  /** A listener's action left the episode at `positionMs`: stamp it with the device clock, store it, send it. */
  save(episodeId: string, positionMs: number) {
    const ms = Math.max(0, Math.round(positionMs))
    if (entries[episodeId]?.positionMs === ms) return
    const saved = { positionMs: ms, updatedAt: new Date().toISOString() }
    set(episodeId, saved)
    void push(episodeId, saved)
  },
  /** After a library load: send newer local entries, take newer server entries. Stamps nothing. */
  sync(episodes: ReadonlyArray<Episode>) {
    const plan = planSync(entries, episodes)
    for (const [episodeId, entry] of plan.adopt) adopt(episodeId, entry)
    for (const [episodeId, entry] of plan.push) void push(episodeId, entry)
  },
  forget(episodeId: string) {
    const { [episodeId]: _, ...rest } = entries
    entries = rest
    file.write(entries)
    listeners.forEach((listener) => listener())
  },
}

/** The device's position in an episode, in ms, as last saved or taken from the server. */
export function useProgressMs(episodeId: string): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => entries[episodeId]?.positionMs ?? 0,
  )
}
