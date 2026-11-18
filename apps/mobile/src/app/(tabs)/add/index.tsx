import type { SourceInput, VoiceRef } from "@fama/contracts"
import * as Clipboard from "expo-clipboard"
import * as DocumentPicker from "expo-document-picker"
import * as Haptics from "expo-haptics"
import { useFocusEffect, useRouter } from "expo-router"
import { useCallback, useState } from "react"
import { Alert, ScrollView, StyleSheet, Text, TextInput, View } from "react-native"
import { EpisodeOptions } from "../../../components/Options"
import { Button, Icon, Tap } from "../../../components/ui"
import type { PickedFile } from "../../../lib/api"
import { useLibrary } from "../../../lib/library"
import { useSettings } from "../../../lib/settings"
import { colors, fonts, radius, space } from "../../../theme"

type Mode = "Link" | "Text" | "File"
const MODES: ReadonlyArray<Mode> = ["Link", "Text", "File"]

const FILE_TYPES = ["application/pdf", "application/epub+zip", "text/plain", "text/markdown", "text/html"]

const isUrl = (value: string) => /^https?:\/\/\S+\.\S+$/i.test(value.trim())

/** A link on the clipboard, copied as a URL or as plain text. Checks first, so no paste prompt without a candidate. */
async function clipboardLink(): Promise<string | null> {
  if (await Clipboard.hasUrlAsync()) {
    const url = await Clipboard.getUrlAsync()
    if (url && isUrl(url)) return url
  }
  if (await Clipboard.hasStringAsync()) {
    const text = (await Clipboard.getStringAsync()).trim()
    if (isUrl(text)) return text
  }
  return null
}

export default function AddScreen() {
  const router = useRouter()
  const { api } = useSettings()
  const library = useLibrary()
  const [mode, setMode] = useState<Mode>("Link")
  const [link, setLink] = useState("")
  const [title, setTitle] = useState("")
  const [text, setText] = useState("")
  const [file, setFile] = useState<PickedFile | null>(null)
  const [voice, setVoice] = useState<VoiceRef | null>(null)
  const [speed, setSpeed] = useState(1)
  const [busy, setBusy] = useState(false)

  // A link on the clipboard fills an empty field.
  useFocusEffect(
    useCallback(() => {
      if (link !== "") return
      void clipboardLink().then((url) => {
        if (url) setLink((current) => (current === "" ? url : current))
      })
    }, [link]),
  )

  const ready = mode === "Link" ? isUrl(link) : mode === "Text" ? text.trim().length > 0 : file !== null

  const create = async () => {
    setBusy(true)
    try {
      if (mode === "File" && file) {
        await library.upload(file, voice, speed)
        setFile(null)
      } else {
        const source: SourceInput =
          mode === "Link" ? { _tag: "Url", url: link.trim() } : { _tag: "Text", title: title.trim() || null, text: text.trim() }
        await library.create(source, voice, speed)
        if (mode === "Link") setLink("")
        else {
          setTitle("")
          setText("")
        }
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
      router.navigate("/library")
    } catch (error) {
      Alert.alert("Could not add", error instanceof Error ? error.message : undefined)
    } finally {
      setBusy(false)
    }
  }

  const chooseFile = async () => {
    const result = await DocumentPicker.getDocumentAsync({ type: FILE_TYPES, copyToCacheDirectory: true })
    const asset = result.canceled ? null : result.assets[0]
    if (asset) setFile({ uri: asset.uri, name: asset.name, mimeType: asset.mimeType ?? null })
  }

  return (
    <ScrollView
      style={styles.screen}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      contentContainerStyle={styles.content}
    >
      <View style={styles.segments} accessibilityRole="tablist">
        {MODES.map((value) => (
          <Tap
            key={value}
            style={[styles.segment, value === mode && styles.segmentOn]}
            accessibilityRole="tab"
            accessibilityState={{ selected: value === mode }}
            onPress={() => setMode(value)}
          >
            <Text style={[styles.segmentText, value === mode && styles.segmentTextOn]}>{value}</Text>
          </Tap>
        ))}
      </View>

      {mode === "Link" ? (
        <TextInput
          style={styles.input}
          value={link}
          onChangeText={setLink}
          placeholder="https://"
          placeholderTextColor={colors.textTertiary}
          keyboardType="url"
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
          returnKeyType="go"
          onSubmitEditing={() => ready && void create()}
          selectionColor={colors.accent}
          accessibilityLabel="Link"
        />
      ) : null}

      {mode === "Text" ? (
        <View style={styles.textGroup}>
          <TextInput
            style={styles.input}
            value={title}
            onChangeText={setTitle}
            placeholder="Title"
            placeholderTextColor={colors.textTertiary}
            selectionColor={colors.accent}
            accessibilityLabel="Title"
          />
          <TextInput
            style={[styles.input, styles.body]}
            value={text}
            onChangeText={setText}
            placeholder="Paste text"
            placeholderTextColor={colors.textTertiary}
            multiline
            textAlignVertical="top"
            selectionColor={colors.accent}
            accessibilityLabel="Text"
          />
        </View>
      ) : null}

      {mode === "File" ? (
        <Tap style={styles.file} accessibilityRole="button" accessibilityLabel={file ? `File ${file.name}. Choose another` : "Choose file"} onPress={() => void chooseFile()}>
          <Icon name={file ? "doc.fill" : "doc.badge.plus"} size={28} color={file ? colors.accent : colors.text} />
          <Text style={styles.fileName} numberOfLines={2}>
            {file ? file.name : "Choose PDF, EPUB or text"}
          </Text>
        </Tap>
      ) : null}

      <EpisodeOptions voice={voice} speed={speed} onVoice={setVoice} onSpeed={setSpeed} />

      <Button title="Create" icon="waveform" busy={busy} disabled={!ready || !api} onPress={() => void create()} style={styles.create} />
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: space.lg, gap: space.lg, paddingBottom: 120 },
  segments: { flexDirection: "row", backgroundColor: colors.surface, borderRadius: radius.md, padding: 4 },
  segment: { flex: 1, minHeight: 44, borderRadius: radius.sm, alignItems: "center", justifyContent: "center" },
  segmentOn: { backgroundColor: colors.surfaceRaised },
  segmentText: { fontFamily: fonts.medium, fontSize: 16, color: colors.textSecondary },
  segmentTextOn: { color: colors.text, fontFamily: fonts.bold },
  input: {
    minHeight: 56,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    paddingHorizontal: space.lg,
    fontFamily: fonts.regular,
    fontSize: 17,
    color: colors.text,
  },
  textGroup: { gap: space.sm },
  body: { minHeight: 220, paddingTop: space.lg, paddingBottom: space.lg, lineHeight: 24 },
  file: { minHeight: 120, borderRadius: radius.md, backgroundColor: colors.surface, alignItems: "center", justifyContent: "center", gap: space.sm, padding: space.lg },
  fileName: { fontFamily: fonts.medium, fontSize: 17, color: colors.text, textAlign: "center" },
  create: { marginTop: space.sm },
})
