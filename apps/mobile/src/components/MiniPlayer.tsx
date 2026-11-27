import { useRouter } from "expo-router"
import { NativeTabs } from "expo-router/native-tabs"
import { ActivityIndicator, StyleSheet, Text, View } from "react-native"
import { useEpisode } from "../lib/library"
import { isWaiting, player, usePlayerStatus } from "../player/player"
import { colors, fonts, space } from "../theme"
import { Artwork } from "./Artwork"
import { Icon, Tap } from "./ui"

export function MiniPlayer() {
  const router = useRouter()
  const status = usePlayerStatus()
  const episode = useEpisode(status.episodeId)
  const placement = NativeTabs.BottomAccessory.usePlacement()
  if (!episode) return null
  const chapter = episode.chapters[status.index]
  return (
    <View style={styles.bar}>
      <Tap style={styles.open} accessibilityRole="button" accessibilityLabel={`Open player, ${episode.title}`} onPress={() => router.push("/player")}>
        {placement === "regular" ? <Artwork episode={episode} size={34} rounded={7} /> : null}
        <View style={styles.text}>
          <Text style={styles.title} numberOfLines={1}>
            {episode.title}
          </Text>
          {placement === "regular" && episode.chapters.length > 1 && chapter ? (
            <Text style={styles.chapter} numberOfLines={1}>
              {chapter.title}
            </Text>
          ) : null}
        </View>
      </Tap>
      <Tap style={styles.button} accessibilityRole="button" accessibilityLabel={status.playing ? "Pause" : "Play"} onPress={() => player.toggle()}>
        {isWaiting(status, episode) ? (
          <ActivityIndicator color={colors.text} />
        ) : (
          <Icon name={status.playing ? "pause.fill" : "play.fill"} size={22} />
        )}
      </Tap>
      {placement === "regular" ? (
        <Tap style={styles.button} accessibilityRole="button" accessibilityLabel="Forward 30 seconds" onPress={() => player.skip(30)}>
          <Icon name="goforward.30" size={22} />
        </Tap>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  bar: { flex: 1, flexDirection: "row", alignItems: "center", paddingLeft: space.md, paddingRight: space.xs },
  open: { flex: 1, flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 44 },
  text: { flex: 1 },
  title: { fontFamily: fonts.medium, fontSize: 15, color: colors.text },
  chapter: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary },
  button: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
})
