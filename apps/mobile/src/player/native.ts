import { NativeModule, requireNativeModule, requireNativeView } from "expo"
import type { ColorValue, ViewProps } from "react-native"

export type Track = { url: string; title: string; durationMs: number }

export type LoadOptions = {
  episodeId: string
  title: string
  artist: string | null
  artworkUrl: string | null
  tracks: Track[]
  /** The job still makes chapters: the end of the tracks is a wait, not the end of the episode. */
  expectsMore: boolean
  /** Episode seconds. */
  position: number
  rate: number
  autoplay: boolean
}

export type NativeStatus = {
  episodeId: string | null
  /** Chapter index. */
  index: number
  /** Episode seconds. */
  position: number
  /** Episode seconds, the sum of the known chapters. */
  duration: number
  /** The listener wants playback. Stays true while buffering. */
  playing: boolean
  buffering: boolean
  rate: number
  /** Played past the last known chapter. */
  ended: boolean
  error: string | null
}

declare class FamaPlayerModule extends NativeModule<{ onStatus: (status: NativeStatus) => void }> {
  load(options: LoadOptions): Promise<void>
  /** The episode as the library lists it now: its chapters, and whether the job still makes more. */
  updateTracks(tracks: Track[], expectsMore: boolean): Promise<void>
  play(): Promise<void>
  pause(): Promise<void>
  seek(position: number): Promise<void>
  skip(delta: number): Promise<void>
  setRate(rate: number): Promise<void>
  unload(): Promise<void>
  getStatus(): Promise<NativeStatus>
}

export const FamaPlayer = requireNativeModule<FamaPlayerModule>("FamaPlayer")

/** AVRoutePickerView: AirPlay and Bluetooth outputs. */
export const RouteButton = requireNativeView<ViewProps & { tint?: ColorValue; activeTint?: ColorValue }>("FamaPlayer")
