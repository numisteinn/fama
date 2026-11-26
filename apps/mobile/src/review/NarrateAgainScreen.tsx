import type { Voice } from "@fama/contracts"
import { useLocalSearchParams, usePreventRemove, useRouter } from "expo-router"
import { useEffect, useRef, useState } from "react"
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { NARRATION_SPEEDS, useVoices } from "../components/Options"
import { Button, Icon, Label, Tap } from "../components/ui"
import { ApiError, type Api } from "../lib/api"
import { speed as speedLabel } from "../lib/format"
import { useEpisode, useLibrary } from "../lib/library"
import { useSettings } from "../lib/settings"
import { colors, fonts, radius, space } from "../theme"
import {
  applyChapterText,
  canApplyVoice,
  canSaveText,
  describeNarrateAgainError,
  documentFailed,
  documentLoaded,
  hasTextEdits,
  hasVoiceEdits,
  initialNarrateAgain,
  isChapterEdited,
  isEditableJob,
  retryDocumentLoad,
  selectSpeed,
  selectVoice,
  syncEpisode,
  type Operation,
} from "./narrateAgain"

const voiceName = (voice: Voice) => `${voice.name} · ${voice.language}`

function pickAction(options: ReadonlyArray<string>, onPick: (index: number) => void) {
  ActionSheetIOS.showActionSheetWithOptions(
    { options: [...options, "Cancel"], cancelButtonIndex: options.length, userInterfaceStyle: "dark" },
    (index) => index < options.length && onPick(index),
  )
}

export default function NarrateAgainScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { api, account } = useSettings()
  return api && account && id ? <NarrateAgainEpisode key={account.key + id} id={id} api={api} /> : null
}

