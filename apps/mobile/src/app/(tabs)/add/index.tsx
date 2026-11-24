import type { SourceInput, VoiceRef } from "@fama/contracts"
import * as Clipboard from "expo-clipboard"
import * as DocumentPicker from "expo-document-picker"
import * as Haptics from "expo-haptics"
import { useRouter } from "expo-router"
import { useEffect, useRef, useState } from "react"
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TextInput, View } from "react-native"
import { EpisodeOptions } from "../../../components/Options"
import { Button, Icon, Tap } from "../../../components/ui"
import * as Batch from "../../../lib/batch"
import { useLibrary } from "../../../lib/library"
import { useSettings } from "../../../lib/settings"
import { colors, fonts, radius, space } from "../../../theme"

type Mode = "Link" | "Text" | "File"
const MODES: ReadonlyArray<Mode> = ["Link", "Text", "File"]

const FILE_TYPES = ["application/pdf", "application/epub+zip", "text/plain", "text/markdown", "text/html"]

const isUrl = (value: string) => /^https?:\/\/\S+\.\S+$/i.test(value.trim())

export default function AddScreen() {
  const router = useRouter()
  const { api } = useSettings()
  const library = useLibrary()
  const [mode, setMode] = useState<Mode>("Link")
  const [link, setLink] = useState("")
  const [title, setTitle] = useState("")
  const [text, setText] = useState("")
  const [files, setFiles] = useState<Batch.Batch>([])
  const nextKey = useRef(0)
  const [voice, setVoice] = useState<VoiceRef | null>(null)
  const [speed, setSpeed] = useState(1)
  const [busy, setBusy] = useState(false)

  const sending = Batch.isSending(files)
  const ready = mode === "Link" ? isUrl(link) : mode === "Text" ? text.trim().length > 0 : Batch.hasAttached(files)

  // One upload at a time. Each answer moves the batch on, and the next pending file starts.
  useEffect(() => {
    const { batch, started } = Batch.startNext(files)
    if (!started) return
    setFiles(batch)
    library.upload(started.file, started.state.voice, started.state.speed).then(
      () => setFiles((current) => Batch.succeed(current, started.key)),
      (error: unknown) =>
        setFiles((current) => Batch.fail(current, started.key, error instanceof Error ? error.message : "Could not add")),
    )
  }, [files, library])

  // A batch that ends with every file sent goes to the Library. A failed or refused file keeps the user here.
  const wasSending = useRef(false)
  useEffect(() => {
    if (wasSending.current && !sending && files.length === 0) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
      router.navigate("/library")
    }
    wasSending.current = sending
  }, [sending, files.length, router])

  const create = async () => {
    if (mode === "File") {
      setFiles((current) => Batch.send(current, voice, speed))
      return
    }
    setBusy(true)
    try {
      const source: SourceInput =
        mode === "Link" ? { _tag: "Url", url: link.trim() } : { _tag: "Text", title: title.trim() || null, text: text.trim() }
      await library.create(source, voice, speed)
      if (mode === "Link") setLink("")
      else {
        setTitle("")
        setText("")
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
      router.navigate("/library")
    } catch (error) {
      Alert.alert("Could not add", error instanceof Error ? error.message : undefined)
    } finally {
      setBusy(false)
    }
  }

  const chooseFiles = async () => {
    const result = await DocumentPicker.getDocumentAsync({ type: FILE_TYPES, copyToCacheDirectory: true, multiple: true })
    if (result.canceled || result.assets.length === 0) return
    const picked = result.assets.map((asset) => ({ uri: asset.uri, name: asset.name, mimeType: asset.mimeType ?? null }))
    const firstKey = nextKey.current
    nextKey.current += picked.length
    setFiles((current) => Batch.attach(current, picked, firstKey))
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
        <View style={styles.linkRow}>
          <TextInput
            style={[styles.input, styles.linkInput]}
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
          {/* The system Paste button reads the clipboard without the iOS paste prompt: the tap is the permission. */}
          {link === "" && Clipboard.isPasteButtonAvailable ? (
            <Clipboard.ClipboardPasteButton
              style={styles.paste}
              acceptedContentTypes={["plain-text"]}
              displayMode="labelOnly"
              cornerStyle="capsule"
              backgroundColor={colors.surfaceRaised}
              foregroundColor={colors.text}
              onPress={(data) => {
                if (data.type === "text") setLink(data.text.trim())
              }}
            />
          ) : null}
        </View>
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
        files.length === 0 ? (
          <Tap style={styles.file} accessibilityRole="button" accessibilityLabel="Choose files" onPress={() => void chooseFiles()}>
            <Icon name="doc.badge.plus" size={28} />
            <Text style={styles.fileName}>Choose PDF, EPUB or text</Text>
          </Tap>
        ) : (
          <View style={styles.files}>
            {files.map((item) => (
              <FileRow
                key={item.key}
                item={item}
                onRetry={() => setFiles((current) => Batch.retry(current, item.key))}
                onRemove={() => setFiles((current) => Batch.remove(current, item.key))}
              />
            ))}
            <Tap style={styles.fileRow} accessibilityRole="button" accessibilityLabel="Choose files" onPress={() => void chooseFiles()}>
              <Icon name="plus" size={20} color={colors.accent} />
              <Text style={[styles.rowName, { color: colors.accent }]}>Choose files</Text>
            </Tap>
          </View>
        )
      ) : null}

      <EpisodeOptions voice={voice} speed={speed} onVoice={setVoice} onSpeed={setSpeed} />

      <Button title="Create" icon="waveform" busy={busy || (mode === "File" && sending)} disabled={!ready || !api} onPress={() => void create()} style={styles.create} />
    </ScrollView>
  )
}

