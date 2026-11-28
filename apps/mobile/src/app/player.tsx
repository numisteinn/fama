import type { Episode } from "@fama/contracts"
import * as Haptics from "expo-haptics"
import { useRouter } from "expo-router"
import { memo, useState } from "react"
import { ActionSheetIOS, ActivityIndicator, Alert, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Artwork } from "../components/Artwork"
import { Scrubber } from "../components/Scrubber"
import { Icon, Tap } from "../components/ui"
import { useDownloads } from "../lib/downloads"
import { clock, jobLabel, speed } from "../lib/format"
import { useEpisode } from "../lib/library"
import { RouteButton } from "../player/native"
import { isWaiting, player, usePlayerStatus } from "../player/player"
import { sleepTimer, type SleepTimerMode, type SleepTimerPreset, useSleepTimer } from "../player/sleepTimer"
import { Reader } from "../reader/Reader"
import { hasText } from "../reader/text"
import { colors, fonts, radius, space, SPEEDS } from "../theme"

export default function PlayerScreen() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { width } = useWindowDimensions()
  const status = usePlayerStatus()
  const episode = useEpisode(status.episodeId)
  const timer = useSleepTimer(status, episode, { pause: () => player.pause(), seek: (position) => player.seek(position) })
  const [panel, setPanel] = useState<"art" | "reader" | "chapters">("art")
  const reading = panel === "reader"
  const showChapters = panel === "chapters"
  const [stageHeight, setStageHeight] = useState(0)

  if (!episode) {
    return (
      <View style={[styles.screen, { paddingTop: space.md }]}>
        <Tap style={styles.iconButton} accessibilityLabel="Close" onPress={() => router.back()}>
          <Icon name="chevron.down" size={24} />
        </Tap>
      </View>
    )
  }

  const canRead = hasText(episode)
  const marks = chapterStarts(episode).slice(1)
  // The artwork takes what the controls leave, up to the screen width.
  const art = Math.max(0, Math.min(width - space.xl * 2, stageHeight - space.lg * 2))

  return (
    <View style={[styles.screen, { paddingTop: space.md, paddingBottom: insets.bottom + space.md }]}>
      <View style={styles.topBar}>
        <Tap style={styles.iconButton} accessibilityRole="button" accessibilityLabel="Close player" onPress={() => router.back()}>
          <Icon name="chevron.down" size={24} />
        </Tap>
        {canRead && (
          <Tap style={styles.iconButton} accessibilityRole="button" accessibilityLabel={reading ? "Close reader" : "Read along"}
            accessibilityState={{ selected: reading }} onPress={() => setPanel(reading ? "art" : "reader")}>
            <Icon name="book" color={reading ? colors.accent : colors.text} />
          </Tap>
        )}
        <NarrateAgainButton episode={episode} onPress={() => {
          router.dismiss()
          router.navigate({ pathname: "/library/narrate-again", params: { id: episode.id } })
        }} />
        <Tap
          style={[styles.iconButton, showChapters && styles.iconButtonOn]}
          accessibilityRole="button"
          accessibilityLabel={showChapters ? "Hide chapters" : "Chapters"}
          accessibilityState={{ selected: showChapters }}
          onPress={() => setPanel(showChapters ? "art" : "chapters")}
        >
          <Icon name="list.bullet" size={22} color={showChapters ? colors.onAccent : colors.text} />
        </Tap>
      </View>

      <View style={styles.stage} onLayout={(event) => setStageHeight(event.nativeEvent.layout.height)}>
        {reading && canRead ? (
          <Reader key={episode.id} episode={episode} status={status} />
        ) : showChapters ? (
          <Chapters episode={episode} current={status.index} onPick={(start) => player.seek(start)} />
        ) : (
          art > 0 ? <Artwork episode={episode} size={art} rounded={radius.lg} /> : null
        )}
      </View>

      <EpisodeInfo episode={episode} index={status.index} />

      <Scrubber position={status.position} duration={status.duration} marks={marks} onSeek={(position) => player.seek(position)} />

      <View style={styles.transport}>
        <Tap style={styles.skip} accessibilityRole="button" accessibilityLabel="Back 15 seconds" onPress={() => player.skip(-15)}>
          <Icon name="gobackward.15" size={40} weight="regular" />
        </Tap>
        <Tap
          style={styles.play}
          accessibilityRole="button"
          accessibilityLabel={status.playing ? "Pause" : "Play"}
          onPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
            player.toggle()
          }}
        >
          {isWaiting(status, episode) ? (
            <ActivityIndicator size="large" color={colors.onAccent} />
          ) : (
            <Icon name={status.playing ? "pause.fill" : "play.fill"} size={44} color={colors.onAccent} weight="bold" />
          )}
        </Tap>
        <Tap style={styles.skip} accessibilityRole="button" accessibilityLabel="Forward 30 seconds" onPress={() => player.skip(30)}>
          <Icon name="goforward.30" size={40} weight="regular" />
        </Tap>
      </View>

      <View style={styles.tools}>
        <SpeedButton rate={status.rate} />
        <SleepTimerButton mode={timer.mode} remaining={timer.remaining} status={status} />
        <View style={styles.tool}>
          <RouteButton style={styles.route} tint={colors.text} activeTint={colors.accent} />
        </View>
        <DownloadButton episode={episode} />
      </View>
    </View>
  )
}

