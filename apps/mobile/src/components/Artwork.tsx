import type { Episode } from "@fama/contracts"
import { Image } from "expo-image"
import { StyleSheet, Text, View } from "react-native"
import { useSettings } from "../lib/settings"
import { colors, fonts } from "../theme"

/** The cover, or the episode's first letter on a dark tile, like the lock screen fallback. */
export function Artwork({ episode, size, rounded = 12 }: { episode: Episode; size: number; rounded?: number }) {
  const { api } = useSettings()
  const frame = { width: size, height: size, borderRadius: rounded }
  if (episode.coverUrl && api) {
    return <Image source={{ uri: api.mediaUrl(episode.coverUrl) }} style={[styles.tile, frame]} contentFit="cover" transition={150} />
  }
  const letter = episode.title.trim().charAt(0).toUpperCase() || "F"
  return (
    <View style={[styles.tile, frame]}>
      <Text style={[styles.letter, { fontSize: size * 0.48 }]} allowFontScaling={false}>
        {letter}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  tile: { backgroundColor: colors.surfaceRaised, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  letter: { fontFamily: fonts.bold, color: colors.accent },
})
