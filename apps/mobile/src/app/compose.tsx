import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { Stack, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { sendLaterOptions, type Address, type AttachmentFile, type Draft, type SendLaterKey } from '@tresso/core'
import { AttachmentRow } from '@/components/AttachmentRow'
import { ChoiceSheet } from '@/components/ChoiceSheet'
import { HtmlFrame } from '@/components/HtmlFrame'
import { Icon, type IconName } from '@/components/Icon'
import { useComposer } from '@/compose/ComposerProvider'
import { LinkSheet } from '@/compose/LinkSheet'
import { pickDocuments, pickPhotos } from '@/compose/pickFiles'
import { MessageEditor, type EditorState, type MessageEditorHandle } from '@/compose/MessageEditor'
import { RecipientField } from '@/compose/RecipientField'
import { pickTimeOnAndroid, TimeSheet } from '@/compose/TimeSheet'
import { isFutureTime } from '@/compose/time'
import { useNotices } from '@/components/Notices'
import { useMail } from '@/mail/MailProvider'
import { useTheme, type Theme } from '@/theme'
import { LogoLoader } from '@/components/LogoLoader'

const TITLES: Record<Draft['kind'], string> = { new: 'New email', reply: 'Reply', replyAll: 'Reply all', forward: 'Forward' }

const LATER_DAYS: Record<SendLaterKey, string> = { thisEvening: 'This evening', tomorrowMorning: 'Tomorrow', tomorrowAfternoon: 'Tomorrow', mondayMorning: 'Monday' }

function time(at: Date): string {
  return at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function moment(at: Date): string {
  return at.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function hasContent(draft: Draft): boolean {
  return draft.to.length + draft.cc.length + draft.bcc.length > 0 || draft.subject.trim() !== '' || draft.html.trim() !== ''
}

const NO_FORMAT: EditorState = { type: 'state', bold: false, italic: false, bulletList: false, link: null, canUndo: false, canRedo: false }

/** Writing a message, a reply or a forward (the draft the composer has open). */
export default function ComposeScreen() {
  const { composer, state, accounts, signatures } = useComposer()
  const mail = useMail()
  const theme = useTheme()
  const styles = useMemo(() => makeStyles(theme), [theme])
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const notices = useNotices()
  const editor = useRef<MessageEditorHandle>(null)
  const draft = state.draft
  const [showCopies, setShowCopies] = useState(draft !== null && draft.cc.length + draft.bcc.length > 0)
  const [showLater, setShowLater] = useState(false)
  const [later, setLater] = useState<Date | null>(null)
  const [choosing, setChoosing] = useState<'account' | 'signature' | 'leave' | null>(null)
  const [linking, setLinking] = useState(false)
  const [format, setFormat] = useState<EditorState>(NO_FORMAT)
  const [showQuote, setShowQuote] = useState(false)
  // The quote with the images that go along through fresh links, for the quote it was made from.
  const [shownQuote, setShownQuote] = useState<{ quote: string; shown: string } | null>(null)
  const [laterError, setLaterError] = useState<string | null>(null)
  // Worked out when the row opens, not on every render: the times move with the clock.
  const [options, setOptions] = useState(() => sendLaterOptions())
  const [pickFrom, setPickFrom] = useState<Date | null>(null)
  // The revision the editor started with: a draft opened anew (undo, the other device's version) starts it over.
  const [editorRevision, setEditorRevision] = useState(state.revision)
  if (draft !== null && state.revision !== editorRevision) {
    setEditorRevision(state.revision)
  }

  const leave = useCallback(() => {
    if (router.canGoBack()) {
      router.back()
    } else {
      router.replace('/')
    }
  }, [router])

  // Sent, scheduled or thrown away: the screen goes.
  useEffect(() => {
    if (draft === null) {
      leave()
    }
  }, [draft, leave])

  // Leaving any other way (back, a swipe) keeps the draft.
  useEffect(
    () => () => {
      if (composer.state.draft !== null) {
        composer.close()
      }
    },
    [composer],
  )

  const update = useCallback((changes: Partial<Draft>) => composer.update(changes), [composer])

  const quote = draft?.quoteHtml ?? ''
  useEffect(() => {
    if (!showQuote || quote === '') {
      return
    }
    let current = true
    void composer.shownQuote(quote).then((shown) => {
      if (current) {
        setShownQuote({ quote, shown })
      }
    })
    return () => {
      current = false
    }
  }, [composer, showQuote, quote])

  // The server sends files that could not be scanned only once the user confirmed them.
  const unscanned = state.unscannedToConfirm
  useEffect(() => {
    if (unscanned === null) {
      return
    }
    Alert.alert('Send files that were not scanned?', `${unscanned.message} Files that were not checked can contain malware.`, [
      { text: 'Keep editing', style: 'cancel', onPress: () => composer.keepEditing() },
      { text: 'Send anyway', style: 'destructive', onPress: () => void composer.sendAnyway() },
    ])
  }, [unscanned, composer])

  if (draft === null) {
    return null
  }

  const account = accounts.find((candidate) => candidate.id === draft.mailAccountId) ?? null
  // Images of the quote are shown in it, not as files.
  const files = draft.attachments.filter((attachment) => !attachment.inline)
  const signature = signatures.find((candidate) => candidate.id === draft.signatureId) ?? null

  function changeAccount(id: string): void {
    const current = composer.state.draft
    if (current === null) {
      return
    }
    // The signature follows the account, unless the user picked another one.
    const keepSignature = current.signatureId !== composer.defaultSignature(current.mailAccountId)
    update({ mailAccountId: id, ...(keepSignature ? {} : { signatureId: composer.defaultSignature(id) }) })
  }

  function send(): void {
    if (later !== null && !isFutureTime(later)) {
      setShowLater(true)
      setLaterError('That time has passed. Pick another, or send now.')
      return
    }
    setLaterError(null)
    void composer.send(later ?? undefined)
  }

  async function pickTime(): Promise<void> {
    // A chosen time that has passed meanwhile is no place to start from.
    const initial = later !== null && isFutureTime(later) ? later : (sendLaterOptions()[0]?.at ?? new Date(Date.now() + 3_600_000))
    if (Platform.OS === 'android') {
      const at = await pickTimeOnAndroid(initial)
      if (at !== null) {
        if (isFutureTime(at)) {
          setLater(at)
          setLaterError(null)
        } else {
          setLaterError('Pick a time in the future.')
        }
      }
      return
    }
    setPickFrom(initial)
  }

  async function attachFrom(pick: () => Promise<AttachmentFile[]>): Promise<void> {
    try {
      const files = await pick()
      await composer.attach(files)
    } catch (error) {
      notices.notify({ text: `The files could not be picked: ${error instanceof Error ? error.message : String(error)}`, tone: 'error' })
    }
  }

  async function openAttachment(id: string): Promise<void> {
    try {
      const link = await composer.attachmentLink(id)
      if (link?.access === 'confirm') {
        Alert.alert('Not scanned for malware', 'This file could not be checked for malware. Open it only if you trust where it came from.', [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Open anyway',
            style: 'destructive',
            onPress: () => {
              composer
                .unscannedAttachmentLink(id)
                .then((url) => Linking.openURL(url))
                .catch((error: unknown) => notices.notify({ text: `The file could not be opened: ${error instanceof Error ? error.message : String(error)}`, tone: 'error' }))
            },
          },
        ])
        return
      }
      if (link === null || link.url === null) {
        const reason = link?.access === 'scanning' ? 'It is still being scanned for malware.' : 'It contains malware, or this server only opens scanned files.'
        notices.notify({ text: `This file cannot be opened. ${reason}`, tone: 'error' })
        return
      }
      await Linking.openURL(link.url)
    } catch (error) {
      notices.notify({ text: `The file could not be opened: ${error instanceof Error ? error.message : String(error)}`, tone: 'error' })
    }
  }

  function cancel(): void {
    if (hasContent(draft!)) {
      setChoosing('leave')
      return
    }
    void composer.discard()
  }

  const recipientsField = (label: string, key: 'to' | 'cc' | 'bcc', extra?: React.ReactNode, autoFocus?: boolean) => (
    <RecipientField label={label} recipients={draft[key]} onChange={(next: Address[]) => update({ [key]: next })} suggest={mail.suggestContacts} trailing={extra} autoFocus={autoFocus} />
  )

  return (
    <>
      <Stack.Screen options={{ headerShown: false, presentation: 'modal' }} />
      <KeyboardAvoidingView style={[styles.screen, { paddingTop: Platform.OS === 'android' ? insets.top : 0 }]} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <View style={styles.header}>
          <Pressable style={styles.textButton} onPress={cancel} accessibilityRole="button" hitSlop={4}>
            <Text style={styles.textButtonLabel}>Cancel</Text>
          </Pressable>
          <Text style={styles.title} accessibilityRole="header" numberOfLines={1}>
            {TITLES[draft.kind]}
          </Text>
          <Pressable
            style={[styles.round, (showLater || later !== null) && styles.roundOn]}
            onPress={() => {
              setOptions(sendLaterOptions())
              setShowLater((open) => !open)
            }}
            accessibilityRole="button"
            accessibilityLabel="Send later"
            accessibilityState={{ expanded: showLater }}
          >
            <Icon name="clock" color={theme.ink} />
          </Pressable>
          <Pressable
            style={[styles.send, state.sending && styles.dimmed]}
            onPress={send}
            disabled={state.sending}
            accessibilityRole="button"
            accessibilityState={{ busy: state.sending, disabled: state.sending }}
            accessibilityLabel={later === null ? 'Send' : `Schedule for ${moment(later)}`}
          >
            {state.sending && <LogoLoader size={16} color={theme.surface} />}
            <Text style={styles.sendLabel}>{state.sending ? 'Sending…' : later === null ? 'Send' : 'Schedule'}</Text>
            {!state.sending && <Icon name="send" size={16} color={theme.surface} />}
          </Pressable>
        </View>

        {showLater && (
          <View style={styles.laterRow} accessibilityRole="radiogroup" accessibilityLabel="Send later">
            <LaterChip label="Send now" on={later === null} onPress={() => { setLater(null); setLaterError(null) }} styles={styles} />
            {options.map((option) => (
              <LaterChip
                key={option.key}
                label={`${LATER_DAYS[option.key]} ${time(option.at)}`}
                on={later !== null && later.getTime() === option.at.getTime()}
                onPress={() => { setLater(option.at); setLaterError(null) }}
                styles={styles}
              />
            ))}
            <LaterChip
              label={later !== null && !options.some((option) => option.at.getTime() === later.getTime()) ? moment(later) : 'Pick a time'}
              on={later !== null && !options.some((option) => option.at.getTime() === later.getTime())}
              onPress={() => void pickTime()}
              styles={styles}
            />
            {laterError !== null && (
              <Text style={styles.laterError} accessibilityRole="alert">
                {laterError}
              </Text>
            )}
          </View>
        )}

        {state.conflict && (
          <View style={styles.conflict} accessibilityRole="alert">
            <Text style={styles.conflictText}>This draft was changed on another device.</Text>
            <View style={styles.conflictButtons}>
              <Pressable style={styles.smallButton} onPress={() => void composer.resolveConflict('mine')} accessibilityRole="button">
                <Text style={styles.smallButtonLabel}>Keep mine</Text>
              </Pressable>
              <Pressable style={styles.smallButton} onPress={() => void composer.resolveConflict('theirs')} accessibilityRole="button">
                <Text style={styles.smallButtonLabel}>Use the other</Text>
              </Pressable>
            </View>
          </View>
        )}

        <ScrollView style={styles.scroll} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          <View style={styles.row}>
            <Text style={styles.label}>From</Text>
            <Pressable
              style={styles.from}
              onPress={() => setChoosing('account')}
              accessibilityRole="button"
              accessibilityLabel={account === null ? 'Choose the account to send from' : `From ${account.displayName}, ${account.emailAddress}. Change account`}
            >
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>{(account?.displayName ?? '?').slice(0, 1).toUpperCase()}</Text>
              </View>
              <Text style={styles.fromText} numberOfLines={1}>
                {account?.emailAddress ?? 'Choose an account'}
              </Text>
              <Icon name="chevronDown" size={14} color={theme.ink2} />
            </Pressable>
          </View>

          {recipientsField(
            'To',
            'to',
            !showCopies ? (
              <Pressable style={styles.copies} onPress={() => setShowCopies(true)} accessibilityRole="button" accessibilityLabel="Add Cc and Bcc">
                <Text style={styles.copiesLabel}>Cc Bcc</Text>
              </Pressable>
            ) : undefined,
            draft.kind === 'new' && draft.to.length === 0,
          )}
          {showCopies && recipientsField('Cc', 'cc')}
          {showCopies && recipientsField('Bcc', 'bcc')}

          <View style={[styles.row, styles.subjectRow]}>
            <Text style={styles.label}>Subject</Text>
            <TextInput
              style={styles.subject}
              value={draft.subject}
              onChangeText={(subject) => update({ subject: subject.replace(/[\r\n]+/g, ' ') })}
              maxLength={998}
              returnKeyType="next"
              onSubmitEditing={() => editor.current?.run({ type: 'focus' })}
              submitBehavior="submit"
              accessibilityLabel="Subject"
            />
          </View>

          <MessageEditor key={editorRevision} ref={editor} initialHtml={draft.html} onChange={(html) => update({ html })} onState={setFormat} />

          {draft.quoteHtml !== '' && (
            <View style={styles.block}>
              <Pressable style={styles.quoteToggle} onPress={() => setShowQuote((open) => !open)} accessibilityRole="button" accessibilityState={{ expanded: showQuote }}>
                <Text style={styles.quoteToggleLabel}>{showQuote ? 'Hide the original message' : draft.kind === 'forward' ? 'Forwarded message included' : 'Original message included'}</Text>
              </Pressable>
              {showQuote && <HtmlFrame html={shownQuote?.quote === draft.quoteHtml ? shownQuote.shown : draft.quoteHtml} allowRemoteContent={false} accessibilityLabel="Original message" />}
            </View>
          )}

          <View style={styles.signature}>
            <View style={styles.signatureText}>
              {signature !== null ? (
                <HtmlFrame html={signature.html} allowRemoteContent={false} accessibilityLabel={`Signature ${signature.name}`} initialHeight={40} />
              ) : (
                <Text style={styles.muted}>No signature</Text>
              )}
            </View>
            <Pressable style={styles.smallButton} onPress={() => setChoosing('signature')} accessibilityRole="button" accessibilityLabel={`Signature: ${signature?.name ?? 'none'}. Change`}>
              <Text style={styles.smallButtonLabel}>Signature: {signature?.name ?? 'None'}</Text>
            </Pressable>
          </View>

          {(files.length > 0 || state.attaching.length > 0) && (
            <View style={styles.files} accessibilityLabel="Attachments">
              {files.map((attachment) => (
                <AttachmentRow
                  key={attachment.id}
                  filename={attachment.filename}
                  size={attachment.size}
                  scanStatus={attachment.scanStatus}
                  {...(attachment.scanStatus === 'infected' ? {} : { onOpen: () => void openAttachment(attachment.id) })}
                  onRemove={() => void composer.removeAttachment(attachment.id)}
                />
              ))}
              {state.attaching.map((name, index) => (
                <AttachmentRow key={`attaching-${index}`} filename={name} size={null} scanStatus={null} />
              ))}
            </View>
          )}

          {state.error !== null && (
            <Text style={styles.error} accessibilityRole="alert">
              {state.error}
            </Text>
          )}
          {Object.entries(state.violations).map(([field, problem]) => (
            <Text key={field} style={styles.error}>
              {problem}
            </Text>
          ))}
        </ScrollView>

        <View style={[styles.toolbar, { paddingBottom: Platform.OS === 'ios' ? 4 : insets.bottom + 4 }]} accessibilityRole="toolbar" accessibilityLabel="Formatting">
          <FormatButton label="Bold" icon="bold" on={format.bold} onPress={() => editor.current?.run({ type: 'bold' })} styles={styles} theme={theme} />
          <FormatButton label="Italic" icon="italic" on={format.italic} onPress={() => editor.current?.run({ type: 'italic' })} styles={styles} theme={theme} />
          <FormatButton label="Bulleted list" icon="list" on={format.bulletList} onPress={() => editor.current?.run({ type: 'bulletList' })} styles={styles} theme={theme} />
          <FormatButton label={format.link === null ? 'Insert link' : 'Edit link'} icon="link" on={format.link !== null} onPress={() => setLinking(true)} styles={styles} theme={theme} />
          <View style={styles.spacer} />
          {state.savedAt !== null && <Text style={styles.saved}>Draft saved</Text>}
          <FormatButton label="Attach file" icon="attach" on={false} onPress={() => void attachFrom(pickDocuments)} styles={styles} theme={theme} />
          <FormatButton label="Insert photo" icon="photo" on={false} onPress={() => void attachFrom(pickPhotos)} styles={styles} theme={theme} />
        </View>
      </KeyboardAvoidingView>

      <ChoiceSheet
        visible={choosing === 'account'}
        title="Send from"
        choices={accounts.map((candidate) => ({ key: candidate.id, label: candidate.displayName, detail: candidate.emailAddress, selected: candidate.id === draft.mailAccountId }))}
        onChoose={(id) => {
          setChoosing(null)
          changeAccount(id)
        }}
        onClose={() => setChoosing(null)}
      />
      <ChoiceSheet
        visible={choosing === 'signature'}
        title="Signature"
        choices={[
          { key: '', label: 'No signature', selected: draft.signatureId === null },
          ...signatures.map((candidate) => ({ key: candidate.id, label: candidate.name, selected: candidate.id === draft.signatureId })),
        ]}
        onChoose={(id) => {
          setChoosing(null)
          update({ signatureId: id === '' ? null : id })
        }}
        onClose={() => setChoosing(null)}
      />
      <ChoiceSheet
        visible={choosing === 'leave'}
        title="Keep this draft?"
        choices={[
          { key: 'save', label: 'Save draft', detail: 'Find it in Drafts on every device' },
          { key: 'delete', label: 'Delete draft', tone: 'danger' },
        ]}
        onChoose={(choice) => {
          setChoosing(null)
          if (choice === 'save') {
            composer.close()
          } else {
            void composer.discard()
          }
        }}
        onClose={() => setChoosing(null)}
      />
      {linking && (
        <LinkSheet
          current={format.link}
          onDone={(href) => {
            setLinking(false)
            editor.current?.run({ type: 'link', href })
          }}
          onClose={() => setLinking(false)}
        />
      )}
      {pickFrom !== null && (
        <TimeSheet
          initial={pickFrom}
          onPick={(at) => {
            setPickFrom(null)
            setLater(at)
            setLaterError(null)
          }}
          onClose={() => setPickFrom(null)}
        />
      )}
    </>
  )
}

type Styles = ReturnType<typeof makeStyles>

function LaterChip({ label, on, onPress, styles }: { label: string; on: boolean; onPress: () => void; styles: Styles }) {
  return (
    <Pressable style={[styles.chip, on && styles.chipOn]} onPress={onPress} accessibilityRole="radio" accessibilityState={{ checked: on }}>
      <Text style={styles.chipLabel}>{label}</Text>
    </Pressable>
  )
}

function FormatButton({ label, icon, on, onPress, styles, theme }: { label: string; icon: IconName; on: boolean; onPress: () => void; styles: Styles; theme: Theme }) {
  return (
    <Pressable style={[styles.format, on && styles.formatOn]} onPress={onPress} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: on }}>
      <Icon name={icon} color={theme.ink} />
    </Pressable>
  )
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.surface },
    header: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 12, paddingTop: 12, paddingBottom: 8 },
    textButton: { height: 44, paddingHorizontal: 8, justifyContent: 'center', borderRadius: 6 },
    textButtonLabel: { fontSize: 15, fontWeight: '600', color: theme.ink2 },
    title: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '600', color: theme.ink },
    round: { width: 44, height: 44, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
    roundOn: { backgroundColor: theme.ground },
    send: { height: 40, paddingHorizontal: 16, borderRadius: 999, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: theme.ink },
    sendLabel: { fontSize: 15, fontWeight: '600', color: theme.surface },
    dimmed: { opacity: 0.6 },
    laterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16, paddingBottom: 12 },
    chip: { height: 36, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: theme.lineStrong, justifyContent: 'center', backgroundColor: theme.surface },
    chipOn: { borderColor: theme.ink, backgroundColor: theme.line },
    chipLabel: { fontSize: 13, fontWeight: '600', color: theme.ink },
    laterError: { width: '100%', fontSize: 13, color: theme.danger },
    conflict: { marginHorizontal: 16, marginBottom: 8, padding: 12, borderRadius: 10, backgroundColor: theme.ground, gap: 8 },
    conflictText: { fontSize: 14, color: theme.ink },
    conflictButtons: { flexDirection: 'row', gap: 8 },
    scroll: { flex: 1 },
    content: { paddingBottom: 24 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52, paddingHorizontal: 16, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.line },
    subjectRow: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.line },
    label: { width: 52, fontSize: 14, color: theme.ink2 },
    from: { flexShrink: 1, flexDirection: 'row', alignItems: 'center', gap: 8, height: 32, paddingLeft: 4, paddingRight: 10, borderRadius: 999, borderWidth: 1, borderColor: theme.lineStrong },
    avatar: { width: 24, height: 24, borderRadius: 999, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.accent },
    avatarText: { fontSize: 11, fontWeight: '700', color: theme.onAccent },
    fromText: { flexShrink: 1, fontSize: 13, fontWeight: '500', color: theme.ink },
    copies: { height: 30, paddingHorizontal: 4, justifyContent: 'center' },
    copiesLabel: { fontSize: 13, fontWeight: '600', color: theme.ink2 },
    subject: { flex: 1, minWidth: 0, height: 44, fontSize: 15, fontWeight: '600', color: theme.ink },
    block: { marginHorizontal: 16, marginTop: 8, gap: 8 },
    quoteToggle: { minHeight: 36, justifyContent: 'center' },
    quoteToggleLabel: { fontSize: 13, fontWeight: '600', color: theme.accent },
    signature: { marginHorizontal: 16, marginTop: 8, padding: 10, borderRadius: 10, backgroundColor: theme.ground, flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
    signatureText: { flex: 1, minWidth: 0 },
    muted: { fontSize: 13, color: theme.ink2, paddingVertical: 6 },
    smallButton: { minHeight: 32, paddingHorizontal: 10, borderRadius: 6, justifyContent: 'center' },
    smallButtonLabel: { fontSize: 12, fontWeight: '600', color: theme.ink2 },
    error: { marginHorizontal: 16, marginTop: 12, fontSize: 14, color: theme.danger },
    files: { marginHorizontal: 16, marginTop: 10, gap: 8 },
    toolbar: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingHorizontal: 8, paddingTop: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.line, backgroundColor: theme.surface },
    format: { width: 44, height: 44, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
    formatOn: { backgroundColor: theme.line },
    spacer: { flex: 1 },
    saved: { paddingRight: 8, fontSize: 12, color: theme.ink2 },
  })
}
