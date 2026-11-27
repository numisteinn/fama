import { useState } from "react"
import { KeyboardAvoidingView, Modal, StyleSheet, Text, TextInput, View } from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { Button } from "../components/ui"
import { colors, fonts, radius, space } from "../theme"

export function ChapterEditor({
  title,
  initial,
  onDone,
  onCancel,
}: {
  title: string
  initial: string
  onDone: (text: string) => void
  onCancel: () => void
}) {
  const [text, setText] = useState(initial)
  return (
    <Modal visible animationType="slide" onRequestClose={onCancel}>
      <SafeAreaView style={styles.page}>
        <KeyboardAvoidingView behavior="padding" style={styles.page}>
          <View style={styles.editor}>
            <Text accessibilityRole="header" style={styles.title}>
              {title}
            </Text>
            <TextInput
              accessibilityLabel="Chapter text"
              style={[styles.editorText, styles.input]}
              multiline
              value={text}
              onChangeText={setText}
              selectionColor={colors.accent}
            />
            <View style={styles.actions}>
              <Button variant="secondary" title="Cancel" style={styles.flex} onPress={onCancel} />
              <Button title="Done" style={styles.flex} onPress={() => onDone(text)} />
            </View>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  )
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  title: { color: colors.text, fontFamily: fonts.bold, fontSize: 26 },
  flex: { flex: 1 },
  editor: { flex: 1, padding: space.lg, gap: space.md },
  editorText: { color: colors.text, fontFamily: fonts.regular, fontSize: 18, lineHeight: 26 },
  input: { flex: 1, backgroundColor: colors.surface, borderRadius: radius.md, padding: space.md, textAlignVertical: "top" },
  actions: { flexDirection: "row", gap: space.sm },
})
