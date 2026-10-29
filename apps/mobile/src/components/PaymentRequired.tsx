import { useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { useAuth } from '@/auth/AuthProvider'
import { useTheme } from '@/theme'

/**
 * Covers the app while the server answers 402. Subscribing happens in Tresso on a computer or on the web: the phone
 * app sells nothing, so it only explains, checks again and offers to sign out.
 */
export function PaymentRequired() {
  const auth = useAuth()
  const theme = useTheme()
  const [checking, setChecking] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function checkAgain(): Promise<void> {
    setChecking(true)
    setMessage(null)
    try {
      // Any served request clears the notice; a 402 keeps it.
      await auth.session.me()
    } catch {
      setMessage('Still not renewed. A payment can take a moment to come through.')
    } finally {
      setChecking(false)
    }
  }

  return (
    <View style={[styles.cover, { backgroundColor: theme.ground }]} accessibilityViewIsModal>
      <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.line }]}>
        <Text accessibilityRole="header" style={[styles.title, { color: theme.ink }]}>
          Your Tresso subscription has ended
        </Text>
        <Text style={[styles.body, { color: theme.ink2 }]}>
          Your mail, calendar and todos are kept. Renew the subscription in Tresso on your computer or on the web, then
          come back here.
        </Text>
        {message !== null && <Text style={[styles.body, { color: theme.ink2 }]}>{message}</Text>}
        <Pressable
          accessibilityRole="button"
          disabled={checking}
          onPress={() => void checkAgain()}
          style={[styles.button, { backgroundColor: theme.accent }]}
        >
          {checking ? <ActivityIndicator color={theme.onAccent} /> : <Text style={[styles.buttonText, { color: theme.onAccent }]}>Check again</Text>}
        </Pressable>
        <Pressable accessibilityRole="button" onPress={() => void auth.signOut().catch(() => undefined)} style={[styles.button, styles.quiet, { borderColor: theme.lineStrong }]}>
          <Text style={[styles.buttonText, { color: theme.ink }]}>Sign out</Text>
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  cover: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, justifyContent: 'center', padding: 24 },
  card: { gap: 14, padding: 24, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth },
  title: { fontSize: 22, fontWeight: '700' },
  body: { fontSize: 16, lineHeight: 22 },
  button: { alignItems: 'center', justifyContent: 'center', minHeight: 48, borderRadius: 12 },
  quiet: { backgroundColor: 'transparent', borderWidth: 1 },
  buttonText: { fontSize: 16, fontWeight: '600' },
})
