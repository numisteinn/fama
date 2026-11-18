import { Stack } from "expo-router"
import * as SplashScreen from "expo-splash-screen"
import { StatusBar } from "expo-status-bar"
import { useEffect } from "react"
import { GestureHandlerRootView } from "react-native-gesture-handler"
import { DownloadsProvider } from "../lib/downloads"
import { LibraryProvider } from "../lib/library"
import { SettingsProvider, useSettings } from "../lib/settings"
import { PlayerSync } from "../player/PlayerSync"
import { colors, fonts } from "../theme"

void SplashScreen.preventAutoHideAsync()

// A share deep link opens over the tabs, not alone.
export const unstable_settings = { anchor: "(tabs)" }

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.background }}>
      <SettingsProvider>
        <LibraryProvider>
          <DownloadsProvider>
            <StatusBar style="light" />
            <PlayerSync />
            <Screens />
          </DownloadsProvider>
        </LibraryProvider>
      </SettingsProvider>
    </GestureHandlerRootView>
  )
}

function Screens() {
  const { ready } = useSettings()
  useEffect(() => {
    if (ready) void SplashScreen.hideAsync()
  }, [ready])
  if (!ready) return null
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.background },
        headerTitleStyle: { fontFamily: fonts.bold, color: colors.text },
      }}
    >
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="player" options={{ presentation: "modal" }} />
      <Stack.Screen
        name="expo-sharing"
        options={{ presentation: "formSheet", sheetAllowedDetents: [0.6, 1], sheetGrabberVisible: true }}
      />
    </Stack>
  )
}
