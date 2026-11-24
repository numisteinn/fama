import type { Episode } from "@fama/contracts"
import { useRouter } from "expo-router"
import { Alert, FlatList, Image, RefreshControl, StyleSheet, Text, View } from "react-native"
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
  const { api, account, accountError } = useSettings()
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
      <Empty title="Connect your Fama server">
        <Button title="Open Settings" onPress={() => router.navigate("/settings")} />
      </Empty>
    )
  }

  // The Library loads only for a known account. Without one, say why and where to fix it.
  if (!account && accountError) {
    return (
      <Empty title={accountError}>
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
      ListHeaderComponent={library.error && library.episodes.length > 0 ? <ErrorBanner message={library.error} /> : undefined}
      ListEmptyComponent={
        library.error ? (
          <Empty title={library.error}>
            <Button title="Try again" onPress={() => void library.refresh()} />
          </Empty>
        ) : library.loaded ? (
          <Empty title="Nothing to listen to yet">
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

const pan = require("../../../../assets/pan-sleeping.png")

function Empty({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.empty}>
      <Image source={pan} style={styles.emptyArt} accessibilityIgnoresInvertColors />
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
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.lg, paddingHorizontal: space.xxl, paddingTop: 96 },
  emptyArt: { width: 160, height: 160 },
  emptyTitle: { fontFamily: fonts.bold, fontSize: 22, color: colors.text, textAlign: "center" },
})
