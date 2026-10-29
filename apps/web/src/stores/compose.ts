import { computed, ref, shallowRef, watch } from 'vue'
import { defineStore } from 'pinia'
import { Composer, type Address, type AttachmentAccess, type ComposerNotice, type ComposerState, type SyncedMessage } from '@tresso/core'
import { ApiError, errorMessage } from '@/api/errors'
import type { Draft } from '@/mail/db'
import { useMailStore } from '@/stores/mail'

export { UNDO_SECONDS } from '@tresso/core'

export interface Notice extends ComposerNotice {
  id: number
}

/**
 * What the user is writing, on top of the shared Composer (`packages/core/src/composer.ts`): drafts are saved on this
 * device while typing and kept until the message is confirmed sent, so nothing is lost on a reload and a failed
 * message can be edited and sent again. The compose window's own state (minimized, notices) lives here.
 */
export const useComposeStore = defineStore('compose', () => {
  const mail = useMailStore()

  const minimized = ref(false)
  const notices = ref<Notice[]>([])
  let noticeId = 0

  function notify(notice: ComposerNotice, ms = 8000): void {
    const id = ++noticeId
    notices.value = [...notices.value, { ...notice, id }]
    setTimeout(() => dismiss(id), ms)
  }

  function dismiss(id: number): void {
    notices.value = notices.value.filter((notice) => notice.id !== id)
  }

  const composer = new Composer({
    store: () => mail.currentStore(),
    drafts: mail.draftSync,
    accounts: () => mail.accounts,
    signatures: () => mail.signatures,
    defaultAccount: () => mail.mailbox ?? mail.accounts[0]?.id ?? null,
    body: (messageId) => mail.body(messageId, false),
    send: (request) => mail.send(request),
    cancel: (outgoingId) => mail.cancelOutgoing(outgoingId),
    notify,
    explain: (error) => ({ message: errorMessage(error), violations: error instanceof ApiError ? error.violations : {} }),
    changed: () => {
      mail.refresh().catch((error: unknown) => console.error('Refreshing the lists failed', error))
    },
  })

  // The composer's state, for templates; replaced whole on every change, so a shallow ref is enough.
  const state = shallowRef<ComposerState>(composer.state)
  /** What a restart would cut short (Composer.unfinished), for the update that waits for it. */
  const unfinished = ref(composer.unfinished)
  composer.subscribe(() => {
    state.value = composer.state
    unfinished.value = composer.unfinished
  })

  const draft = computed(() => state.value.draft)
  const revision = computed(() => state.value.revision)
  const savedAt = computed(() => state.value.savedAt)
  const sending = computed(() => state.value.sending)
  const error = computed(() => state.value.error)
  const violations = computed(() => state.value.violations)
  const conflict = computed(() => state.value.conflict)
  const undoable = computed(() => state.value.undoable)
  const attaching = computed(() => state.value.attaching)
  const unscannedToConfirm = computed(() => state.value.unscannedToConfirm)

  /** Attaches files the user picked or dropped. */
  function attach(files: File[]): Promise<void> {
    return composer.attach(files.map((file) => ({ name: file.name, type: file.type, size: file.size, body: file })))
  }

  /**
   * Opens one of the draft's files in a new tab, through a fresh link. A file that could not be scanned only opens
   * with `acceptUnscanned`, once the user confirmed the warning.
   */
  async function openAttachment(attachmentId: string, acceptUnscanned = false): Promise<void> {
    // Opened at once, in the click, so the browser does not block it; the link follows. Not with noopener, which
    // gives no handle to the tab; the tab loses its way back to this page by hand instead.
    const opened = window.open('about:blank', '_blank')
    if (opened === null) {
      notify({ text: 'The file could not be opened: the browser blocked the new tab.', tone: 'error' })
      return
    }
    opened.opener = null
    try {
      const link = await composer.attachmentLink(attachmentId)
      const url = link?.access === 'confirm' && acceptUnscanned ? await composer.unscannedAttachmentLink(attachmentId) : (link?.url ?? null)
      if (url === null) {
        opened.close()
        notify({ text: unavailable(link?.access ?? 'blocked'), tone: 'error' })
        return
      }
      opened.location.href = url
    } catch (error) {
      opened.close()
      notify({ text: `The file could not be opened: ${errorMessage(error)}`, tone: 'error' })
    }
  }

  function unavailable(access: AttachmentAccess): string {
    switch (access) {
      case 'scanning':
        return 'This file is still being scanned for malware. Try again in a moment.'
      case 'confirm':
        return 'This file could not be scanned for malware. Confirm the warning to open it.'
      default:
        return 'This file is blocked: it contains malware, or this server only opens scanned files.'
    }
  }

  /** Opening a draft brings the compose window up again; asking for one that is gone leaves it as it is. */
  async function open(run: () => void | Promise<void>): Promise<void> {
    const before = composer.state.revision
    await run()
    if (composer.state.revision !== before && composer.state.draft !== null) {
      minimized.value = false
    }
  }

  function openNew(to: Address[] = []): void {
    void open(() => composer.openNew(to))
  }

  function openReply(message: SyncedMessage, kind: 'reply' | 'replyAll' | 'forward'): Promise<void> {
    return open(() => composer.openReply(message, kind))
  }

  function openDraft(id: string): Promise<void> {
    return open(() => composer.openDraft(id))
  }

  /** Opens a message written for the user, such as a follow-up to someone a conversation was handed over to. */
  function openPrepared(fields: Parameters<Composer['openPrepared']>[0]): void {
    void open(() => composer.openPrepared(fields))
  }

  function update(changes: Partial<Draft>): void {
    composer.update(changes)
  }

  watch(
    () => mail.outbox,
    () => void composer.followUp(),
  )

  return {
    draft,
    revision,
    conflict,
    resolveConflict: (keep: 'mine' | 'theirs') => composer.resolveConflict(keep),
    minimized,
    savedAt,
    sending,
    error,
    violations,
    notices,
    undoable,
    attaching,
    attach,
    unfinished,
    saveNow: () => composer.saveNow(),
    removeAttachment: (attachmentId: string) => composer.removeAttachment(attachmentId),
    openAttachment,
    unscannedToConfirm,
    sendAnyway: () => composer.sendAnyway(),
    keepEditing: () => composer.keepEditing(),
    shownQuote: (quoteHtml: string) => composer.shownQuote(quoteHtml),
    openNew,
    openReply,
    defaultSignature: (mailAccountId: string | null) => composer.defaultSignature(mailAccountId),
    openDraft,
    openPrepared,
    update,
    discard: () => composer.discard(),
    close: () => composer.close(),
    send: (sendAt?: Date) => composer.send(sendAt),
    undo: () => composer.undo(),
    dismiss,
    notify,
    followUp: () => composer.followUp(),
    draftFor: (outgoingId: string) => composer.draftFor(outgoingId),
  }
})
