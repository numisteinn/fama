import { EpisodeProgress } from "@fama/contracts"
import { Schema } from "effect"
import { useSyncExternalStore } from "react"
import { jsonFile } from "../lib/jsonFile"

// The device's listening progress on disk, one entry per episode. The player core (`core.ts`) decides every change:
// this module only reads the file at launch, and writes what the core holds. An entry newer than the server's is a
// pending write: it stays in the file across an app kill and goes out on the next library load. Episode ids are
// UUIDs, and a load only merges the episodes the server listed for the current account, so an entry never goes to
// the wrong account.

const file = jsonFile<Record<string, unknown>>("progress.json", {})
const decode = Schema.decodeUnknownOption(EpisodeProgress)

function readEntries(): Readonly<Record<string, EpisodeProgress>> {
  const read: Record<string, EpisodeProgress> = {}
  for (const [id, raw] of Object.entries(file.read())) {
    const decoded = decode(raw)
    if (decoded._tag === "Some") read[id] = decoded.value
  }
  return read
}

let entries = readEntries()
const listeners = new Set<() => void>()

export const progress = {
  /** The entries the device holds. */
  entries: (): Readonly<Record<string, EpisodeProgress>> => entries,
  /** The player core holds these entries now: store them. */
  replace(next: Readonly<Record<string, EpisodeProgress>>) {
    entries = next
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