function NarrateAgainEpisode({ id, api }: { id: string; api: Api }) {
  const router = useRouter()
  const library = useLibrary()
  const episode = useEpisode(id)
  const voices = useVoices()
  const [state, setState] = useState(() => initialNarrateAgain(episode))
  const [attempt, setAttempt] = useState(0)
  const [editor, setEditor] = useState<number | null>(null)
  const locked = useRef(false)
  const leaving = useRef(false)
  const wasEditable = useRef(isEditableJob(episode?.job))

  useEffect(() => {
    setState((current) => syncEpisode(current, episode))
  }, [episode])

  // Reload the stored Document if the episode finishes narrating and returns to Ready/Failed while open without edits.
  const editableNow = isEditableJob(episode?.job)
  useEffect(() => {
    if (!wasEditable.current && editableNow && !hasTextEdits(state)) {
      setAttempt((n) => n + 1)
    }
    wasEditable.current = editableNow
  }, [editableNow, state])

  // Warn before leaving (back button or swipe) if there are unsaved chapter text edits.
  const dirtyText = hasTextEdits(state)
  const disablePrevention = usePreventRemove(dirtyText && state.operation === "idle", ({ repeat }) => {
    if (leaving.current) {
      disablePrevention()
      repeat()
      return
    }
    Alert.alert("Discard unsaved text edits?", "Your chapter text changes have not been saved yet.", [
      { text: "Keep editing", style: "cancel" },
      {
        text: "Discard",
        style: "destructive",
        onPress: () => {
          leaving.current = true
          disablePrevention()
          repeat()
        },
      },
    ])
  })

  useEffect(() => {
    let current = true
    api.document(id).then(
      (doc) => {
        if (current) setState((prev) => documentLoaded(prev, doc))
      },
      (cause: unknown) => {
        if (!current) return
        const status = cause instanceof ApiError ? cause.status : null
        const message = cause instanceof Error ? cause.message : "Could not load document."
        setState((prev) => documentFailed(prev, status, message))
      },
    )
    return () => {
      current = false
    }
  }, [api, id, attempt])

  const leave = () => {
    leaving.current = true
    disablePrevention()
    if (router.canDismiss()) router.dismissTo("/library")
    else router.navigate("/library")
  }

  const run = async (operation: Operation, action: () => Promise<void>) => {
    if (locked.current) return
    locked.current = true
    setState((current) => ({ ...current, operation }))
    try {
      await action()
    } catch (cause) {
      const status = cause instanceof ApiError ? cause.status : null
      if (status === 409 || status === 404) void library.refresh()
      const fallback = cause instanceof Error ? cause.message : "Request failed"
      Alert.alert("Narrate again", describeNarrateAgainError(status, fallback))
    } finally {
      locked.current = false
      setState((current) => ({ ...current, operation: "idle" }))
    }
  }

  const submitDocument = () => {
    if (state.document._tag !== "Ready") return
    const edited = state.document.edited
    void run("savingDocument", async () => {
      await library.saveDocument(id, edited)
      leave()
    })
  }

  const submitVoice = () => {
    const { voice, speed } = state
    if (voice === null) return
    void run("changingVoice", async () => {
      await library.changeVoice(id, voice, speed)
      leave()
    })
  }

  const onSaveText = () => {
    if (hasVoiceEdits(state, episode)) {
      Alert.alert("Save chapter text only?", "Saving chapter text queues narration with the current voice and speed.", [
        { text: "Cancel", style: "cancel" },
        { text: "Save text", onPress: submitDocument },
      ])
      return
    }
    submitDocument()
  }

  const onApplyVoice = () => {
    if (hasTextEdits(state)) {
      Alert.alert("Discard unsaved text edits?", "Applying voice and speed queues narration without your unsaved text changes.", [
        { text: "Cancel", style: "cancel" },
        { text: "Apply", style: "destructive", onPress: submitVoice },
      ])
      return
    }
    submitVoice()
  }

  const busy = state.operation !== "idle"
  const editable = isEditableJob(episode?.job)
  const title = episode?.title ?? (state.document._tag === "Ready" ? state.document.loaded.title : "")
  const currentVoice = voices.find((voice) => voice.id === state.voice)
  const voiceDisplay = currentVoice ? voiceName(currentVoice) : (state.voice ?? "Choose voice")
  const speedDisplay = speedLabel(state.speed)
  const activeChapter = editor !== null && state.document._tag === "Ready" ? state.document.edited.chapters[editor] : undefined

  return (
    <>
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
        {title ? (
          <Text accessibilityRole="header" style={styles.title}>
            {title}
          </Text>
        ) : null}

        {episode && !editable && !leaving.current ? (
          <View style={styles.card}>
            <Text accessibilityRole="alert" style={styles.note}>
              This episode is being narrated. Wait until it finishes to edit again.
            </Text>
          </View>
        ) : null}

        <View style={styles.section}>
          <Label>Chapters</Label>
          {state.document._tag === "Loading" ? (
            <View style={[styles.card, styles.centered]}>
              <ActivityIndicator color={colors.textSecondary} />
            </View>
          ) : state.document._tag === "Missing" ? (
            <View style={styles.card}>
              <Text style={styles.note}>
                Chapter text is unavailable for this episode. You can still narrate again with a different voice or speed below.
              </Text>
            </View>
          ) : state.document._tag === "Failed" ? (
            <View style={styles.card}>
              <Text accessibilityRole="alert" style={styles.note}>
                {state.document.message}
              </Text>
              <Button
                variant="secondary"
                title="Try again"
                disabled={busy}
                onPress={() => {
                  setState((current) => retryDocumentLoad(current))
                  setAttempt((n) => n + 1)
                }}
              />
            </View>
          ) : (
            <>
              <View style={styles.group}>
                {state.document.edited.chapters.map((chapter, index) => {
                  const chapterTitle = chapter.title || `Chapter ${index + 1}`
                  const edited = state.document._tag === "Ready" && isChapterEdited(state.document, index)
                  return (
                    <View key={index}>
                      {index > 0 ? <View style={styles.separator} /> : null}
                      <Tap
                        accessibilityRole="button"
                        accessibilityLabel={edited ? `Edit ${chapterTitle}, edited` : `Edit ${chapterTitle}`}
                        disabled={busy || !editable}
                        style={styles.chapterRow}
                        onPress={() => setEditor(index)}
                      >
                        <Text style={styles.chapterIndex}>{index + 1}</Text>
                        <Text style={[styles.rowLabel, styles.flex]} numberOfLines={2}>
                          {chapterTitle}
                        </Text>
                        {edited ? <Text style={styles.editedBadge}>Edited</Text> : null}
                        <Icon name="pencil" color={edited ? colors.accent : colors.textSecondary} size={18} />
                      </Tap>
                    </View>
                  )
                })}
              </View>
              <Button
                title="Save chapter text"
                disabled={!canSaveText(state, episode?.job)}
                busy={state.operation === "savingDocument"}
                onPress={onSaveText}
              />
            </>
          )}
        </View>

        <View style={styles.section}>
          <Label>Voice & speed</Label>
          <View style={styles.group}>
            <Tap
              style={styles.optionRow}
              accessibilityRole="button"
              accessibilityLabel={`Voice, ${voiceDisplay}`}
              disabled={busy || !editable || voices.length === 0}
              onPress={() =>
                pickAction(voices.map(voiceName), (index) => {
                  const chosen = voices[index]
                  if (chosen) setState((current) => selectVoice(current, chosen.id))
                })
              }
            >
              <Text style={styles.rowLabel}>Voice</Text>
              <Text style={styles.rowValue} numberOfLines={1}>
                {voiceDisplay}
              </Text>
              <Icon name="chevron.up.chevron.down" size={14} color={colors.textTertiary} />
            </Tap>
            <View style={styles.separator} />
            <Tap
              style={styles.optionRow}
              accessibilityRole="button"
              accessibilityLabel={`Speed, ${speedDisplay}`}
              disabled={busy || !editable}
              onPress={() =>
                pickAction(NARRATION_SPEEDS.map(speedLabel), (index) => {
                  const chosen = NARRATION_SPEEDS[index]
                  if (chosen !== undefined) setState((current) => selectSpeed(current, chosen))
                })
              }
            >
              <Text style={styles.rowLabel}>Speed</Text>
              <Text style={styles.rowValue} numberOfLines={1}>
                {speedDisplay}
              </Text>
              <Icon name="chevron.up.chevron.down" size={14} color={colors.textTertiary} />
            </Tap>
          </View>
          <Button
            title="Apply voice & speed"
            disabled={!canApplyVoice(state, episode)}
            busy={state.operation === "changingVoice"}
            onPress={onApplyVoice}
          />
        </View>
      </ScrollView>

      {activeChapter !== undefined && editor !== null ? (
        <ChapterEditor
          title={activeChapter.title || `Chapter ${editor + 1}`}
          initial={activeChapter.text}
          onCancel={() => setEditor(null)}
          onDone={(text) => {
            setState((current) => applyChapterText(current, editor, text))
            setEditor(null)
          }}
        />
      ) : null}
    </>
  )
}

