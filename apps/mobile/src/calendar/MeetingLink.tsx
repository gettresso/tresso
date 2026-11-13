import { useEffect, useMemo, useRef, useState } from 'react'
import { AccessibilityInfo, Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import {
  canJoin,
  conferenceLabel,
  CREATING_HINT,
  failureHint,
  joinLabel,
  linkText,
  MEETING_PENDING_MS,
  requestState,
  requestTitle,
  type Conference,
  type ConferenceRequest,
} from '@tresso/core'
import { Icon } from '@/components/Icon'
import { LoadingLine } from '@/components/LogoLoader'
import { useTheme, type Theme } from '@/theme'

/** How long "Copied" stays on the button. */
const COPIED_MS = 2000

interface Props {
  conference: Conference | null
  /** The series' request for a link, from its master row; null when nothing was asked for. */
  request: ConferenceRequest | null
  /** The user organizes the event: only they see that a link they asked for could not be made. */
  organizes: boolean
  /** The line under the link (see meetingLine); null for none. */
  line: string | null
  /** The server's time as the phone knows it (ServerClock), so a device clock that is off does not end the wait early. */
  clock: () => number
}

/**
 * An event's meeting link on the phone: Join (only for a link core's canJoin passes), the link on one line with Copy
 * link, and the line under it; or the link that is being made, or that could not be made. Nothing when the event has
 * no link and none was asked for. The link itself is never logged or put into an error. Give it the link as its
 * `key`, so a new link (the sync brought one) starts without the old one's messages.
 */
export function MeetingLink({ conference, request, organizes, line, clock }: Props) {
  const theme = useTheme()
  const styles = useMemo(() => makeStyles(theme), [theme])
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const [openFailed, setOpenFailed] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Renders again when a link that is being made has waited too long, so it then reads as failed.
  const [, setTick] = useState(0)

  const now = clock()
  const state = requestState({ conference, conferenceRequest: request }, now)

  useEffect(() => {
    if (state !== 'creating' || request === null) {
      return
    }
    const wait = Math.max(0, Date.parse(request.requestedAt) + MEETING_PENDING_MS - clock()) + 500
    const timer = setTimeout(() => setTick((tick) => tick + 1), wait)
    return () => clearTimeout(timer)
  }, [state, request, clock])

  useEffect(
    () => () => {
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current)
    },
    [],
  )

  async function join(target: Conference) {
    // The button only exists for a link canJoin passes; checked again so nothing else can open another kind of link.
    if (!canJoin(target)) {
      return
    }
    setOpenFailed(false)
    try {
      await Linking.openURL(target.url)
    } catch {
      setOpenFailed(true)
    }
  }

  async function copy(target: Conference) {
    let done = false
    try {
      done = await Clipboard.setStringAsync(target.url)
    } catch {
      done = false
    }
    if (copiedTimer.current !== null) clearTimeout(copiedTimer.current)
    if (!done) {
      setCopied(false)
      setCopyFailed(true)
      AccessibilityInfo.announceForAccessibility('Could not copy the meeting link.')
      return
    }
    setCopyFailed(false)
    setCopied(true)
    AccessibilityInfo.announceForAccessibility('Meeting link copied')
    copiedTimer.current = setTimeout(() => {
      copiedTimer.current = null
      setCopied(false)
    }, COPIED_MS)
  }

  if (conference !== null) {
    const joinable = canJoin(conference)
    const label = joinLabel(conference.provider)
    return (
      <View style={styles.block}>
        {joinable ? (
          <Pressable style={styles.join} onPress={() => void join(conference)} accessibilityRole="link" accessibilityLabel={label}>
            <Icon name="video" color={theme.surface} />
            <Text style={styles.joinLabel}>{label}</Text>
          </Pressable>
        ) : (
          <Text style={styles.app}>{conferenceLabel(conference, null)}</Text>
        )}
        <View style={styles.linkRow}>
          <Text style={styles.link} numberOfLines={1}>
            {linkText(conference.url)}
          </Text>
          <Pressable style={styles.copy} onPress={() => void copy(conference)} accessibilityRole="button" accessibilityLabel="Copy meeting link">
            <Icon name={copied ? 'check' : 'copy'} size={16} color={copied ? theme.know : theme.ink} strokeWidth={copied ? 2.4 : 2} />
            <Text style={styles.copyLabel}>{copied ? 'Copied' : 'Copy link'}</Text>
          </Pressable>
        </View>
        {copyFailed && (
          <View style={styles.fallback}>
            <Text style={styles.error}>Could not copy the link. Press and hold it here to copy it.</Text>
            <Text style={styles.fullLink} selectable>
              {conference.url}
            </Text>
          </View>
        )}
        {openFailed && <Text style={styles.error}>The meeting could not be opened on this phone. Copy the link instead.</Text>}
        {line !== null && <Text style={styles.line}>{line}</Text>}
      </View>
    )
  }

  if (request === null) {
    return null
  }
  if (state === 'creating') {
    return (
      <View style={styles.status}>
        <LoadingLine text={requestTitle(request, now)} textStyle={styles.statusTitle} />
        <Text style={styles.hint}>{CREATING_HINT}</Text>
      </View>
    )
  }
  if (state === 'failed' && organizes) {
    return (
      <View style={styles.status} accessibilityLiveRegion="polite">
        <Text style={styles.failedTitle}>{requestTitle(request, now)}</Text>
        <Text style={styles.hint}>{failureHint(request, now)}</Text>
      </View>
    )
  }
  return null
}

const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' })

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    block: { gap: 8 },
    join: { height: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, borderRadius: 12, backgroundColor: theme.ink },
    joinLabel: { fontSize: 16, fontWeight: '600', color: theme.surface },
    app: { fontSize: 13, fontWeight: '600', color: theme.ink },
    linkRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 12, borderRadius: 12, backgroundColor: theme.ground },
    link: { flex: 1, minWidth: 0, fontFamily: MONO, fontSize: 12, color: theme.ink },
    copy: { height: 44, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, borderRadius: 12 },
    copyLabel: { fontSize: 14, fontWeight: '600', color: theme.ink },
    fallback: { gap: 4 },
    fullLink: { fontFamily: MONO, fontSize: 12, color: theme.ink },
    line: { fontSize: 12, color: theme.ink2, textAlign: 'center' },
    error: { fontSize: 13, color: theme.danger },
    status: { gap: 4 },
    statusTitle: { fontSize: 15, fontWeight: '600', color: theme.ink },
    failedTitle: { fontSize: 15, fontWeight: '600', color: theme.danger },
    hint: { fontSize: 13, color: theme.ink2 },
  })
}