function chapterStarts(episode: Episode): number[] {
  let sum = 0
  return episode.chapters.map((chapter) => {
    const start = sum
    sum += chapter.durationMs / 1000
    return start
  })
}

function NarrateAgainButton({ episode, onPress }: { episode: Episode; onPress: () => void }) {
  if (episode.job._tag !== "Ready" && episode.job._tag !== "Failed") return null
  return (
    <Tap style={styles.iconButton} accessibilityRole="button" accessibilityLabel="Narrate again" onPress={onPress}>
      <Icon name="pencil" size={20} />
    </Tap>
  )
}

function EpisodeInfo({ episode, index }: { episode: Episode; index: number }) {
  const chapter = episode.chapters[index]
  return (
    <View style={styles.info}>
      <Text style={styles.title} numberOfLines={2}>
        {episode.title}
      </Text>
      {episode.chapters.length > 1 && chapter ? (
        <Text style={styles.chapter} numberOfLines={1}>
          {`${index + 1}/${episode.chapters.length} · ${chapter.title}`}
        </Text>
      ) : episode.author ? (
        <Text style={styles.chapter} numberOfLines={1}>
          {episode.author}
        </Text>
      ) : null}
      {episode.job._tag === "Running" || episode.job._tag === "Queued" ? (
        <View style={styles.job}>
          <Icon name="waveform" size={14} color={colors.accent} />
          <Text style={styles.jobText}>{jobLabel(episode.job)}</Text>
        </View>
      ) : null}
    </View>
  )
}

function Chapters({ episode, current, onPick }: { episode: Episode; current: number; onPick: (start: number) => void }) {
  const starts = chapterStarts(episode)
  return (
    <ScrollView style={styles.chapters} contentContainerStyle={{ paddingVertical: space.sm }}>
      {episode.chapters.map((chapter, index) => {
        const on = index === current
        return (
          <Tap key={chapter.index} style={styles.chapterRow} accessibilityRole="button" accessibilityState={{ selected: on }} onPress={() => onPick(starts[index] ?? 0)}>
            <Text style={[styles.chapterIndex, on && styles.on]}>{index + 1}</Text>
            <Text style={[styles.chapterTitle, on && styles.on]} numberOfLines={2}>
              {chapter.title}
            </Text>
            <Text style={styles.chapterTime}>{clock(chapter.durationMs / 1000)}</Text>
          </Tap>
        )
      })}
    </ScrollView>
  )
}

function SpeedButton({ rate }: { rate: number }) {
  const pick = () => {
    const labels = SPEEDS.map(speed)
    ActionSheetIOS.showActionSheetWithOptions(
      { options: [...labels, "Cancel"], cancelButtonIndex: labels.length, userInterfaceStyle: "dark" },
      (index) => {
        const value = SPEEDS[index]
        if (value !== undefined) void player.setRate(value)
      },
    )
  }
  return (
    <Tap style={styles.tool} accessibilityRole="button" accessibilityLabel={`Playback speed ${speed(rate)}`} onPress={pick}>
      <View style={styles.speedPill}>
        <Text style={styles.speedText}>{speed(rate)}</Text>
      </View>
    </Tap>
  )
}

