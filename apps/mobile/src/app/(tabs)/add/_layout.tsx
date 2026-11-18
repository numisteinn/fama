import { Stack } from "expo-router"
import { colors, fonts } from "../../../theme"

export default function AddStack() {
  return (
    <Stack
      screenOptions={{
        headerLargeTitle: true,
        headerTransparent: true,
        headerLargeTitleStyle: { fontFamily: fonts.bold, color: colors.text },
        headerTitleStyle: { fontFamily: fonts.bold, color: colors.text },
        headerTintColor: colors.accent,
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      <Stack.Screen name="index" options={{ title: "Add" }} />
    </Stack>
  )
}
