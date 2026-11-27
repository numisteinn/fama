import { SymbolView, type SFSymbol } from "expo-symbols"
import type { ReactNode } from "react"
import { Pressable, StyleSheet, Text, type PressableProps, type StyleProp, type TextProps, type ViewStyle } from "react-native"
import { colors, fonts, radius, space } from "../theme"

export function Icon({ name, size = 22, color = colors.text, weight = "medium" }: { name: SFSymbol; size?: number; color?: string; weight?: "regular" | "medium" | "semibold" | "bold" }) {
  return <SymbolView name={name} size={size} tintColor={color} weight={weight} resizeMode="scaleAspectFit" style={{ width: size, height: size }} accessible={false} accessibilityElementsHidden importantForAccessibility="no" />
}

/** Pressable that dims while pressed. */
export function Tap({ style, children, ...props }: PressableProps & { style?: StyleProp<ViewStyle>; children: ReactNode }) {
  return (
    <Pressable {...props} style={({ pressed }) => [style, pressed && { opacity: 0.55 }, props.disabled === true && { opacity: 0.4 }]}>
      {children}
    </Pressable>
  )
}

type Variant = "primary" | "secondary" | "danger"

export function Button({ title, icon, variant = "primary", busy, style, ...props }: PressableProps & { title: string; icon?: SFSymbol; variant?: Variant; busy?: boolean; style?: StyleProp<ViewStyle> }) {
  // A disabled primary button goes grey. Peach at low opacity on black reads as mud.
  const look: Variant = variant === "primary" && props.disabled === true && busy !== true ? "secondary" : variant
  const fg = look === "primary" ? colors.onAccent : look === "danger" ? colors.danger : colors.text
  return (
    <Tap accessibilityRole="button" {...props} disabled={props.disabled === true ? true : busy} style={[styles.button, styles[look], style]}>
      {icon ? <Icon name={icon} size={20} color={fg} weight="semibold" /> : null}
      <Text style={[styles.buttonText, { color: fg }]}>{busy === true ? `${title}…` : title}</Text>
    </Tap>
  )
}

export function Label({ style, ...props }: TextProps) {
  return <Text {...props} style={[styles.label, style]} />
}

const styles = StyleSheet.create({
  button: {
    minHeight: 56,
    borderRadius: radius.lg,
    paddingHorizontal: space.xl,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
  },
  primary: { backgroundColor: colors.accent },
  secondary: { backgroundColor: colors.surfaceRaised },
  danger: { backgroundColor: colors.surfaceRaised },
  buttonText: { fontFamily: fonts.bold, fontSize: 17 },
  label: { fontFamily: fonts.medium, fontSize: 13, color: colors.textSecondary, textTransform: "uppercase", letterSpacing: 0.6 },
})
