import { Timing, type Episode, type Segment } from "@fama/contracts"
import { Schema } from "effect"
import { File } from "expo-file-system"
import { useEffect, useMemo, useReducer } from "react"
import { useDownloads } from "../lib/downloads"
import { useSettings } from "../lib/settings"
import { type ReaderText, type TextEvent, listed, nextLoads, update } from "./text"

/** Timing files in flight at once. */
const PARALLEL = 2
const TIMEOUT_MS = 20_000

const decode = Schema.decodeUnknownSync(Timing)

/** The boundary: a timing file from the device or the server, parsed with the contract. Throws when it is not one. */
async function readTiming(remote: string, local: string | null): Promise<ReadonlyArray<Segment>> {
  if (local) return decode(JSON.parse(await new File(local).text())).segments
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(remote, { signal: controller.signal })
    if (!response.ok) throw new Error(`timing file: ${response.status}`)
    return decode(await response.json()).segments
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The text of `episode` as the library lists it now. It loads the timing files it lacks, the playing chapter first.
 * New chapters of a running job load when the list has them.
 */
export function useReaderText(episode: Episode, playing: number) {
  const { api } = useSettings()
  const { localTimingUri } = useDownloads()
  const [stored, dispatch] = useReducer(
    (state: ReaderText, event: TextEvent | { _tag: "Listed"; episode: Episode }) =>
      event._tag === "Listed" ? listed(state, event.episode) : update(state, event),
    episode,
    (first) => listed(null, first),
  )
  const current = useMemo(() => listed(stored, episode), [stored, episode])
  useEffect(() => {
    dispatch({ _tag: "Listed", episode })
  }, [episode])

  useEffect(() => {
    if (!api) return
    for (const index of nextLoads(current, playing, PARALLEL)) {
      const chapter = episode.chapters[index]
      const state = current.chapters[index]
      if (!chapter?.timingUrl || state?._tag !== "Idle") continue
      const { key } = state
      dispatch({ _tag: "Started", index, key })
      readTiming(api.mediaUrl(chapter.timingUrl), localTimingUri(episode.id, chapter.index)).then(
        (segments) => dispatch({ _tag: "Loaded", index, key, segments }),
        () => dispatch({ _tag: "Failed", index, key }),
      )
    }
  }, [api, current, episode, localTimingUri, playing])

  return { text: current, dispatch }
}
