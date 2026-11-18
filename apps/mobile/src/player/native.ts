import { NativeModule, requireNativeModule, requireNativeView } from "expo"
import type { ColorValue, ViewProps } from "react-native"

export type Track = { url: string; title: string; durationMs: number }

export type LoadOptions = {
  episodeId: string
  title: string
  artist: string | null
  artworkUrl: string | null
  tracks: Track[]
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
  updateTracks(tracks: Track[]): Promise<void>
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
