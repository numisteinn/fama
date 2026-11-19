import type { Episode } from "@fama/contracts"
import { useRef, useState } from "react"
import { StyleSheet, Text, View } from "react-native"
import ReanimatedSwipeable, { type SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable"
import { useDownloads } from "../lib/downloads"
import { duration, isPlayable, jobLabel, totalSeconds } from "../lib/format"
import { usePlayerStatus, useSavedPosition } from "../player/player"
import { colors, fonts, radius, space } from "../theme"
import { Artwork } from "./Artwork"
import { Icon, Tap } from "./ui"

type Props = {
  episode: Episode
  onPlay(episode: Episode): void
  onRetry(episode: Episode): Promise<void>
  onDelete(episode: Episode): void
}

export function EpisodeRow({ episode, onPlay, onRetry, onDelete }: Props) {
  const swipeable = useRef<SwipeableMethods>(null)
  const playable = isPlayable(episode)
  return (
    <ReanimatedSwipeable
      ref={swipeable}
      friction={1.5}
      rightThreshold={60}
      overshootRight={false}
      renderRightActions={() => (
        <Tap
          accessibilityRole="button"
          accessibilityLabel={`Delete ${episode.title}`}
          style={styles.delete}
          onPress={() => {
            swipeable.current?.close()
            onDelete(episode)
          }}
        >
          <Icon name="trash.fill" color={colors.text} />
          <Text style={styles.deleteText}>Delete</Text>
        </Tap>
      )}
    >
      <Tap
        style={styles.row}
        accessibilityRole="button"
        accessibilityLabel={episode.title}
        onPress={() => playable && onPlay(episode)}
      >
        <Artwork episode={episode} size={56} rounded={radius.sm} />
        <View style={styles.body}>
          <Text style={styles.title} numberOfLines={2}>
            {episode.title}
          </Text>
          <Meta episode={episode} />
        </View>
        {episode.job._tag === "Failed" ? <RetryButton onRetry={() => onRetry(episode)} /> : null}
      </Tap>
      {episode.job._tag === "Running" && episode.job.total > 0 ? (
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${(episode.job.done / episode.job.total) * 100}%` }]} />
        </View>
      ) : null}
    </ReanimatedSwipeable>
  )
}

function Meta({ episode }: { episode: Episode }) {
  const downloads = useDownloads()
  const status = usePlayerStatus()
  const saved = useSavedPosition(episode.id)
  const nowPlaying = status.episodeId === episode.id && status.playing
  const download = downloads.state(episode)
  const { job } = episode

  if (job._tag === "Failed") {
    return (
      <View style={styles.meta}>
        <Icon name="exclamationmark.circle.fill" size={15} color={colors.danger} />
        <Text style={[styles.metaText, styles.reason]} numberOfLines={1}>
          {job.reason}
        </Text>
      </View>
    )
  }
  if (job._tag !== "Ready") {
    return (
      <View style={styles.meta}>
        <Icon name={job._tag === "Queued" ? "clock" : "waveform"} size={15} color={colors.accent} />
        <Text style={[styles.metaText, { color: colors.accent }]} numberOfLines={1}>
          {jobLabel(job)}
        </Text>
      </View>
    )
  }

  const total = totalSeconds(episode)
  const left = total - saved
  const text = saved >= total - 2 ? "Played" : saved > 5 ? `${duration(left)} left` : duration(total)
  return (
    <View style={styles.meta}>
      {nowPlaying ? <Icon name="speaker.wave.2.fill" size={15} color={colors.accent} /> : null}
      <Text style={styles.metaText} numberOfLines={1}>
        {text}
      </Text>
      {download._tag === "Done" ? <Icon name="arrow.down.circle.fill" size={15} color={colors.textSecondary} /> : null}
      {download._tag === "Downloading" ? <Text style={styles.metaText}>{`${download.done}/${download.total}`}</Text> : null}
    </View>
  )
}

function RetryButton({ onRetry }: { onRetry(): Promise<void> }) {
  const [busy, setBusy] = useState(false)
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel="Retry"
      disabled={busy}
      style={styles.retry}
      onPress={() => {
        setBusy(true)
        onRetry().finally(() => setBusy(false))
      }}
    >
      <Icon name="arrow.clockwise" size={18} color={colors.text} weight="semibold" />
      <Text style={styles.retryText}>Retry</Text>
    </Tap>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    minHeight: 80,
    backgroundColor: colors.background,
  },
  body: { flex: 1, gap: 4 },
  title: { fontFamily: fonts.medium, fontSize: 17, lineHeight: 22, color: colors.text },
  meta: { flexDirection: "row", alignItems: "center", gap: 6 },
  metaText: { fontFamily: fonts.regular, fontSize: 15, color: colors.textSecondary, fontVariant: ["tabular-nums"] },
  reason: { flexShrink: 1, color: colors.danger },
  progressTrack: { position: "absolute", left: space.lg + 56 + space.md, right: space.lg, bottom: 6, height: 3, borderRadius: 2, backgroundColor: colors.surfaceRaised },
  progressFill: { height: 3, borderRadius: 2, backgroundColor: colors.accent },
  retry: {
    minHeight: 44,
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceRaised,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  retryText: { fontFamily: fonts.bold, fontSize: 15, color: colors.text },
  delete: { width: 96, backgroundColor: "#C2352A", alignItems: "center", justifyContent: "center", gap: 4 },
  deleteText: { fontFamily: fonts.medium, fontSize: 13, color: colors.text },
})
