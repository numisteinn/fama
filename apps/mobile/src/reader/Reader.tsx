import type { Episode } from "@fama/contracts"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from "react-native"
import { Icon, Tap } from "../components/ui"
import { FamaPlayer, type NativeStatus } from "../player/native"
import { player } from "../player/player"
import { colors, fonts, radius, space } from "../theme"
import { type Follow, followNext, showsBackToNow } from "./follow"
import { lineOf, markAt, openingRow, rowsOf, seekTargetMs, type Row } from "./text"
import { useReaderText } from "./useReaderText"

export function Reader({ episode, status }: { episode: Episode; status: NativeStatus }) {
  const { text, dispatch } = useReaderText(episode, status.index)
  const rows = useMemo(() => rowsOf(episode.chapters, text), [episode.chapters, text])
  const mark = markAt(episode.chapters, text, { index: status.index, positionMs: status.position * 1000 })
  const chapter = mark?.chapter
  const segment = mark?.segment
  const current = useMemo(
    () => openingRow(rows, chapter === undefined || segment === undefined ? null : { chapter, segment }, status.index),
    [rows, chapter, segment, status.index],
  )
  const list = useRef<FlatList<Row>>(null)
  const [follow, setFollow] = useState<Follow>("following")
  // A tap on "Back to now" asks for one smooth jump; the follow effect reads and clears it.
  const smooth = useRef(false)
  const [retry, setRetry] = useState(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const lines = useRef(new Map<string, readonly { text: string; y: number }[]>())
  const [layoutVersion, setLayoutVersion] = useState(0)

  useEffect(() => {
    void FamaPlayer.setStatusInterval?.(0.075)
    return () => {
      clearTimeout(timer.current)
      void FamaPlayer.setStatusInterval?.(0.5)
    }
  }, [])

  useEffect(() => {
    const animated = smooth.current
    smooth.current = false
    if (follow !== "following" || !rows[current]) return
    const row = rows[current]
    const layout = lines.current.get(row.key)
    const state = text.chapters[row.chapter]
    const y =
      row._tag === "Paragraph" && layout && state?._tag === "Loaded" && segment !== undefined
        ? (layout[lineOf(state.segments, row.first, segment, layout)]?.y ?? 0)
        : 0
    list.current?.scrollToIndex({ index: current, viewOffset: -y, animated })
  }, [current, segment, rows, follow, retry, text, layoutVersion])

  const render = useCallback(
    ({ item }: { item: Row }) => {
      const pick = (index: number) => {
        const target = seekTargetMs(episode.chapters, text, { chapter: item.chapter, segment: index })
        if (target !== null) {
          player.seek(target / 1000, true)
          setFollow(followNext({ _tag: "SentenceTap" }))
        }
      }
      if (item._tag === "Heading") {
        const spoken = item.segment
        return (
          <Text
            accessibilityRole="header"
            style={[styles.heading, spoken !== null && item.chapter === chapter && spoken === segment && styles.mark]}
            onPress={spoken === null ? undefined : () => pick(spoken)}
          >
            {item.title}
          </Text>
        )
      }
      if (item._tag === "Failed")
        return (
          <Text
            accessibilityRole="button"
            style={styles.heading}
            onPress={() => dispatch({ _tag: "Retry", index: item.chapter })}
          >
            Retry
          </Text>
        )
      if (item._tag === "Pending") return <ActivityIndicator />
      const state = text.chapters[item.chapter]
      if (state?._tag !== "Loaded") return null
      const sentences = state.segments.slice(item.first, item.last + 1)
      return (
        <Text
          style={styles.paragraph}
          accessibilityActions={sentences.map((s, i) => ({ name: String(i), label: s.text }))}
          onAccessibilityAction={(event) => {
            const offset = Number(event.nativeEvent.actionName)
            if (Number.isInteger(offset) && sentences[offset]) pick(item.first + offset)
          }}
          onTextLayout={({ nativeEvent }) => {
            const old = lines.current.get(item.key)
            const next = nativeEvent.lines
            if (old?.length === next.length && next.every((l, i) => old[i]?.text === l.text && old[i].y === l.y))
              return
            lines.current.set(item.key, next)
            if (item.key === rows[current]?.key) setLayoutVersion((v) => v + 1)
          }}
        >
          {sentences.map((s, offset) => {
            const index = item.first + offset
            const selected = item.chapter === chapter && index === segment
            return (
              <Text
                key={index}
                accessibilityRole="link"
                accessibilityState={{ selected }}
                onPress={() => pick(index)}
                style={selected && styles.mark}
              >
                {offset ? " " : ""}
                {s.text}
              </Text>
            )
          })}
        </Text>
      )
    },
    [chapter, segment, current, rows, episode.chapters, text, dispatch],
  )

  return (
    <View style={styles.reader}>
      <FlatList
        ref={list}
        data={rows}
        renderItem={render}
        keyExtractor={rowKey}
        windowSize={5}
        contentContainerStyle={styles.listContent}
        onScrollBeginDrag={() => setFollow(followNext({ _tag: "DragStart" }))}
        onScrollToIndexFailed={({ index, averageItemLength }) => {
          list.current?.scrollToOffset({ offset: averageItemLength * index, animated: false })
          clearTimeout(timer.current)
          timer.current = setTimeout(() => setRetry((v) => v + 1), 80)
        }}
      />
      {showsBackToNow(follow) && (
        <Tap
          accessibilityRole="button"
          accessibilityLabel="Back to now"
          onPress={() => {
            smooth.current = true
            setFollow(followNext({ _tag: "BackToNow" }))
          }}
          style={styles.follow}
        >
          <Icon name="arrow.down" size={16} color={colors.accent} />
          <Text style={styles.action}>Back to now</Text>
        </Tap>
      )}
    </View>
  )
}

const rowKey = (item: Row) => item.key

const styles = StyleSheet.create({
  reader: { flex: 1, alignSelf: "stretch" },
  listContent: { paddingBottom: 64 },
  paragraph: { fontFamily: fonts.regular, color: colors.text, fontSize: 18, lineHeight: 26, marginBottom: space.md },
  heading: { fontFamily: fonts.bold, color: colors.text, fontSize: 22, marginVertical: space.md },
  mark: { backgroundColor: colors.accent, color: colors.onAccent },
  follow: {
    position: "absolute",
    bottom: space.md,
    alignSelf: "center",
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceRaised,
  },
  action: { color: colors.accent, fontFamily: fonts.bold, fontSize: 15 },
})
