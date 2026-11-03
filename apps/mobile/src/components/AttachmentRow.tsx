import { useMemo } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { fileSize, SCAN_TEXT, type ScanStatus } from '@tresso/core'
import { Icon } from '@/components/Icon'
import { useTheme, type Theme } from '@/theme'
import { LogoLoader } from '@/components/LogoLoader'

interface Props {
  filename: string
  /** null while it is still on its way. */
  size: number | null
  scanStatus: ScanStatus | null
  /** Opens the file; absent for one that cannot be opened (quarantined, on its way). */
  onOpen?: () => void
  onRemove?: () => void
}

/** One file of a message or a draft: its name, size and what the virus scan said, to open or remove. */
export function AttachmentRow({ filename, size, scanStatus, onOpen, onRemove }: Props) {
  const theme = useTheme()
  const styles = useMemo(() => makeStyles(theme), [theme])
  const blocked = scanStatus === 'infected'
  const detail = size === null || scanStatus === null ? 'Attaching…' : `${fileSize(size)}, ${SCAN_TEXT[scanStatus]}`

  return (
    <View style={[styles.row, blocked && styles.blocked]}>
      <Pressable
        style={styles.main}
        onPress={onOpen}
        disabled={onOpen === undefined}
        accessibilityRole={onOpen === undefined ? 'text' : 'button'}
        accessibilityLabel={`${filename}, ${detail}`}
        accessibilityHint={onOpen === undefined ? undefined : 'Opens the file'}
        accessibilityState={{ busy: size === null }}
      >
        {size === null ? <LogoLoader size={18} /> : <Icon name="file" size={18} color={blocked ? theme.danger : theme.ink2} />}
        <View style={styles.texts}>
          <Text style={styles.name} numberOfLines={1}>
            {filename}
          </Text>
          <Text style={[styles.detail, scanStatus === 'clean' && styles.clean, blocked && styles.dangerText]} numberOfLines={1}>
            {detail}
          </Text>
        </View>
      </Pressable>
      {onRemove !== undefined && (
        <Pressable style={styles.remove} onPress={onRemove} accessibilityRole="button" accessibilityLabel={`Remove attachment ${filename}`} hitSlop={4}>
          <Icon name="close" size={14} strokeWidth={2.4} color={theme.ink2} />
        </Pressable>
      )}
    </View>
  )
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center', minHeight: 48, paddingLeft: 12, paddingRight: 6, borderWidth: 1, borderColor: theme.line, borderRadius: 10, backgroundColor: theme.surface },
    blocked: { borderColor: theme.danger },
    main: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 },
    texts: { flex: 1, minWidth: 0 },
    name: { fontSize: 13, fontWeight: '600', color: theme.ink },
    detail: { fontSize: 12, color: theme.ink2 },
    clean: { color: theme.know },
    dangerText: { color: theme.danger },
    remove: { width: 36, height: 36, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  })
}
