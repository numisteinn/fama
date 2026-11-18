import type { Episode } from "@fama/contracts"
import { useRouter } from "expo-router"
import { Alert, FlatList, RefreshControl, StyleSheet, Text, View } from "react-native"
import { EpisodeRow } from "../../../components/EpisodeRow"
import { Button, Icon } from "../../../components/ui"
import { useDownloads } from "../../../lib/downloads"
import { useLibrary } from "../../../lib/library"
import { useSettings } from "../../../lib/settings"
import { player } from "../../../player/player"
import { useTrackSource } from "../../../player/usePlayback"
import { colors, fonts, space } from "../../../theme"

export default function LibraryScreen() {
  const router = useRouter()
  const { api } = useSettings()
  const library = useLibrary()
  const downloads = useDownloads()
  const source = useTrackSource()

  const play = (episode: Episode) => {
    if (!source) return
    void player.load(episode, source, true)
    router.push("/player")
  }

  const remove = (episode: Episode) => {
    void player.forget(episode.id)
    downloads.remove(episode.id)
    library.remove(episode.id).catch((error: Error) => Alert.alert("Could not delete", error.message))
  }

  const retry = (episode: Episode) =>
    library.retry(episode.id).catch((error: Error) => Alert.alert("Could not retry", error.message))

  if (!api) {
    return (
      <Empty icon="server.rack" title="Connect your Fama server">
        <Button title="Open Settings" onPress={() => router.navigate("/settings")} />
      </Empty>
    )
  }

  return (
    <FlatList
      data={library.episodes}
      keyExtractor={(episode) => episode.id}
      contentInsetAdjustmentBehavior="automatic"
      style={styles.list}
      refreshControl={<RefreshControl refreshing={library.refreshing} onRefresh={() => void library.refresh()} tintColor={colors.textSecondary} />}
      ItemSeparatorComponent={Separator}
      ListHeaderComponent={library.error ? <ErrorBanner message={library.error} /> : undefined}
      ListEmptyComponent={
        library.loaded ? (
          <Empty icon="headphones" title="Nothing to listen to yet">
            <Button title="Add" icon="plus" onPress={() => router.navigate("/add")} />
          </Empty>
        ) : undefined
      }
      renderItem={({ item }) => <EpisodeRow episode={item} onPlay={play} onRetry={retry} onDelete={remove} />}
    />
  )
}

function Separator() {
  return <View style={styles.separator} />
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <View style={styles.banner}>
      <Icon name="wifi.exclamationmark" size={18} color={colors.danger} />
      <Text style={styles.bannerText}>{message}</Text>
    </View>
  )
}

function Empty({ icon, title, children }: { icon: "server.rack" | "headphones"; title: string; children: React.ReactNode }) {
  return (
    <View style={styles.empty}>
      <Icon name={icon} size={44} color={colors.textTertiary} weight="regular" />
      <Text style={styles.emptyTitle}>{title}</Text>
      {children}
    </View>
  )
}

const styles = StyleSheet.create({
  list: { flex: 1, backgroundColor: colors.background },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.separator, marginLeft: space.lg + 56 + space.md },
  banner: { flexDirection: "row", alignItems: "center", gap: space.sm, marginHorizontal: space.lg, marginBottom: space.sm, padding: space.md, borderRadius: 12, backgroundColor: colors.surface },
  bannerText: { flex: 1, fontFamily: fonts.medium, fontSize: 15, color: colors.text },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.lg, paddingHorizontal: space.xxl, paddingTop: 160 },
  emptyTitle: { fontFamily: fonts.bold, fontSize: 22, color: colors.text, textAlign: "center" },
})
