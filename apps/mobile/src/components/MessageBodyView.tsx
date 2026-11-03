import { useEffect, useState } from 'react'
import { Alert, Linking, Pressable, StyleSheet, Text, View } from 'react-native'
import type { MessageAttachment, MessageBody } from '@tresso/core'
import { AttachmentRow } from '@/components/AttachmentRow'
import { HtmlFrame } from '@/components/HtmlFrame'
import { useMail } from '@/mail/MailProvider'
import { useTheme, type Theme } from '@/theme'
import { LogoLoader } from '@/components/LogoLoader'

/** One message's body: sanitized HTML in a locked-down web view, or its plain text. */
export function MessageBodyView({ messageId }: { messageId: string }) {
  const mail = useMail()
  const theme = useTheme()
  const styles = makeStyles(theme)
  const [body, setBody] = useState<MessageBody | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [remote, setRemote] = useState(false)
  const { body: load, unscannedLink } = mail

  /** Clean files open; one that could not be scanned only after the user confirms the warning. */
  function opener(file: MessageAttachment): (() => void) | null {
    const url = file.url
    if (file.access === 'allowed' && url !== null) {
      return () => void Linking.openURL(url)
    }
    if (file.access !== 'confirm') {
      return null
    }
    return () =>
      Alert.alert('Not scanned for malware', `${file.filename} could not be checked for malware. Open it only if you trust the sender.`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Download anyway',
          style: 'destructive',
          onPress: () => {
            unscannedLink(file.id)
              .then((link) => Linking.openURL(link))
              .catch((e: unknown) => Alert.alert('The file could not be opened', e instanceof Error ? e.message : String(e)))
          },
        },
      ])
  }

  useEffect(() => {
    let current = true
    load(messageId, remote)
      .then((loaded) => current && setBody(loaded))
      .catch((e: unknown) => current && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      current = false
    }
  }, [load, messageId, remote])

  if (error !== null) {
    return <Text style={styles.error}>{error}</Text>
  }
  if (body === null) {
    return <LogoLoader size={24} style={styles.loading} accessibilityLabel="Loading the message" />
  }

  // Inline images are part of the text; the rest are files to open.
  const files = body.attachments.filter((attachment) => !attachment.inline)

  return (
    <View style={styles.wrapper}>
      {body.hasRemoteContent && !body.remoteContentLoaded && (
        <Pressable
          style={styles.remote}
          onPress={() => {
            setError(null)
            setRemote(true)
          }}
          accessibilityRole="button"
          accessibilityLabel="Show images from the internet"
          accessibilityHint="Images from the internet are blocked so senders cannot see when you read their mail."
        >
          <Text style={styles.remoteLabel}>Images from the internet are blocked. Show them</Text>
        </Pressable>
      )}
      {body.html !== null ? (
        <HtmlFrame html={body.html} allowRemoteContent={body.remoteContentLoaded} accessibilityLabel="Message" />
      ) : (
        <Text style={styles.text} selectable>
          {body.text ?? ''}
        </Text>
      )}
      {files.length > 0 && (
        <View style={styles.files} accessibilityLabel="Attachments">
          {files.map((file) => {
            const open = opener(file)
            return <AttachmentRow key={file.id} filename={file.filename} size={file.size} scanStatus={file.scanStatus} {...(open === null ? {} : { onOpen: open })} />
          })}
        </View>
      )}
    </View>
  )
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    wrapper: { gap: 8 },
    files: { gap: 8 },
    text: { color: theme.ink, fontSize: 16, lineHeight: 24 },
    loading: { marginVertical: 16, alignSelf: 'center' },
    error: { color: theme.danger, fontSize: 14 },
    remote: { padding: 10, borderRadius: 6, backgroundColor: theme.ground },
    remoteLabel: { color: theme.accent, fontSize: 14, fontWeight: '600' },
  })
}
