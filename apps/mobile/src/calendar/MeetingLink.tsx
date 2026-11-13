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
import { canRetry, meetingActionError, type RetryProvider } from '@/calendar/meetingActions'
import { Icon } from '@/components/Icon'
import { LoadingLine } from '@/components/LogoLoader'
import { useTheme, type Theme } from '@/theme'

/** How long "Copied" stays on the button. */
const COPIED_MS = 2000

/**
 * The link's text: at most {@link LINK_MAX} characters (core's linkText, which never cuts the host), on its own lines
 * above the buttons and never cut again on screen: at a large text size it wraps onto more lines, so no part of the
 * host is lost.
 */
export const LINK_MAX = 44

/** Said under a link the phone does not open (core's canJoin refused it), as on the web. */
export const NOT_OPENED = 'Tresso does not open this link. Check where it leads before you use it.'

/**
 * A left to right mark before a link shown as text: Android does not take `writingDirection`, and a host in Hebrew or
 * Arabic letters would otherwise set the whole line right to left. Only on screen, never in what is copied or opened.
 */
export const LTR_MARK = '\u200e'

interface Props {
  conference: Conference | null
  /** The series' request for a link, from its master row; null when nothing was asked for. */
  request: ConferenceRequest | null
  /** The user organizes the event: only they see that a link they asked for could not be made, and act on it. */
  organizes: boolean
  /** The line under the link (see meetingLine); null for none. */
  line: string | null
  /** The server's time as the phone knows it (ServerClock), so a device clock that is off does not end the wait early. */
  clock: () => number
  /** Retry: asks the calendar's provider for the link again (POST .../meeting-link). Null when the user cannot. */
  onRetry: ((provider: RetryProvider) => Promise<void>) | null
}

/**
 * An event's meeting link on the phone: Join (only for a link core's canJoin passes), the link as text with Copy link,
 * and the line under it; or the link that is being made, or that could not be made, with Retry for the organizer.
 * There is no "Leave without a link" yet: the API's removal would also take off a link that arrived after the phone's
 * copy. Nothing when the event has no link and none was asked for. The link itself is never logged or put into an
 * error. Give it the link as its `key`, so a new link (the sync brought one) starts without the old one's messages.
 */
export function MeetingLink({ conference, request, organizes, line, clock, onRetry }: Props) {
  const theme = useTheme()
  const styles = useMemo(() => makeStyles(theme), [theme])
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const [openFailed, setOpenFailed] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Answers that come after the screen closed (or the link changed) set nothing, as on the web's CopyLinkButton.
  const alive = useRef(true)
  // A second tap before the first one's answer does nothing: one openURL, one Retry.
  const opening = useRef(false)
  const busy = useRef(false)
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

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (copiedTimer.current !== null) {
        clearTimeout(copiedTimer.current)
        copiedTimer.current = null
      }
    }
  }, [])

  async function join(target: Conference) {
    // The button only exists for a link canJoin passes; checked again so nothing else can open another kind of link.
    if (!canJoin(target) || opening.current) {
      return
    }
    opening.current = true
    setOpenFailed(false)
    try {
      await Linking.openURL(target.url)
    } catch {
      if (alive.current) {
        setOpenFailed(true)
        AccessibilityInfo.announceForAccessibility(OPEN_FAILED)
      }
    } finally {
      opening.current = false
    }
  }

  async function copy(target: Conference) {
    let done = false
    try {
      done = await Clipboard.setStringAsync(target.url)
    } catch {
      done = false
    }
    if (!alive.current) {
      return
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

  async function retry(run: () => Promise<void>) {
    if (busy.current) {
      return
    }
    busy.current = true
    setRetrying(true)
    setActionError(null)
    try {
      await run()
      if (alive.current) {
        AccessibilityInfo.announceForAccessibility('Asked for the link again.')
      }
    } catch (error) {
      if (alive.current) {
        const text = meetingActionError(error)
        setActionError(text)
        AccessibilityInfo.announceForAccessibility(text)
      }
    } finally {
      busy.current = false
      if (alive.current) {
        setRetrying(false)
      }
    }
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
          <Text style={styles.link}>{LTR_MARK + linkText(conference.url, LINK_MAX)}</Text>
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
            {/* Selected and copied by hand, so without the left to right mark; iOS still sets it left to right. */}
            <Text style={styles.fullLink} selectable>
              {byHand(conference)}
            </Text>
          </View>
        )}
        {openFailed && <Text style={styles.error}>{OPEN_FAILED}</Text>}
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
    const provider = request.provider
    const ask = onRetry !== null && canRetry(provider) ? onRetry : null
    return (
      <View style={styles.status}>
        <View accessibilityLiveRegion="polite" style={styles.status}>
          <Text style={styles.failedTitle}>{requestTitle(request, now)}</Text>
          <Text style={styles.hint}>{failureHint(request, now)}</Text>
        </View>
        {ask !== null && canRetry(provider) && (
          <View style={styles.actions}>
            <Pressable
              style={styles.action}
              onPress={() => void retry(() => ask(provider))}
              disabled={retrying}
              accessibilityRole="button"
              accessibilityState={{ disabled: retrying, busy: retrying }}
            >
              <Text style={styles.actionLabel}>{retrying ? 'Retrying' : 'Retry'}</Text>
            </Pressable>
          </View>
        )}
        {actionError !== null && <Text style={styles.error}>{actionError}</Text>}
      </View>
    )
  }
  return null
}