function ChapterEditor({
  title,
  initial,
  onDone,
  onCancel,
}: {
  title: string
  initial: string
  onDone(text: string): void
  onCancel(): void
}) {
  const [text, setText] = useState(initial)
  return (
    <Modal visible animationType="slide" onRequestClose={onCancel}>
      <SafeAreaView style={styles.page}>
        <KeyboardAvoidingView behavior="padding" style={styles.page}>
          <View style={styles.editor}>
            <Text accessibilityRole="header" style={styles.title}>
              {title}
            </Text>
            <TextInput
              accessibilityLabel="Chapter text"
              style={[styles.editorText, styles.input]}
              multiline
              value={text}
              onChangeText={setText}
              selectionColor={colors.accent}
            />
            <View style={styles.actions}>
              <Button variant="secondary" title="Cancel" style={styles.flex} onPress={onCancel} />
              <Button title="Done" style={styles.flex} onPress={() => onDone(text)} />
            </View>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  )
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  content: { padding: space.lg, gap: space.xl, paddingBottom: 120 },
  section: { gap: space.md },
  title: { color: colors.text, fontFamily: fonts.bold, fontSize: 26 },
  card: { backgroundColor: colors.surface, borderRadius: radius.md, padding: space.lg, gap: space.md },
  centered: { alignItems: "center", justifyContent: "center", minHeight: 80 },
  note: { color: colors.textSecondary, fontFamily: fonts.regular, fontSize: 16, lineHeight: 22 },
  group: { backgroundColor: colors.surface, borderRadius: radius.md },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.separator, marginLeft: space.lg },
  chapterRow: { minHeight: 54, flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.sm },
  chapterIndex: { width: 24, fontFamily: fonts.medium, fontSize: 15, color: colors.textTertiary, fontVariant: ["tabular-nums"] },
  editedBadge: { fontFamily: fonts.bold, fontSize: 13, color: colors.accent },
  optionRow: { minHeight: 52, flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.lg },
  rowLabel: { fontFamily: fonts.medium, fontSize: 17, color: colors.text },
  rowValue: { flex: 1, textAlign: "right", fontFamily: fonts.regular, fontSize: 17, color: colors.textSecondary },
  flex: { flex: 1 },
  editor: { flex: 1, padding: space.lg, gap: space.md },
  editorText: { color: colors.text, fontFamily: fonts.regular, fontSize: 18, lineHeight: 26 },
  input: { flex: 1, backgroundColor: colors.surface, borderRadius: radius.md, padding: space.md, textAlignVertical: "top" },
  actions: { flexDirection: "row", gap: space.sm },
})
