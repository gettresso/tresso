import { useEffect, useState } from 'react'
import { useRouter } from 'expo-router'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useAuth } from '@/auth/AuthProvider'
import { useLatestBrief } from '@/brief/useDailyBrief'
import { useNotices } from '@/components/Notices'
import { Icon } from '@/components/Icon'
import { InboxList } from '@/components/InboxList'
import { useComposer } from '@/compose/ComposerProvider'
import { useMail } from '@/mail/MailProvider'
import { useTheme, type Theme } from '@/theme'
import { LogoLoader } from '@/components/LogoLoader'

export default function Start() {
  const auth = useAuth()
  const theme = useTheme()
  const styles = makeStyles(theme)

  if (auth.restoring) {
    return (
      <SafeAreaView style={styles.screen}>
        <LogoLoader size={40} accessibilityLabel="Loading" />
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={auth.isAuthenticated ? styles.signedIn : styles.screen}>
      {auth.isAuthenticated ? <SignedIn styles={styles} /> : <SignIn styles={styles} />}
      {auth.storageError !== null && (
        <Text style={styles.error} accessibilityRole="alert">
          {auth.storageError}
        </Text>
      )}
    </SafeAreaView>
  )
}

type Styles = ReturnType<typeof makeStyles>

function SignIn({ styles }: { styles: Styles }) {
  const auth = useAuth()
  const theme = useTheme()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function signIn() {
    setBusy(true)
    setError(null)
    try {
      await auth.signIn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={styles.content}>
      <Text style={styles.title} accessibilityRole="header">
        Every email is something to do, to hand over, or to know.
      </Text>
      <Pressable
        style={({ pressed }) => [styles.primary, (pressed || busy) && styles.pressed]}
        onPress={signIn}
        disabled={busy}
        accessibilityRole="button"
        accessibilityState={{ busy, disabled: busy }}
      >
        {busy && <LogoLoader size={18} color={theme.onAccent} />}
        <Text style={styles.primaryLabel}>{busy ? 'Signing in…' : 'Sign in'}</Text>
      </Pressable>
      {error !== null && (
        <Text style={styles.error} accessibilityRole="alert">
          Sign-in failed: {error}
        </Text>
      )}
    </View>
  )
}

function SignedIn({ styles }: { styles: Styles }) {
  const auth = useAuth()
  const notices = useNotices()
  const signOut = () => {
    auth.signOut().catch((error: unknown) => {
      notices.notify({ text: `Signed out, but this phone may still get your notifications until someone signs in here: ${error instanceof Error ? error.message : String(error)}`, tone: 'error' })
    })
  }
  const mail = useMail()
  const { composer } = useComposer()
  const router = useRouter()
  const theme = useTheme()
  const [accounts, setAccounts] = useState(0)
  const [drafts, setDrafts] = useState(0)
  const [openTodos, setOpenTodos] = useState(0)
  const [waiting, setWaiting] = useState(0)
  const brief = useLatestBrief()
  const { mailAccounts, store, todos, version, handOvers } = mail

  useEffect(() => {
    let current = true
    void mailAccounts().then((list) => current && setAccounts(list.length))
    void (store()?.drafts() ?? Promise.resolve([])).then((list) => current && setDrafts(list.filter((draft) => draft.outgoingId === null).length))
    void todos().then((list) => current && setOpenTodos(list.filter((todo) => todo.completedAt === null).length))
    void handOvers().then((list) => current && setWaiting(list.filter((handOver) => handOver.state === 'open').length))
    return () => {
      current = false
    }
  }, [mailAccounts, store, todos, version, handOvers])

  return (
    <View style={styles.fill}>
      <InboxList
        header={
          <View style={styles.header}>
            <View style={styles.titles}>
              <Text style={styles.heading} accessibilityRole="header">
                Unified Inbox
              </Text>
              <Text style={styles.body}>
                {accounts === 1 ? '1 account' : `${accounts} accounts`}
                {mail.live ? '' : ' · not live'}
              </Text>
            </View>
            {brief.left > 0 && (
              <Pressable style={({ pressed }) => [styles.secondary, pressed && styles.pressed]} onPress={() => router.push('/brief')} accessibilityRole="button" accessibilityLabel={`Daily brief, ${brief.left} to note`}>
                <Text style={styles.secondaryLabel}>Brief {brief.left}</Text>
              </Pressable>
            )}
            <Pressable style={({ pressed }) => [styles.secondary, pressed && styles.pressed]} onPress={() => router.push('/todos')} accessibilityRole="button" accessibilityLabel={`Todos, ${openTodos} open`}>
              <Text style={styles.secondaryLabel}>Todos{openTodos > 0 ? ` ${openTodos}` : ''}</Text>
            </Pressable>
            {waiting > 0 && (
              <Pressable style={({ pressed }) => [styles.secondary, pressed && styles.pressed]} onPress={() => router.push('/waiting')} accessibilityRole="button" accessibilityLabel={`Waiting on, ${waiting}`}>
                <Text style={styles.secondaryLabel}>Waiting {waiting}</Text>
              </Pressable>
            )}
            <Pressable style={({ pressed }) => [styles.secondary, pressed && styles.pressed]} onPress={() => router.push('/calendar')} accessibilityRole="button">
              <Text style={styles.secondaryLabel}>Calendar</Text>
            </Pressable>
            <Pressable style={({ pressed }) => [styles.secondary, pressed && styles.pressed]} onPress={() => router.push('/triage')} accessibilityRole="button">
              <Text style={styles.secondaryLabel}>Triage</Text>
            </Pressable>
            {drafts > 0 && (
              <Pressable style={({ pressed }) => [styles.secondary, pressed && styles.pressed]} onPress={() => router.push('/drafts')} accessibilityRole="button" accessibilityLabel={`Drafts, ${drafts}`}>
                <Text style={styles.secondaryLabel}>Drafts {drafts}</Text>
              </Pressable>
            )}
            <Pressable style={({ pressed }) => [styles.secondary, pressed && styles.pressed]} onPress={signOut} accessibilityRole="button">
              <Text style={styles.secondaryLabel}>Sign out</Text>
            </Pressable>
          </View>
        }
      />
      {accounts > 0 && (
        <Pressable style={({ pressed }) => [styles.compose, pressed && styles.pressed]} onPress={() => composer.openNew()} accessibilityRole="button" accessibilityLabel="Compose">
          <Icon name="pen" size={18} color={theme.surface} />
          <Text style={styles.composeLabel}>Compose</Text>
        </Pressable>
      )}
    </View>
  )
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    screen: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: theme.ground },
    signedIn: { flex: 1, backgroundColor: theme.surface },
    fill: { flex: 1 },
    header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8 },
    titles: { flex: 1, gap: 2 },
    heading: { color: theme.ink, fontSize: 28, lineHeight: 34, fontWeight: '700' },
    content: { alignItems: 'center', gap: 16 },
    title: { color: theme.ink, fontSize: 24, lineHeight: 30, fontWeight: '700', textAlign: 'center' },
    body: { color: theme.ink2, fontSize: 16 },
    primary: { minHeight: 48, paddingHorizontal: 28, borderRadius: 6, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: theme.accent },
    primaryLabel: { color: theme.onAccent, fontSize: 16, fontWeight: '600' },
    secondary: { minHeight: 44, paddingHorizontal: 20, borderRadius: 6, justifyContent: 'center', borderWidth: 1, borderColor: theme.line, backgroundColor: theme.surface },
    secondaryLabel: { color: theme.ink, fontSize: 15, fontWeight: '500' },
    pressed: { opacity: 0.7 },
    compose: {
      position: 'absolute',
      right: 20,
      bottom: 24,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      height: 52,
      paddingHorizontal: 20,
      borderRadius: 999,
      backgroundColor: theme.ink,
      shadowColor: '#16181d',
      shadowOpacity: 0.2,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 8 },
      elevation: 6,
    },
    composeLabel: { color: theme.surface, fontSize: 15, fontWeight: '600' },
    error: { color: theme.danger, fontSize: 14, textAlign: 'center', marginTop: 16 },
  })
}
