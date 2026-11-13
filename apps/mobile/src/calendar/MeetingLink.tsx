import { useEffect, useMemo, useRef, useState } from 'react'
import { AccessibilityInfo, Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native'
// Imported statically: the app has no over-the-air updates today, so every build that runs this code has the native
// module. If over-the-air updates are ever added, this must become a guarded lazy require, or an update reaching an
// older build without expo-clipboard would crash the screen.
import * as Clipboard from 'expo-clipboard'
import {
  canJoin,
  displayLink,
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

/**
 * The link's text: at most {@link LINK_MAX} characters (core's linkText), on its own line above the buttons and
 * allowed {@link LINK_LINES} lines, so a narrow phone wraps it rather than cutting it a second time (and so loses no
 * part of the host). Exported for the test that checks it fits a 320 pt wide screen.
 */
export const LINK_MAX = 44
export const LINK_LINES = 2
export const LINK_FONT_SIZE = 12
/** Inner padding of the link box, left and right. */
export const LINK_PADDING = 12

/** Said under a link the phone does not open (core's canJoin refused it), as on the web. */
export const NOT_OPENED = 'Tresso does not open this link. Check where it leads before you use it.'

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
  const [tick, setTick] = useState(0)

  const now = clock()
  const state = requestState({ conference, conferenceRequest: request }, now)

  // Armed again after every tick until the state changes: the server's clock can still read under the limit when the
  // timer fires. The wait is capped, so a requestedAt far in the future cannot overflow setTimeout into a tight loop.
  useEffect(() => {
    if (state !== 'creating' || request === null) {
      return
    }
    const left = Date.parse(request.requestedAt) + MEETING_PENDING_MS - clock()
    const timer = setTimeout(() => setTick((value) => value + 1), Math.min(Math.max(0, left), MEETING_PENDING_MS) + 250)
    return () => clearTimeout(timer)
  }, [state, request, clock, tick])

  // A link that stops being made while the screen is open is said once, also on iOS, where live regions are not read.
  const said = useRef(state)
  useEffect(() => {
    const before = said.current
    said.current = state
    if (before === 'creating' && state === 'failed' && organizes && request !== null) {
      const at = clock()
      AccessibilityInfo.announceForAccessibility(`${requestTitle(request, at)}. ${failureHint(request, at)}`)
    }
  }, [state, organizes, request, clock])

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
        <View style={styles.linkBox}>
          <Text style={styles.link} numberOfLines={LINK_LINES}>
            {linkText(conference.url, LINK_MAX)}
          </Text>
          {/* The visible words are the button's accessible name, so voice control finds it by what it says. */}
          <Pressable style={styles.copy} onPress={() => void copy(conference)} accessibilityRole="button">
            <Icon name={copied ? 'check' : 'copy'} size={16} color={copied ? theme.know : theme.ink} strokeWidth={copied ? 2.4 : 2} />
            <Text style={styles.copyLabel}>{copied ? 'Copied' : 'Copy link'}</Text>
          </Pressable>
        </View>
        {!joinable && <Text style={styles.hint}>{NOT_OPENED}</Text>}
        {copyFailed && (
          <View style={styles.fallback}>
            <Text style={styles.error}>Could not copy the link. Press and hold it here to copy it.</Text>
            <Text style={styles.fullLink} selectable>
              {byHand(conference)}
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

/**
 * The link to copy by hand when Copy failed, as on the web: a link canJoin passes is shown whole (it has nothing hidden
 * in it and is no longer than core allows), any other link as core's displayLink shows it.
 */
function byHand(conference: Conference): string {
  return canJoin(conference) ? conference.url : displayLink(conference.url)
}

const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' })

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    block: { gap: 8 },
    join: { height: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, borderRadius: 12, backgroundColor: theme.ink },
    joinLabel: { fontSize: 16, fontWeight: '600', color: theme.surface },
    app: { fontSize: 13, fontWeight: '600', color: theme.ink },
    linkBox: { paddingTop: 10, paddingHorizontal: LINK_PADDING, borderRadius: 12, backgroundColor: theme.ground },
    // Left to right whatever the phone's language, so a host never reads turned around.
    link: { fontFamily: MONO, fontSize: LINK_FONT_SIZE, lineHeight: 16, color: theme.ink, writingDirection: 'ltr', textAlign: 'left' },
    copy: { alignSelf: 'flex-end', height: 44, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 2 },
    copyLabel: { fontSize: 14, fontWeight: '600', color: theme.ink },
    fallback: { gap: 4 },
    fullLink: { fontFamily: MONO, fontSize: 12, color: theme.ink, writingDirection: 'ltr', textAlign: 'left' },
    line: { fontSize: 12, color: theme.ink2, textAlign: 'center' },
    error: { fontSize: 13, color: theme.danger },
    status: { gap: 4 },
    statusTitle: { fontSize: 15, fontWeight: '600', color: theme.ink },
    failedTitle: { fontSize: 15, fontWeight: '600', color: theme.danger },
    hint: { fontSize: 13, color: theme.ink2 },
  })
}
