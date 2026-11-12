import { useEffect, useMemo, useRef } from 'react'
import { AccessibilityInfo, StyleSheet, Text, View } from 'react-native'
import type { SyncStatus, SyncStatusKind } from '@tresso/core'
import { LogoLoader } from '@/components/LogoLoader'
import { useTheme, type Theme } from '@/theme'

const BUSY: SyncStatusKind[] = ['opening', 'updating', 'firstSync', 'catchingUp', 'connecting', 'reconnecting']

/**
 * The sync status under the inbox's title, as the web and desktop clients show it at the foot of their sidebar (see
 * describeSync): one line, the loader while something is under way, a thin progress line when the fraction is known,
 * and the notice that the list may be out of date. A screen reader hears the status by the quarter, not every percent.
 */
export function SyncStatusBar({ status }: { status: SyncStatus }) {
  const theme = useTheme()
  const styles = useMemo(() => makeStyles(theme), [theme])
  const told = useRef('')
  useEffect(() => {
    if (status.announcement !== '' && status.announcement !== told.current) {
      told.current = status.announcement
      AccessibilityInfo.announceForAccessibility(status.announcement)
    }
  }, [status.announcement])

  if (status.kind === 'closed') {
    return null
  }
  const percent = status.fraction === null ? null : Math.round(status.fraction * 100)
  return (
    <View style={styles.bar}>
      <View style={styles.line}>
        {BUSY.includes(status.kind) ? <LogoLoader size={12} /> : status.kind === 'live' ? <View style={styles.dot} /> : null}
        <Text style={[styles.text, status.kind === 'error' && styles.problem]}>{status.text}</Text>
      </View>
      {percent !== null && (
        <View style={styles.track} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" testID="sync-progress">
          <View style={[styles.fill, { width: `${percent}%` }]} />
        </View>
      )}
      {status.notice !== null && <Text style={styles.notice}>{status.notice}</Text>}
    </View>
  )
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    bar: { gap: 4 },
    line: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    text: { color: theme.ink2, fontSize: 13 },
    problem: { color: theme.danger, fontWeight: '600' },
    dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.know },
    track: { height: 2, borderRadius: 1, backgroundColor: theme.line, overflow: 'hidden' },
    fill: { height: 2, backgroundColor: theme.do },
    notice: { color: theme.ink2, fontSize: 13 },
  })
}
