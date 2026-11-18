import type { SourceInput, VoiceRef } from "@fama/contracts"
import * as Haptics from "expo-haptics"
import { useRouter } from "expo-router"
import { useIncomingShare, type SharePayload } from "expo-sharing"
import { useState } from "react"
import { Alert, StyleSheet, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { EpisodeOptions } from "../components/Options"
import { Button, Icon } from "../components/ui"
import type { PickedFile } from "../lib/api"
import { useLibrary } from "../lib/library"
import { useSettings } from "../lib/settings"
import { colors, fonts, radius, space } from "../theme"

type Shared = { _tag: "Source"; source: SourceInput; label: string } | { _tag: "File"; file: PickedFile }

const fileName = (uri: string) => decodeURIComponent(uri.split("/").pop() ?? "file")

/** Picks the first usable item: a link, else a file, else text. */
function toShared(payloads: ReadonlyArray<SharePayload>): Shared | null {
  const url = payloads.find((p) => p.shareType === "url" && /^https?:/i.test(p.value))
  if (url) return { _tag: "Source", source: { _tag: "Url", url: url.value }, label: url.value }
  const file = payloads.find((p) => p.shareType === "file")
  if (file) return { _tag: "File", file: { uri: file.value, name: fileName(file.value), mimeType: file.mimeType ?? null } }
  const text = payloads.find((p) => p.shareType === "text" && p.value.trim() !== "")
  if (!text) return null
  const value = text.value.trim()
  // Some apps share a link as plain text.
  if (/^https?:\/\/\S+$/i.test(value)) return { _tag: "Source", source: { _tag: "Url", url: value }, label: value }
  return { _tag: "Source", source: { _tag: "Text", title: null, text: value }, label: value }
}

export default function ShareScreen() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { api } = useSettings()
  const library = useLibrary()
  const { sharedPayloads, clearSharedPayloads } = useIncomingShare()
  const [voice, setVoice] = useState<VoiceRef | null>(null)
  const [speed, setSpeed] = useState(1)
  const [busy, setBusy] = useState(false)
  const shared = toShared(sharedPayloads)

  const close = () => {
    clearSharedPayloads()
    router.dismissTo("/library")
  }

  const create = async () => {
    if (!shared) return
    setBusy(true)
    try {
      if (shared._tag === "File") await library.upload(shared.file, voice, speed)
      else await library.create(shared.source, voice, speed)
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
      close()
    } catch (error) {
      Alert.alert("Could not add", error instanceof Error ? error.message : undefined)
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={[styles.sheet, { paddingBottom: insets.bottom + space.lg }]}>
      {shared ? (
        <View style={styles.preview}>
          <Icon name={shared._tag === "File" ? "doc.fill" : shared.source._tag === "Url" ? "link" : "text.alignleft"} size={22} color={colors.accent} />
          <Text style={styles.previewText} numberOfLines={4}>
            {shared._tag === "File" ? shared.file.name : shared.label}
          </Text>
        </View>
      ) : (
        <Text style={styles.empty}>Nothing to add</Text>
      )}
      <EpisodeOptions voice={voice} speed={speed} onVoice={setVoice} onSpeed={setSpeed} />
      <View style={styles.actions}>
        <Button title="Cancel" variant="secondary" onPress={close} style={styles.action} />
        <Button title="Add" icon="waveform" busy={busy} disabled={!shared || !api} onPress={() => void create()} style={styles.action} />
      </View>
      {!api ? <Text style={styles.empty}>Connect a server in Settings first.</Text> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: colors.background, padding: space.lg, paddingTop: space.xl, gap: space.lg },
  preview: { flexDirection: "row", gap: space.md, padding: space.lg, borderRadius: radius.md, backgroundColor: colors.surface },
  previewText: { flex: 1, fontFamily: fonts.medium, fontSize: 17, lineHeight: 23, color: colors.text },
  empty: { fontFamily: fonts.medium, fontSize: 17, color: colors.textSecondary, textAlign: "center" },
  actions: { flexDirection: "row", gap: space.md },
  action: { flex: 1 },
})
