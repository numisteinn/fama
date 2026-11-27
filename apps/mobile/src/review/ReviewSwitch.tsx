import { StyleSheet, Switch, Text, View } from "react-native"
import { colors, fonts, space } from "../theme"

export function ReviewSwitch({ value, onChange }: { value: boolean; onChange: (value: boolean) => void }) {
  return (
    <View style={styles.row}>
      <Text accessible={false} style={styles.label}>Review</Text>
      <Switch accessibilityLabel="Review" value={value} onValueChange={onChange} trackColor={{ true: colors.accent }} />
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 48, paddingHorizontal: space.sm },
  label: { color: colors.text, fontFamily: fonts.medium, fontSize: 17 },
})