const OPEN_FAILED = 'The meeting could not be opened on this phone. Copy the link instead.'

/**
 * The link to copy by hand when Copy failed, as on the web: a link canJoin passes is shown whole (it has nothing hidden
 * in it and is no longer than core allows), any other link as core's displayLink shows it.
 */
function byHand(conference: Conference): string {
  return canJoin(conference) ? conference.url : displayLink(conference.url)
}

const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' })

// Heights are minimums: at the largest text sizes labels and the link wrap and the controls grow with them.
function makeStyles(theme: Theme) {
  return StyleSheet.create({
    block: { gap: 8 },
    join: { minHeight: 52, paddingVertical: 12, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, borderRadius: 12, backgroundColor: theme.ink },
    joinLabel: { flexShrink: 1, fontSize: 16, fontWeight: '600', color: theme.surface, textAlign: 'center' },
    app: { fontSize: 13, fontWeight: '600', color: theme.ink },
    linkBox: { paddingTop: 10, paddingHorizontal: 12, borderRadius: 12, backgroundColor: theme.ground },
    // Left to right whatever the phone's language (iOS; Android through LTR_MARK), so a host never reads turned around.
    link: { fontFamily: MONO, fontSize: 12, color: theme.ink, writingDirection: 'ltr', textAlign: 'left' },
    copy: { alignSelf: 'flex-end', minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 2 },
    copyLabel: { flexShrink: 1, fontSize: 14, fontWeight: '600', color: theme.ink },
    fallback: { gap: 4 },
    fullLink: { fontFamily: MONO, fontSize: 12, color: theme.ink, writingDirection: 'ltr', textAlign: 'left' },
    line: { fontSize: 12, color: theme.ink2, textAlign: 'center' },
    error: { fontSize: 13, color: theme.danger },
    status: { gap: 4 },
    statusTitle: { fontSize: 15, fontWeight: '600', color: theme.ink },
    failedTitle: { fontSize: 15, fontWeight: '600', color: theme.danger },
    hint: { fontSize: 13, color: theme.ink2 },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingTop: 4 },
    action: { minHeight: 44, paddingVertical: 10, paddingHorizontal: 14, justifyContent: 'center', borderRadius: 8, borderWidth: 1, borderColor: theme.lineStrong },
    actionLabel: { fontSize: 15, fontWeight: '600', color: theme.ink },
  })
}
