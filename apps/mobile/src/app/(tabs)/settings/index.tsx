import * as Clipboard from "expo-clipboard"
import * as Haptics from "expo-haptics"
import { useEffect, useState } from "react"
import { Alert, Keyboard, Linking, ScrollView, StyleSheet, Text, TextInput, View } from "react-native"
import { Button, Icon, Tap } from "../../../components/ui"
import { ApiError } from "../../../lib/api"
import { useSettings } from "../../../lib/settings"
import { colors, fonts, radius, space } from "../../../theme"

type Check = { _tag: "Idle" } | { _tag: "Checking" } | { _tag: "Ok" } | { _tag: "Failed"; message: string }

export default function SettingsScreen() {
  const { connection, api, save } = useSettings()
  const [serverUrl, setServerUrl] = useState(connection?.serverUrl ?? "")
  const [token, setToken] = useState(connection?.token ?? "")
  const [check, setCheck] = useState<Check>({ _tag: "Idle" })

  useEffect(() => {
    if (!api) return setCheck({ _tag: "Idle" })
    let live = true
    setCheck({ _tag: "Checking" })
    api.listEpisodes().then(
      () => live && setCheck({ _tag: "Ok" }),
      (error: unknown) => live && setCheck({ _tag: "Failed", message: error instanceof ApiError ? error.message : "Could not connect." }),
    )
    return () => {
      live = false
    }
  }, [api])

  const dirty = serverUrl.trim() !== (connection?.serverUrl ?? "") || token.trim() !== (connection?.token ?? "")

  const feed = async (action: "podcasts" | "copy") => {
    if (!api) return
    try {
      const url = await api.feedUrl()
      if (action === "podcasts") {
        const podcastUrl = url.replace(/^https?:\/\//, "podcast://")
        const opened = await Linking.openURL(podcastUrl).then(() => true, () => false)
        if (opened) return
      }
      await Clipboard.setStringAsync(url)
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
      Alert.alert(action === "podcasts" ? "Podcasts did not open" : "Feed URL copied", action === "podcasts" ? "The feed URL is on the clipboard. Add it in your podcast app." : undefined)
    } catch (error) {
      Alert.alert("Could not get the feed", error instanceof Error ? error.message : undefined)
    }
  }

  return (
    <ScrollView style={styles.screen} contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" contentContainerStyle={styles.content}>
      <View style={styles.group}>
        <TextInput
          style={styles.input}
          value={serverUrl}
          onChangeText={setServerUrl}
          placeholder="Server URL"
          placeholderTextColor={colors.textTertiary}
          keyboardType="url"
          autoCapitalize="none"
          autoCorrect={false}
          textContentType="URL"
          selectionColor={colors.accent}
          accessibilityLabel="Server URL"
        />
        <View style={styles.separator} />
        <TextInput
          style={styles.input}
          value={token}
          onChangeText={setToken}
          placeholder="API token"
          placeholderTextColor={colors.textTertiary}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          textContentType="none"
          autoComplete="off"
          selectionColor={colors.accent}
          accessibilityLabel="API token"
        />
      </View>

      {dirty ? (
        <Button title="Save" onPress={() => {
            Keyboard.dismiss()
            void save({ serverUrl, token })
          }} disabled={serverUrl.trim() === "" || token.trim() === ""} />
      ) : (
        <Status check={check} />
      )}

      <View style={[styles.group, !api && styles.disabled]} pointerEvents={api ? "auto" : "none"}>
        <Tap style={styles.row} accessibilityRole="button" accessibilityLabel="Add to Podcasts" onPress={() => void feed("podcasts")}>
          <Icon name="apple.podcasts.pages" size={22} color={colors.accent} />
          <Text style={styles.rowText}>Add to Podcasts</Text>
        </Tap>
        <View style={styles.separator} />
        <Tap style={styles.row} accessibilityRole="button" accessibilityLabel="Copy feed URL" onPress={() => void feed("copy")}>
          <Icon name="doc.on.doc" size={20} color={colors.text} />
          <Text style={styles.rowText}>Copy feed URL</Text>
        </Tap>
      </View>
    </ScrollView>
  )
}

function Status({ check }: { check: Check }) {
  switch (check._tag) {
    case "Idle":
      return null
    case "Checking":
      return <Text style={styles.status}>Connecting…</Text>
    case "Ok":
      return (
        <View style={styles.statusRow}>
          <Icon name="checkmark.circle.fill" size={18} color={colors.accent} />
          <Text style={styles.status}>Connected</Text>
        </View>
      )
    case "Failed":
      return (
        <View style={styles.statusRow}>
          <Icon name="exclamationmark.circle.fill" size={18} color={colors.danger} />
          <Text style={[styles.status, { color: colors.danger }]}>{check.message}</Text>
        </View>
      )
  }
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: space.lg, gap: space.lg },
  group: { backgroundColor: colors.surface, borderRadius: radius.md },
  disabled: { opacity: 0.4 },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.separator, marginLeft: space.lg },
  input: { minHeight: 56, paddingHorizontal: space.lg, fontFamily: fonts.regular, fontSize: 17, color: colors.text },
  row: { minHeight: 56, flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg },
  rowText: { fontFamily: fonts.medium, fontSize: 17, color: colors.text },
  statusRow: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.xs },
  status: { flexShrink: 1, fontFamily: fonts.medium, fontSize: 15, color: colors.textSecondary },
})
