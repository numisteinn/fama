import { useRef, useState } from "react"
import { PanResponder, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native"
import { clock } from "../lib/format"
import { colors, fonts } from "../theme"

type Props = {
  position: number
  duration: number
  /** Episode seconds where chapters 1..n start. */
  marks: ReadonlyArray<number>
  onSeek: (position: number) => void
}

/** Episode-wide scrubber. Tap or drag anywhere on the 44 pt strip; it seeks on release. */
export function Scrubber({ position, duration, marks, onSeek }: Props) {
  const width = useRef(1)
  const [drag, setDrag] = useState<number | null>(null)
  const latest = useRef({ duration, onSeek })
  latest.current = { duration, onSeek }

  const at = (x: number) => Math.max(0, Math.min(1, x / width.current)) * latest.current.duration

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (event) => setDrag(at(event.nativeEvent.locationX)),
      onPanResponderMove: (event) => setDrag(at(event.nativeEvent.locationX)),
      onPanResponderRelease: (event) => {
        latest.current.onSeek(at(event.nativeEvent.locationX))
        setDrag(null)
      },
      onPanResponderTerminate: () => setDrag(null),
    }),
  ).current

  const shown = drag ?? position
  const fraction = duration > 0 ? Math.min(1, shown / duration) : 0

  return (
    <View>
      <View
        style={styles.hit}
        onLayout={(event: LayoutChangeEvent) => (width.current = event.nativeEvent.layout.width)}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel="Position"
        accessibilityValue={{ text: `${clock(shown)} of ${clock(duration)}` }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={(event) => onSeek(position + (event.nativeEvent.actionName === "increment" ? 30 : -15))}
        {...responder.panHandlers}
      >
        <View style={[styles.track, drag !== null && styles.trackActive]} pointerEvents="none">
          <View style={[styles.fill, { width: `${fraction * 100}%` }]} />
          {duration > 0
            ? marks.map((mark) => <View key={mark} style={[styles.mark, { left: `${(mark / duration) * 100}%` }]} />)
            : null}
        </View>
        <View pointerEvents="none" style={[styles.thumb, drag !== null && styles.thumbActive, { left: `${fraction * 100}%` }]} />
      </View>
      <View style={styles.times} pointerEvents="none">
        <Text style={styles.time}>{clock(shown)}</Text>
        <Text style={styles.time}>-{clock(Math.max(0, duration - shown))}</Text>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  hit: { height: 44, justifyContent: "center" },
  track: { height: 6, borderRadius: 3, backgroundColor: colors.surfaceRaised, overflow: "hidden" },
  trackActive: { height: 10, borderRadius: 5 },
  fill: { height: "100%", backgroundColor: colors.accent },
  mark: { position: "absolute", top: 0, bottom: 0, width: 2, marginLeft: -1, backgroundColor: colors.background },
  thumb: { position: "absolute", width: 16, height: 16, marginLeft: -8, borderRadius: 8, backgroundColor: colors.text },
  thumbActive: { width: 24, height: 24, marginLeft: -12, borderRadius: 12 },
  times: { flexDirection: "row", justifyContent: "space-between" },
  time: { fontFamily: fonts.medium, fontSize: 14, color: colors.textSecondary, fontVariant: ["tabular-nums"] },
})