function SleepTimerButton({
  mode,
  remaining,
  status,
}: {
  mode: SleepTimerMode
  remaining: string | null
  status: { episodeId: string | null; index: number }
}) {
  const active = mode._tag !== "Off"
  const pick = () => {
    if (status.episodeId === null) return
    const options =
      mode._tag === "Off"
        ? ["15 minutes", "30 minutes", "45 minutes", "60 minutes", "End of chapter", "Cancel"]
        : mode._tag === "Countdown"
          ? ["+5 minutes", "15 minutes", "30 minutes", "45 minutes", "60 minutes", "End of chapter", "Turn off", "Cancel"]
          : ["15 minutes", "30 minutes", "45 minutes", "60 minutes", "Turn off", "Cancel"]
    ActionSheetIOS.showActionSheetWithOptions(
      { options, cancelButtonIndex: options.length - 1, userInterfaceStyle: "dark" },
      (index) => {
        const episodeId = status.episodeId
        if (episodeId === null) return
        const nowMs = Date.now()
        if (mode._tag === "Off") {
          if (index < 4) sleepTimer.setPreset((index + 1) * 15 as SleepTimerPreset, nowMs, status.index, episodeId)
          else if (index === 4) sleepTimer.setPreset("EndOfChapter", nowMs, status.index, episodeId)
        } else if (mode._tag === "Countdown") {
          if (index === 0) sleepTimer.addFiveMinutes(nowMs)
          else if (index < 5) sleepTimer.setPreset(index * 15 as SleepTimerPreset, nowMs, status.index, episodeId)
          else if (index === 5) sleepTimer.setPreset("EndOfChapter", nowMs, status.index, episodeId)
          else if (index === 6) sleepTimer.off()
        } else {
          if (index < 4) sleepTimer.setPreset((index + 1) * 15 as SleepTimerPreset, nowMs, status.index, episodeId)
          else if (index === 4) sleepTimer.off()
        }
      },
    )
  }
  return (
    <Tap style={styles.tool} accessibilityRole="button" accessibilityLabel={active ? `Sleep timer ${remaining}` : "Sleep timer Off"} onPress={pick}>
      <Icon name={active ? "moon.fill" : "moon"} size={25} color={active ? colors.accent : colors.text} />
      {active ? <Text style={styles.timerText}>{remaining === "End of ch." ? "Ch. end" : remaining}</Text> : null}
    </Tap>
  )
}

const DownloadButton = memo(function DownloadButton({ episode }: { episode: Episode }) {
  const downloads = useDownloads()
  const state = downloads.state(episode)
  const ready = episode.job._tag === "Ready"
  const onPress = () => {
    if (state._tag === "Done") {
      Alert.alert("Remove download?", undefined, [
        { text: "Cancel", style: "cancel" },
        { text: "Remove", style: "destructive", onPress: () => downloads.remove(episode.id) },
      ])
    } else if (state._tag === "None") {
      downloads.download(episode).catch(() => Alert.alert("Download failed", "Check the connection and try again."))
    }
  }
  return (
    <Tap
      style={styles.tool}
      disabled={!ready || state._tag === "Downloading"}
      accessibilityRole="button"
      accessibilityLabel={state._tag === "Done" ? "Downloaded" : state._tag === "Downloading" ? "Downloading" : "Download"}
      onPress={onPress}
    >
      {state._tag === "Downloading" ? (
        <Text style={styles.downloadProgress}>{`${state.done}/${state.total}`}</Text>
      ) : (
        <Icon
          name={state._tag === "Done" ? "arrow.down.circle.fill" : "arrow.down.circle"}
          size={28}
          color={state._tag === "Done" ? colors.accent : colors.text}
          weight="regular"
        />
      )}
    </Tap>
  )
})

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background, paddingHorizontal: space.xl },
  topBar: { flexDirection: "row", justifyContent: "space-between", marginHorizontal: -space.sm },
  iconButton: { width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center" },
  iconButtonOn: { backgroundColor: colors.accent },
  stage: { flex: 1, alignItems: "center", justifyContent: "center" },
  info: { gap: 4, marginBottom: space.sm },
  title: { fontFamily: fonts.bold, fontSize: 24, lineHeight: 30, color: colors.text },
  chapter: { fontFamily: fonts.medium, fontSize: 16, color: colors.textSecondary },
  job: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 },
  jobText: { fontFamily: fonts.medium, fontSize: 14, color: colors.accent },
  transport: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: space.md, marginTop: space.lg, marginBottom: space.xl },
  skip: { width: 76, height: 76, alignItems: "center", justifyContent: "center" },
  play: { width: 104, height: 104, borderRadius: 52, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center" },
  tools: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  tool: { width: 64, height: 52, alignItems: "center", justifyContent: "center" },
  route: { width: 36, height: 36 },
  speedPill: { minWidth: 56, height: 34, paddingHorizontal: space.md, borderRadius: radius.pill, backgroundColor: colors.surfaceRaised, alignItems: "center", justifyContent: "center" },
  speedText: { fontFamily: fonts.bold, fontSize: 15, color: colors.text, fontVariant: ["tabular-nums"] },
  timerText: { marginTop: 2, fontFamily: fonts.bold, fontSize: 12, color: colors.accent, fontVariant: ["tabular-nums"] },
  downloadProgress: { fontFamily: fonts.bold, fontSize: 15, color: colors.accent, fontVariant: ["tabular-nums"] },
  chapters: { alignSelf: "stretch" },
  chapterRow: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 56, paddingVertical: space.sm },
  chapterIndex: { width: 28, fontFamily: fonts.medium, fontSize: 15, color: colors.textTertiary, fontVariant: ["tabular-nums"] },
  chapterTitle: { flex: 1, fontFamily: fonts.medium, fontSize: 17, color: colors.text },
  chapterTime: { fontFamily: fonts.regular, fontSize: 15, color: colors.textSecondary, fontVariant: ["tabular-nums"] },
  on: { color: colors.accent },
})
