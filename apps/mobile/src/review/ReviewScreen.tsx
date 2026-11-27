import type { Document, VoiceRef } from "@fama/contracts"
import { useLocalSearchParams, useRouter } from "expo-router"
import { useEffect, useMemo, useRef, useState } from "react"
import { ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Modal, ScrollView, StyleSheet, Text, TextInput, View } from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { Button, Icon, Tap } from "../components/ui"
import type { Api } from "../lib/api"
import { useEpisode, useLibrary } from "../lib/library"
import { useSettings } from "../lib/settings"
import { colors, fonts, radius, space } from "../theme"
import { Samples } from "./Samples"
import { editText, removeHeader, repeatedHeader, reviewDocument, startDocument, toggleChapter, type Review } from "./state"

export default function ReviewScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { api, account } = useSettings()
  return api && account ? <ReviewEpisode key={account.key + id} id={id} api={api} /> : null
}

function ReviewEpisode({ id, api }: { id: string; api: Api }) {
  const router = useRouter()
  const library = useLibrary()
  const episode = useEpisode(id)
  const [picked, setPicked] = useState<VoiceRef | undefined>(undefined)
  const selected = picked ?? episode?.voice ?? null
  const [review, setReview] = useState<Review | null>(null)
  const [error, setError] = useState("")
  const [attempt, setAttempt] = useState(0)
  const [editor, setEditor] = useState<number | null>(null)
  const locked = useRef(false)
  const voiceSaveChain = useRef<Promise<void>>(Promise.resolve())
  const latestPicked = useRef<VoiceRef | undefined>(undefined)
  useEffect(() => {
    let current = true
    setError("")
    api.document(id).then(
      doc => { if (current) setReview(reviewDocument(doc)) },
      (cause: unknown) => { if (current) setError(cause instanceof Error ? cause.message : "Could not load document.") },
    )
    return () => { current = false }
  }, [api, id, attempt])
  const header = useMemo(() => review && repeatedHeader(review.edited), [review?.edited])
  if (!review) return <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>{error ? <>
    <Text accessibilityRole="alert" style={styles.text}>{error}</Text>
    <Button title="Try again" onPress={() => setAttempt(attempt + 1)} />
  </> : <ActivityIndicator />}</ScrollView>

  const busy = review.operation !== "idle"
  const count = review.edited.chapters.length - review.excluded.size
  const run = async (operation: Review["operation"], action: () => Promise<void>) => {
    if (locked.current) return
    locked.current = true
    setReview({ ...review, operation })
    try { await action() }
    catch (cause) { Alert.alert("Review", cause instanceof Error ? cause.message : "Request failed") }
    finally {
      locked.current = false
      setReview(current => current && { ...current, operation: "idle" })
    }
  }
  const save = (doc: Document) => run("saving", async () => {
    await api.saveDocument(id, doc)
    setReview({ ...review, loaded: doc, edited: doc })
    setEditor(null)
  })
  const chooseVoice = (voice: VoiceRef) => {
    if (busy || voice === selected) return
    setPicked(voice)
    latestPicked.current = voice
    const speed = episode?.speed ?? 1
    voiceSaveChain.current = voiceSaveChain.current.then(async () => {
      if (latestPicked.current !== voice) return undefined
      try {
        await library.saveReviewVoice(id, voice, speed)
      } catch (cause) {
        if (latestPicked.current === voice) {
          Alert.alert("Voice", cause instanceof Error ? cause.message : "Could not save voice.")
        }
      }
      return undefined
    })
  }
  const start = () => run("starting", async () => {
    const doc = startDocument(review)
    if (!doc) return
    await library.start(id, doc, picked ?? null)
    router.dismissTo("/library")
  })
  const remove = () => Alert.alert("Delete episode?", review.edited.title, [
    { text: "Cancel", style: "cancel" },
    { text: "Delete", style: "destructive", onPress: () => void run("deleting", async () => {
      await library.remove(id)
      router.dismissTo("/library")
    }) },
  ])
  const chapter = editor === null ? null : review.edited.chapters[editor]
  return <>
    <FlatList
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
      data={review.edited.chapters}
      keyExtractor={(_, i) => String(i)}
      ListHeaderComponent={<View style={styles.section}>
        <Text accessibilityRole="header" style={styles.title}>{review.edited.title}</Text>
        {header && <Button variant="secondary" title="Remove repeated header" disabled={busy} onPress={() =>
          Alert.alert("Remove this line from all chapters?", header, [
            { text: "Cancel", style: "cancel" },
            { text: "Remove", onPress: () => void save(removeHeader(review.edited)) },
          ])} />}
      </View>}
      renderItem={({ item, index }) => {
        const title = item.title || `Chapter ${index + 1}`
        const kept = !review.excluded.has(index)
        return <View style={styles.row}>
          <Tap accessibilityRole="checkbox" accessibilityLabel={`Keep ${title}`} accessibilityState={{ checked: kept }}
            disabled={busy} style={styles.check} onPress={() => setReview(toggleChapter(review, index))}>
            <Icon name={kept ? "checkmark.circle.fill" : "circle"} color={kept ? colors.accent : colors.textSecondary} />
          </Tap>
          <Tap accessibilityRole="button" accessibilityLabel={`Edit ${title}`} disabled={busy} style={styles.edit} onPress={() => setEditor(index)}>
            <Text style={[styles.text, styles.flex]}>{title}</Text><Icon name="pencil" color={colors.textSecondary} size={18} />
          </Tap>
        </View>
      }}
      ListFooterComponent={<View style={styles.section}>
        <Samples id={id} api={api} selected={selected} onSelect={chooseVoice} />
        <Button title={`Start · ${count} ${count === 1 ? "chapter" : "chapters"}`} disabled={busy || count === 0} busy={review.operation === "starting"} onPress={start} />
        <Button variant="danger" title="Delete" disabled={busy} onPress={remove} />
      </View>}
    />
    {chapter && editor !== null && <ChapterEditor title={chapter.title || `Chapter ${editor + 1}`} initial={chapter.text} busy={busy}
      onCancel={() => setEditor(null)} onSave={text => void save(editText(review.edited, editor, text))} />}
  </>
}

