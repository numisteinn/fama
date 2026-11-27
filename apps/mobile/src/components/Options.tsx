import type { Voice, VoiceRef } from "@fama/contracts"
import { useEffect, useState } from "react"
import { ActionSheetIOS, StyleSheet, Text, View } from "react-native"
import { speed as speedLabel } from "../lib/format"
import { useSettings } from "../lib/settings"
import { colors, fonts, radius, space } from "../theme"
import { Icon, Tap } from "./ui"

export const NARRATION_SPEEDS = [0.75, 1, 1.25, 1.5] as const

export function useVoices(): ReadonlyArray<Voice> {
  const { api } = useSettings()
  const [voices, setVoices] = useState<ReadonlyArray<Voice>>([])
  useEffect(() => {
    if (!api) return
    let live = true
    api.listVoices().then((list) => live && setVoices(list), () => {})
    return () => {
      live = false
    }
  }, [api])
  return voices
}

const voiceName = (voice: Voice) => `${voice.name} · ${voice.language}`

function pick(options: ReadonlyArray<string>, onPick: (index: number) => void) {
  ActionSheetIOS.showActionSheetWithOptions(
    { options: [...options, "Cancel"], cancelButtonIndex: options.length, userInterfaceStyle: "dark" },
    (index) => index < options.length && onPick(index),
  )
}

/** Voice and narration speed for a new episode. Voice null means Auto: the worker picks by language. */
export function EpisodeOptions(props: {
  voice: VoiceRef | null
  speed: number
  onVoice: (voice: VoiceRef | null) => void
  onSpeed: (speed: number) => void
}) {
  const voices = useVoices()
  const current = voices.find((voice) => voice.id === props.voice)
  return (
    <View style={styles.group}>
      <Row
        label="Voice"
        value={current ? voiceName(current) : "Auto"}
        onPress={() => pick(["Auto", ...voices.map(voiceName)], (index) => props.onVoice(index === 0 ? null : (voices[index - 1]?.id ?? null)))}
      />
      <View style={styles.separator} />
      <Row
        label="Speed"
        value={speedLabel(props.speed)}
        onPress={() => pick(NARRATION_SPEEDS.map(speedLabel), (index) => props.onSpeed(NARRATION_SPEEDS[index] ?? 1))}
      />
    </View>
  )
}

function Row({ label, value, onPress }: { label: string; value: string; onPress: () => void }) {
  return (
    <Tap style={styles.row} accessibilityRole="button" accessibilityLabel={`${label}, ${value}`} onPress={onPress}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue} numberOfLines={1}>
        {value}
      </Text>
      <Icon name="chevron.up.chevron.down" size={14} color={colors.textTertiary} />
    </Tap>
  )
}

const styles = StyleSheet.create({
  group: { backgroundColor: colors.surface, borderRadius: radius.md },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.separator, marginLeft: space.lg },
  row: { minHeight: 52, flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.lg },
  rowLabel: { fontFamily: fonts.medium, fontSize: 17, color: colors.text },
  rowValue: { flex: 1, textAlign: "right", fontFamily: fonts.regular, fontSize: 17, color: colors.textSecondary },
})
