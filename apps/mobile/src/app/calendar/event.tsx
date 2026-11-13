import { useCallback, useMemo, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native'
import { Stack, useLocalSearchParams } from 'expo-router'
import { attendeeSummary, canWrite, DAY, describeRule, occurrenceTimes, occurrenceWhen, RESPONSE_WORDS, toWall, zoneLabel, type ParticipationStatus } from '@tresso/core'
import { tint } from '@/calendar/colors'
import { MeetingLink } from '@/calendar/MeetingLink'
import { meetingLine } from '@/calendar/meetingLine'
import { useOccurrences, useReaderZone } from '@/calendar/useOccurrences'
import { useMail } from '@/mail/MailProvider'
import { useTheme, type Theme } from '@/theme'
import { LoadingLine } from '@/components/LogoLoader'

const ANSWERS: { value: 'accepted' | 'tentative' | 'declined'; label: string }[] = [
  { value: 'accepted', label: 'Accept' },
  { value: 'tentative', label: 'Maybe' },
  { value: 'declined', label: 'Decline' },
]

/** One occurrence: when, where, who, and the user's answer when invited. */
export default function EventScreen() {
  const theme = useTheme()
  const styles = useMemo(() => makeStyles(theme), [theme])
  const params = useLocalSearchParams<{ key: string; start: string }>()
  const mail = useMail()
  const start = Number(params.start)
  const zone = useReaderZone()
  // Declined ones too: the event stays on screen after the user declines it, with the answer to change.
  const { occurrences, calendars, loaded } = useOccurrences(start - DAY, start + DAY, zone, { includeDeclined: true })
  const occurrence = occurrences.find((candidate) => candidate.key === params.key) ?? null
  const [onlyThis, setOnlyThis] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Shown at once; the delta brings the server's version right after.
  const [answered, setAnswered] = useState<ParticipationStatus | null>(null)
  const [now] = useState(() => Date.now())
  const serverNow = mail.serverNow
  const clock = useCallback(() => serverNow?.() ?? Date.now(), [serverNow])

  if (occurrence === null) {
    return (
      <View style={styles.screen}>
        <Stack.Screen options={{ headerShown: true, title: 'Event' }} />
        {loaded ? <Text style={styles.muted}>This event is no longer in your calendar.</Text> : <LoadingLine text="Loading…" textStyle={styles.muted} />}
      </View>
    )
  }

  const event = occurrence.event
  const calendar = calendars.get(event.calendarId)
  const color = calendar?.color ?? '#6E56CF'
  const response = answered ?? event.selfResponse
  const rule = occurrence.series?.recurrence ?? null
  // Retry acts on the series and only for its organizer, on a calendar the user can write.
  const organizerActs = event.selfResponse === null && canWrite(calendar) && !occurrence.fromServer
  const ownZone = occurrence.timeZone !== null && occurrence.timeZone !== zone && !occurrence.allDay ? `${occurrenceTimes(occurrence, occurrence.timeZone)} in ${zoneLabel(occurrence.timeZone, occurrence.start)}.` : null

  async function respond(value: 'accepted' | 'tentative' | 'declined') {
    setBusy(true)
    setError(null)
    try {
      await mail.respond(occurrence!.seriesId, value, onlyThis && occurrence!.recurring ? occurrence!.recurrenceId : null)
      setAnswered(value)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ headerShown: true, title: calendar?.name ?? 'Event' }} />
      <View style={[styles.swatch, { backgroundColor: tint(color, 0.16), borderLeftColor: color }]}>
        <Text style={styles.title} accessibilityRole="header">
          {event.summary || 'Untitled event'}
        </Text>
        <Text style={styles.when}>{occurrenceWhen(occurrence, zone, toWall(now, zone))}</Text>
        {ownZone !== null && <Text style={styles.muted}>{ownZone}</Text>}
        {rule !== null && <Text style={styles.muted}>{describeRule(rule, occurrence.timeZone)}</Text>}
      </View>

      <MeetingLink
        key={event.conference?.url ?? ''}
        conference={event.conference}
        request={(occurrence.series ?? event).conferenceRequest ?? null}
        organizes={event.selfResponse === null}
        line={event.conference !== null ? meetingLine(event, event.organizer?.name || event.organizer?.address || null, event.location) : null}
        clock={clock}
        onRetry={organizerActs ? (provider) => mail.requestMeetingLink(occurrence.seriesId, provider) : null}
      />
      {/* With a meeting link the place is in the line under it. */}
      {event.conference === null && event.location !== '' && <Text style={styles.line}>{event.location}</Text>}
      {event.syncError !== null && <Text style={styles.error}>Not saved at the provider: {event.syncError}</Text>}

      {event.attendees.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{attendeeSummary(event.attendees.map((person) => person.partstat))}</Text>
          {event.organizer !== null && (
            <View style={styles.person}>
              <Text style={styles.name}>{event.organizer.name || event.organizer.address}</Text>
              <Text style={styles.muted}>Organizer</Text>
            </View>
          )}
          {event.attendees.map((person) => (
            <View key={person.address} style={styles.person}>
              <Text style={styles.name} numberOfLines={1}>
                {person.name || person.address}
              </Text>
              <Text style={styles.muted}>{RESPONSE_WORDS[person.partstat]}</Text>
            </View>
          ))}
        </View>
      )}

      {event.description !== '' && <Text style={styles.description}>{event.description}</Text>}

      {response !== null && canWrite(calendar) && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Going? {RESPONSE_WORDS[response]}</Text>
          {response === 'declined' && <Text style={styles.muted}>You declined. The event no longer shows in your calendar; you can still change your answer here.</Text>}
          {occurrence.recurring && (
            <View style={styles.person}>
              <Text style={styles.name}>Only this event</Text>
              <Switch value={onlyThis} onValueChange={setOnlyThis} accessibilityLabel="Only this event" />
            </View>
          )}
          <View style={styles.answers}>
            {ANSWERS.map((answer) => (
              <Pressable
                key={answer.value}
                style={[styles.answer, response === answer.value && styles.answerOn]}
                onPress={() => void respond(answer.value)}
                disabled={busy}
                accessibilityRole="button"
                accessibilityState={{ selected: response === answer.value, disabled: busy }}
              >
                <Text style={[styles.answerLabel, response === answer.value && styles.answerLabelOn]}>{answer.label}</Text>
              </Pressable>
            ))}
          </View>
          {error !== null && <Text style={styles.error}>{error}</Text>}
        </View>
      )}
    </ScrollView>
  )
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.surface },
    content: { gap: 16, padding: 20 },
    swatch: { gap: 4, padding: 14, borderRadius: 10, borderLeftWidth: 3 },
    title: { fontSize: 22, lineHeight: 28, fontWeight: '700', color: theme.ink },
    when: { fontSize: 15, fontWeight: '600', color: theme.ink },
    muted: { fontSize: 13, color: theme.ink2 },
    line: { fontSize: 15, color: theme.ink },
    error: { fontSize: 13, color: theme.danger },
    section: { gap: 8, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.line },
    sectionTitle: { fontSize: 15, fontWeight: '600', color: theme.ink },
    person: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 32 },
    name: { flex: 1, fontSize: 15, color: theme.ink },
    description: { fontSize: 15, lineHeight: 21, color: theme.ink2 },
    answers: { flexDirection: 'row', gap: 8 },
    answer: { flex: 1, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 8, borderWidth: 1, borderColor: theme.lineStrong },
    answerOn: { backgroundColor: theme.ink, borderColor: theme.ink },
    answerLabel: { fontSize: 15, fontWeight: '600', color: theme.ink },
    answerLabelOn: { color: theme.surface },
  })
}