function ChapterEditor({ title, initial, busy, onSave, onCancel }: {
  title: string; initial: string; busy: boolean; onSave: (text: string) => void; onCancel: () => void
}) {
  const [text, setText] = useState(initial)
  return <Modal visible animationType="slide" onRequestClose={() => { if (!busy) onCancel() }}>
    <SafeAreaView style={styles.page}>
      <KeyboardAvoidingView behavior="padding" style={styles.page}>
        <View style={styles.editor}>
          <Text accessibilityRole="header" style={styles.title}>{title}</Text>
          <TextInput accessibilityLabel="Chapter text" style={[styles.text, styles.input]} multiline value={text} editable={!busy} onChangeText={setText} />
          <View style={styles.actions}>
            <Button variant="secondary" title="Cancel" disabled={busy} style={styles.flex} onPress={onCancel} />
            <Button title="Save" busy={busy} style={styles.flex} onPress={() => onSave(text)} />
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  </Modal>
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  content: { padding: space.lg, gap: space.sm, paddingBottom: 100 },
  section: { gap: space.md, paddingVertical: space.md },
  title: { color: colors.text, fontFamily: fonts.bold, fontSize: 26 },
  text: { color: colors.text, fontFamily: fonts.regular, fontSize: 18 },
  row: { flexDirection: "row", alignItems: "center", backgroundColor: colors.surface, borderRadius: radius.md },
  check: { width: 48, minHeight: 52, alignItems: "center", justifyContent: "center" },
  edit: { flex: 1, flexDirection: "row", alignItems: "center", minHeight: 52, gap: space.sm, padding: space.md },
  flex: { flex: 1 },
  editor: { flex: 1, padding: space.lg, gap: space.md },
  input: { flex: 1, backgroundColor: colors.surface, borderRadius: radius.md, padding: space.md, textAlignVertical: "top" },
  actions: { flexDirection: "row", gap: space.sm },
})