/** One picked file: its name, where it is, and why it failed. */
function FileRow({ item, onRetry, onRemove }: { item: Batch.BatchFile; onRetry: () => void; onRemove: () => void }) {
  const { file, state } = item
  const reason = state._tag === "Failed" ? state.reason : state._tag === "Refused" ? "Unsupported type" : null
  return (
    <View style={styles.fileRow}>
      {state._tag === "Uploading" ? (
        <ActivityIndicator color={colors.textSecondary} style={styles.rowIcon} />
      ) : (
        <Icon
          name={state._tag === "Done" ? "checkmark" : reason ? "exclamationmark.triangle" : "doc"}
          size={20}
          color={reason ? colors.danger : colors.textSecondary}
        />
      )}
      <View style={styles.rowText}>
        <Text style={[styles.rowName, state._tag === "Pending" && { color: colors.textSecondary }]} numberOfLines={1}>
          {file.name}
        </Text>
        {reason ? (
          <Text style={styles.rowReason} numberOfLines={2} accessibilityRole="alert">
            {reason}
          </Text>
        ) : null}
      </View>
      {state._tag === "Failed" ? (
        <Tap style={styles.rowButton} accessibilityRole="button" accessibilityLabel={`Retry ${file.name}`} onPress={onRetry}>
          <Icon name="arrow.clockwise" size={18} />
        </Tap>
      ) : null}
      {state._tag === "Uploading" || state._tag === "Done" ? null : (
        <Tap style={styles.rowButton} accessibilityRole="button" accessibilityLabel={`Remove ${file.name}`} onPress={onRemove}>
          <Icon name="xmark" size={16} color={colors.textSecondary} />
        </Tap>
      )}
    </View>
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
  linkRow: { flexDirection: "row", alignItems: "center", borderRadius: radius.md, backgroundColor: colors.surface, paddingRight: space.sm },
  linkInput: { flex: 1, backgroundColor: "transparent" },
  paste: { width: 84, height: 36 },
  textGroup: { gap: space.sm },
  body: { minHeight: 220, paddingTop: space.lg, paddingBottom: space.lg, lineHeight: 24 },
  file: { minHeight: 120, borderRadius: radius.md, backgroundColor: colors.surface, alignItems: "center", justifyContent: "center", gap: space.sm, padding: space.lg },
  fileName: { fontFamily: fonts.medium, fontSize: 17, color: colors.text, textAlign: "center" },
  files: { borderRadius: radius.md, backgroundColor: colors.surface, paddingVertical: space.xs },
  fileRow: { minHeight: 52, flexDirection: "row", alignItems: "center", gap: space.md, paddingLeft: space.lg, paddingRight: space.xs },
  rowIcon: { width: 20 },
  rowText: { flex: 1, paddingVertical: space.sm },
  rowName: { fontFamily: fonts.medium, fontSize: 16, color: colors.text },
  rowReason: { fontFamily: fonts.regular, fontSize: 14, color: colors.danger },
  rowButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  create: { marginTop: space.sm },
})
