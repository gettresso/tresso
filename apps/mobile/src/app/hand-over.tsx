import { useEffect, useMemo, useState } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { dueChoices, firstName, MAX_NOTE, UnscannedFilesError, type Address, type DueChoice, type SyncedMessage } from '@tresso/core'
import { RecipientField } from '@/compose/RecipientField'
import { handOverProblem } from '@/handOver/form'
import { OneAtATime } from '@/handOver/oneAtATime'
import { dueLabel } from '@/handOver/format'
import { useHandOvers } from '@/handOver/HandOverProvider'
import { useMail } from '@/mail/MailProvider'
import { senderName } from '@/mail/format'
import { useTheme, type Theme } from '@/theme'
import { LogoLoader } from '@/components/LogoLoader'

const CHOICE_TEXT: Record<DueChoice, string> = { today: 'Today', tomorrow: 'Tomorrow', friday: 'Friday', nextWeek: 'Next week' }

/** Hands a conversation over: forwarded to one person with a note, and waited on until the due date. */
export default function HandOverScreen() {
  /** `messageId`: the message to hand over (triage hands over the one the user saw); else the conversation's newest. */
  const { threadId, messageId } = useLocalSearchParams<{ threadId: string; messageId?: string }>()
  const mail = useMail()
  const handOvers = useHandOvers()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const theme = useTheme()
  const styles = useMemo(() => makeStyles(theme), [theme])
  const [message, setMessage] = useState<SyncedMessage | null>(null)
  const [delegate, setDelegate] = useState<Address[]>([])
  const [note, setNote] = useState('')
  // Fixed while the screen is open, so a choice does not change under the user's finger.
  const [choices] = useState(() => dueChoices())
  const [due, setDue] = useState<DueChoice>(choices[0]!.key)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const { thread, mailAccounts } = mail

  // Closing the screen any way but by handing over settles a wait for it (triage) with nothing handed over.
  const { closed } = handOvers
  useEffect(() => () => closed(threadId), [closed, threadId])

  // The conversation's newest message from someone else, or its newest at all.
  useEffect(() => {
    let current = true
    void Promise.all([thread(threadId), mailAccounts()]).then(([found, accounts]) => {
      if (!current || found === null) {
        return
      }
      const asked = messageId === undefined ? undefined : found.messages.find((candidate) => candidate.id === messageId)
      const own = new Set(accounts.map((account) => account.emailAddress.toLowerCase()))
      const incoming = found.messages.filter((candidate) => !own.has(candidate.from.address.toLowerCase()))
      setMessage(asked ?? incoming[incoming.length - 1] ?? found.messages[found.messages.length - 1] ?? null)
    })
    return () => {
      current = false
    }
  }, [thread, mailAccounts, threadId, messageId])

  const person = delegate[0]
  const submitText = person === undefined ? 'Hand over' : `Hand over to ${firstName(person)}`

  // A second tap before the screen updates must not forward the conversation twice.
  const [gate] = useState(() => new OneAtATime())

  /** The server's question about files of the original that could not be scanned; null when there is none. */
  const [unscanned, setUnscanned] = useState<string | null>(null)

  function submit(acceptUnscanned = false): Promise<boolean> {
    return gate.run(() => handOver(acceptUnscanned))
  }

  async function handOver(acceptUnscanned: boolean) {
    const wrong = handOverProblem(delegate, note)
    const choice = choices.find((candidate) => candidate.key === due)
    if (wrong !== null || message === null || choice === undefined || person === undefined) {
      setProblem(wrong)
      return
    }
    setBusy(true)
    setProblem(null)
    setUnscanned(null)
    try {
      await handOvers.handOver(message, { delegate: person, note, dueAt: choice.at, dueLabel: dueLabel(choice.at.toISOString()), acceptUnscanned })
      router.back()
    } catch (error) {
      if (error instanceof UnscannedFilesError) {
        setUnscanned(error.message)
      } else {
        setProblem(error instanceof Error ? error.message : String(error))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: false, presentation: 'modal' }} />
      <KeyboardAvoidingView style={[styles.screen, { paddingTop: Platform.OS === 'android' ? insets.top : 0 }]} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <View style={styles.header}>
          <Pressable style={styles.textButton} onPress={() => router.back()} disabled={busy} accessibilityRole="button" hitSlop={4}>
            <Text style={styles.cancel}>Cancel</Text>
          </Pressable>
          <Text style={styles.title} accessibilityRole="header">
            Hand over
          </Text>
          <View style={styles.textButton} />
        </View>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {message !== null && (
            <Text style={styles.about} numberOfLines={2}>
              {message.subject || '(no subject)'}, from {senderName(message.from)}
            </Text>
          )}
          <RecipientField label="To" recipients={delegate} onChange={setDelegate} suggest={mail.suggestContacts} autoFocus />
          <View style={styles.field}>
            <Text style={styles.label}>{person === undefined ? 'Note' : `Note for ${firstName(person)}`}</Text>
            <TextInput
              style={styles.note}
              value={note}
              onChangeText={setNote}
              multiline
              maxLength={MAX_NOTE}
              placeholder="What should they do?"
              placeholderTextColor={theme.ink2}
              accessibilityLabel="Note"
            />
            <Text style={styles.hint}>Sent with the forward, above the original message and its files.</Text>
          </View>
          <View style={styles.field} accessibilityRole="radiogroup" accessibilityLabel="Due">
            <Text style={styles.label}>Due</Text>
            <View style={styles.choices}>
              {choices.map((choice) => {
                const on = choice.key === due
                return (
                  <Pressable key={choice.key} style={[styles.choice, on && styles.choiceOn]} onPress={() => setDue(choice.key)} accessibilityRole="radio" accessibilityState={{ checked: on }}>
                    <Text style={[styles.choiceLabel, on && styles.choiceLabelOn]}>{CHOICE_TEXT[choice.key]}</Text>
                    <Text style={[styles.choiceSub, on && styles.choiceLabelOn]}>{choice.at.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</Text>
                  </Pressable>
                )
              })}
            </View>
            <Text style={styles.hint}>It stays in Waiting on until they reply. If the date passes first, Tresso tells you and offers a nudge.</Text>
          </View>
          {problem !== null && (
            <Text style={styles.problem} accessibilityRole="alert">
              {problem}
            </Text>
          )}
          {unscanned !== null && (
            <View style={styles.unscanned}>
              <Text style={styles.problem} accessibilityRole="alert">
                {unscanned}
              </Text>
              <Pressable style={({ pressed }) => [styles.anyway, (pressed || busy) && styles.pressed]} onPress={() => void submit(true)} disabled={busy} accessibilityRole="button">
                <Text style={styles.anywayLabel}>Hand over anyway</Text>
              </Pressable>
            </View>
          )}
          <Pressable style={({ pressed }) => [styles.submit, (pressed || busy || message === null) && styles.pressed]} onPress={() => void submit()} disabled={busy || message === null} accessibilityRole="button">
            {busy && <LogoLoader size={18} color={theme.onAccent} />}
            <Text style={styles.submitLabel}>{busy ? 'Handing over…' : submitText}</Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </>
  )
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.surface },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, minHeight: 52, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.line },
    textButton: { minWidth: 64, minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
    cancel: { color: theme.accent, fontSize: 16 },
    title: { color: theme.ink, fontSize: 17, fontWeight: '600' },
    content: { padding: 20, gap: 18 },
    about: { color: theme.ink2, fontSize: 14 },
    field: { gap: 8 },
    label: { color: theme.ink, fontSize: 15, fontWeight: '600' },
    note: { minHeight: 96, padding: 12, borderRadius: 8, borderWidth: 1, borderColor: theme.lineStrong, color: theme.ink, fontSize: 16, textAlignVertical: 'top' },
    hint: { color: theme.ink2, fontSize: 13 },
    choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    choice: { minHeight: 48, minWidth: 96, paddingHorizontal: 14, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: theme.lineStrong, justifyContent: 'center' },
    choiceOn: { backgroundColor: theme.ink, borderColor: theme.ink },
    choiceLabel: { color: theme.ink, fontSize: 15, fontWeight: '600' },
    choiceSub: { color: theme.ink2, fontSize: 13 },
    choiceLabelOn: { color: theme.surface },
    problem: { color: theme.danger, fontSize: 14 },
    unscanned: { gap: 8 },
    anyway: { minHeight: 44, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, borderColor: theme.lineStrong, alignItems: 'center', justifyContent: 'center' },
    anywayLabel: { color: theme.ink, fontSize: 15, fontWeight: '600' },
    submit: { minHeight: 48, borderRadius: 999, backgroundColor: theme.accent, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
    submitLabel: { color: theme.onAccent, fontSize: 16, fontWeight: '600' },
    pressed: { opacity: 0.5 },
  })
}
