import { NativeTabs } from "expo-router/native-tabs"
import { MiniPlayer } from "../../components/MiniPlayer"
import { usePlayerStatus } from "../../player/player"
import { colors, fonts } from "../../theme"

export default function TabsLayout() {
  const { episodeId } = usePlayerStatus()
  return (
    <NativeTabs
      tintColor={colors.accent}
      labelStyle={{ fontFamily: fonts.medium }}
      minimizeBehavior="onScrollDown"
    >
      <NativeTabs.Trigger name="library">
        <NativeTabs.Trigger.Icon sf={{ default: "books.vertical", selected: "books.vertical.fill" }} />
        <NativeTabs.Trigger.Label>Library</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="add">
        <NativeTabs.Trigger.Icon sf={{ default: "plus.circle", selected: "plus.circle.fill" }} />
        <NativeTabs.Trigger.Label>Add</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Icon sf={{ default: "gearshape", selected: "gearshape.fill" }} />
        <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      {episodeId ? (
        <NativeTabs.BottomAccessory>
          <MiniPlayer />
        </NativeTabs.BottomAccessory>
      ) : null}
    </NativeTabs>
  )
}
