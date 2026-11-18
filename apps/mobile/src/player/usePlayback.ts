import { useMemo } from "react"
import { useDownloads } from "../lib/downloads"
import { useSettings } from "../lib/settings"
import type { TrackSource } from "./player"

/** Where chapter audio comes from: the device when downloaded, else the server. */
export function useTrackSource(): TrackSource | null {
  const { api } = useSettings()
  const { localUri } = useDownloads()
  return useMemo(() => (api ? { mediaUrl: api.mediaUrl, localUri } : null), [api, localUri])
}
