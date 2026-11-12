import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SendMessageRequest } from './compose'
import { Composer, OriginalUnavailableError, type ComposerDeps, type ComposerNotice } from './composer'
import { DraftSync } from './drafts'
import { uuidV7Time } from './ids'
import { ApiFailure, FakeDraftApi } from './drafts.fake'
import { accounts, message, page, signature } from './store/contract'
import { memorySql } from './store/memorySql'
import { SqliteMailStore } from './store/sqlite'
import type { MessageAttachment, SyncedOutgoingMessage } from './sync/types'

function outgoing(status: SyncedOutgoingMessage['status'], lastError: string | null = null): SyncedOutgoingMessage {
  return { id: 'o1', mailAccountId: 'work', status, subject: 'Re: Budget', recipients: { to: [], cc: [], bcc: [] }, sendAt: '2026-10-19T09:00:00Z', sentAt: null, lastError, inReplyToMessageId: 'm1' }
}

const original = message('m1', 't1', 'work', ['work-inbox'], '2026-10-19T08:00:00+00:00', { subject: 'Budget' })

describe('Composer', () => {
  let store: SqliteMailStore
  let sent: SendMessageRequest[]
  /** Every request to send, also those that failed. */
  let tried: SendMessageRequest[]
  let cancelled: string[]
  let notices: ComposerNotice[]
  let api: FakeDraftApi
  let originalFiles: MessageAttachment[]
  let originalHtml: string
  let sendFails: unknown
  let sendGate: Promise<void> | null
  let currentStore: SqliteMailStore | null
  let changes: number
  let bodyFails: unknown
  let deps: ComposerDeps
  let composer: Composer

  beforeEach(async () => {
    vi.useFakeTimers()
    store = await SqliteMailStore.open(await memorySql())
    await store.apply(page({ cursor: 1, mailAccounts: accounts, signatures: [signature('sig-work', 'Work')] }))
    sent = []
    tried = []
    cancelled = []
    notices = []
    sendFails = null
    sendGate = null
    currentStore = store
    changes = 0
    api = new FakeDraftApi()
    originalFiles = []
    originalHtml = '<p>Numbers?</p>'
    bodyFails = null
    deps = {
      store: () => currentStore,
      drafts: new DraftSync(() => currentStore, api),
      accounts: () => accounts,
      signatures: () => [signature('sig-work', 'Work')],
      defaultAccount: () => 'work',
      body: async () => {
        if (bodyFails !== null) throw bodyFails
        return { html: originalHtml, text: null, attachments: originalFiles }
      },
      send: async (request) => {
        tried.push(request)
        await sendGate
        if (sendFails !== null) throw sendFails
        sent.push(request)
        return outgoing('scheduled')
      },
      cancel: async (id) => {
        cancelled.push(id)
        return outgoing('cancelled')
      },
      notify: (notice) => notices.push(notice),
      explain: (error) => ({ message: error instanceof Error ? error.message : String(error), violations: error instanceof ApiFailure ? error.violations : {} }),
      changed: () => (changes += 1),
    }
    composer = new Composer(deps)
  })

  afterEach(() => {
    composer.dispose()
    vi.useRealTimers()
  })

  it('opens a new message from the default account with its signature, and tells listeners', () => {
    const listener = vi.fn()
    composer.subscribe(listener)

    composer.openNew([{ address: 'anna@example.test', name: null }])

    expect(composer.state.draft).toMatchObject({ kind: 'new', mailAccountId: 'work', signatureId: 'sig-work', to: [{ address: 'anna@example.test' }] })
    expect(composer.state.revision).toBe(1)
    expect(listener).toHaveBeenCalled()
  })

  it('saves and uploads shortly after typing stops', async () => {
    composer.openNew()
    composer.update({ subject: 'Hello' })
    expect(await store.draft(composer.state.draft!.id)).toBeNull()

    await vi.advanceTimersByTimeAsync(1000)

    expect(await store.draft(composer.state.draft!.id)).toMatchObject({ subject: 'Hello', version: 1, pendingSave: false })
    expect(composer.state.savedAt).not.toBeNull()
  })

  it('saves at once for a restart, without waiting for typing to stop or for the upload', async () => {
    composer.openNew()
    composer.update({ subject: 'Before the update' })
    const id = composer.state.draft!.id

    await composer.saveNow()

    expect(await store.draft(id)).toMatchObject({ subject: 'Before the update', pendingSave: true })
    // The upload is left for after the restart, and the timer is gone: nothing saves the same edits again.
    await vi.advanceTimersByTimeAsync(1000)
    expect(api.calls).toEqual([])
  })

  it('waits for a save that is already under way', async () => {
    composer.openNew()
    composer.update({ subject: 'Typed' })
    const id = composer.state.draft!.id
    // The timer fires and the save starts; saveNow comes while it writes.
    vi.advanceTimersByTime(1000)

    await composer.saveNow()

    expect(await store.draft(id)).toMatchObject({ subject: 'Typed' })
  })

  it('refuses a restart when the draft cannot be saved, and saves it again on the next try', async () => {
    composer.openNew()
    composer.update({ subject: 'Not lost' })
    const id = composer.state.draft!.id
    vi.spyOn(store, 'changeDraft').mockRejectedValueOnce(new Error('disk full'))

    await expect(composer.saveNow()).rejects.toThrow('The draft could not be saved: disk full')
    expect(await store.draft(id)).toBeNull()

    // Nothing was typed since: the edits that failed are written now.
    await composer.saveNow()
    expect(await store.draft(id)).toMatchObject({ subject: 'Not lost' })
  })

  it('refuses a restart when the save of a draft put away failed', async () => {
    composer.openNew()
    composer.update({ subject: 'Put away' })
    vi.spyOn(store, 'changeDraft').mockRejectedValueOnce(new Error('disk full'))
    composer.close()

    await expect(composer.saveNow()).rejects.toThrow('could not be saved')
  })

  it('keeps saving what is typed while it saves, rather than calling that a failure', async () => {
    composer.openNew()
    composer.update({ subject: 'First' })
    const id = composer.state.draft!.id
    const changeDraft = store.changeDraft.bind(store)
    let typedOnce = false
    vi.spyOn(store, 'changeDraft').mockImplementation(async (draftId, change) => {
      if (!typedOnce) {
        typedOnce = true
        composer.update({ subject: 'Second' })
      }
      return changeDraft(draftId, change)
    })

    await composer.saveNow()

    expect(await store.draft(id)).toMatchObject({ subject: 'Second' })
  })

  it('has nothing to save, and so nothing failed, once the copy is gone', async () => {
    composer.openNew()
    composer.update({ subject: 'Signed out' })
    currentStore = null

    await expect(composer.saveNow()).resolves.toBeUndefined()
  })

  it('moves the open draft to a copy opened again for the same user, saves it there and uploads it', async () => {
    composer.openNew([{ address: 'anna@example.test', name: null }])
    composer.update({ subject: 'Before' })
    const id = composer.state.draft!.id
    const reopened = await SqliteMailStore.open(await memorySql())
    await reopened.apply(page({ cursor: 1, mailAccounts: accounts }))
    currentStore = reopened

    // Typed while the copy was replaced: nowhere to keep it until the draft moves.
    composer.update({ subject: 'After' })
    await composer.rebind()

    expect(await reopened.draft(id)).toMatchObject({ subject: 'After', pendingSave: false, version: 1 })
    expect(api.drafts.get(id)).toMatchObject({ subject: 'After' })
    await composer.send()
    expect(composer.state.error).toBeNull()
    expect(sent).toHaveLength(1)
  })

  it('moves nothing when no draft is open, or the copy is the one the draft is in', async () => {
    await composer.rebind()
    expect(api.calls).toEqual([])

    composer.openNew()
    await composer.rebind()
    expect(await store.draft(composer.state.draft!.id)).toBeNull()
  })

  it('does not write a draft being sent into the copy that replaced its own', async () => {
    composer.openNew([{ address: 'anna@example.test', name: null }])
    composer.update({ subject: 'Going out' })
    const id = composer.state.draft!.id
    let sendNow: (() => void) | null = null
    sendGate = new Promise<void>((resolve) => (sendNow = resolve))
    const sending = composer.send()
    await vi.waitFor(() => expect(composer.unfinished).toBe('sending'))
    const reopened = await SqliteMailStore.open(await memorySql())
    currentStore = reopened

    await composer.rebind()
    sendNow!()
    await sending

    expect(sent).toHaveLength(1)
    expect(await reopened.draft(id)).toBeNull()
  })

  it('does not write back a draft that is being sent', async () => {
    composer.openNew([{ address: 'anna@example.test', name: null }])
    composer.update({ subject: 'Going out' })
    const id = composer.state.draft!.id
    let sendNow: (() => void) | null = null
    sendGate = new Promise<void>((resolve) => (sendNow = resolve))
    const sending = composer.send()
    await vi.waitFor(() => expect(composer.unfinished).toBe('sending'))

    const saving = composer.saveNow()
    sendNow!()
    await Promise.all([sending, saving])

    expect(await store.draft(id)).toMatchObject({ outgoingId: 'o1', pendingSave: false })
  })

  it('holds autosaves while the message is being sent, and saves edits made meanwhile once a send fails', async () => {
    composer.openNew([{ address: 'anna@example.test', name: null }])
    composer.update({ subject: 'Going out' })
    const id = composer.state.draft!.id
    let sendNow: (() => void) | null = null
    sendGate = new Promise<void>((resolve) => (sendNow = resolve))
    sendFails = new Error('server down')
    const sending = composer.send()
    // The send wrote and uploaded its draft, and now waits for the server.
    await vi.waitFor(() => expect(api.calls).toContain(`create ${id}`))
    const changeDraft = vi.spyOn(store, 'changeDraft')

    composer.update({ subject: 'Typed during the send' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(changeDraft).not.toHaveBeenCalled()

    sendNow!()
    await sending
    await vi.advanceTimersByTimeAsync(1000)
    expect(await store.draft(id)).toMatchObject({ subject: 'Typed during the send', outgoingId: null })
  })

  it('writes nothing of a draft being deleted, while another draft saves as usual', async () => {
    composer.openNew()
    composer.update({ subject: 'To be deleted' })
    const deleted = composer.state.draft!.id
    await vi.advanceTimersByTimeAsync(1000)
    const deleteDraft = store.deleteDraft.bind(store)
    let deleteNow: (() => void) | null = null
    const gate = new Promise<void>((resolve) => (deleteNow = resolve))
    vi.spyOn(store, 'deleteDraft').mockImplementation(async (id) => {
      await gate
      return deleteDraft(id)
    })
    const discarding = composer.discard()
    await vi.waitFor(() => expect(deleteNow).not.toBeNull())
    expect(composer.unfinished).toBe('deleting')

    // Typed while it goes, then another draft opened, which saves the first one were it not held.
    composer.update({ subject: 'Typed during the delete' })
    composer.openNew()
    composer.update({ subject: 'Another draft' })
    const other = composer.state.draft!.id
    await vi.advanceTimersByTimeAsync(1000)
    expect(await store.draft(other)).toMatchObject({ subject: 'Another draft' })

    deleteNow!()
    await discarding
    await vi.advanceTimersByTimeAsync(1000)
    expect(await store.draft(deleted)).toBeNull()
    expect(composer.unfinished).toBeNull()
  })

  it('does not delete a draft while it is being sent', async () => {
    composer.openNew([{ address: 'anna@example.test', name: null }])
    let sendNow: (() => void) | null = null
    sendGate = new Promise<void>((resolve) => (sendNow = resolve))
    const sending = composer.send()
    await vi.waitFor(() => expect(composer.unfinished).toBe('sending'))

    expect(await composer.discard()).toBe(false)
    sendNow!()
    await sending
    expect(api.calls.some((call) => call.startsWith('remove'))).toBe(false)
  })

  it('saves a draft put away during its send once the send fails', async () => {
    composer.openNew([{ address: 'anna@example.test', name: null }])
    composer.update({ subject: 'Going out' })
    const id = composer.state.draft!.id
    let sendNow: (() => void) | null = null
    sendGate = new Promise<void>((resolve) => (sendNow = resolve))
    sendFails = new Error('server down')
    const sending = composer.send()
    await vi.waitFor(() => expect(api.calls).toContain(`create ${id}`))

    composer.update({ subject: 'Typed, then put away' })
    composer.close()
    await vi.advanceTimersByTimeAsync(1000)
    expect(await store.draft(id)).toMatchObject({ subject: 'Going out' })

    sendNow!()
    await sending
    await vi.waitFor(async () => expect(await store.draft(id)).toMatchObject({ subject: 'Typed, then put away', outgoingId: null }))
  })

  it('names the failed save, not an unrelated error, when the draft put away could not be saved', async () => {
    composer.openNew()
    composer.update({ subject: 'Put away' })
    vi.spyOn(store, 'changeDraft').mockRejectedValueOnce(new Error('disk full'))
    composer.close()
    composer.openNew()
    await composer.send()
    expect(composer.state.error).toBe('Add at least one recipient.')

    await expect(composer.saveNow()).rejects.toThrow('The draft could not be saved: disk full')
  })

  it('says what a restart would cut short: files on their way, or a message being sent', async () => {
    composer.openNew([{ address: 'anna@example.test', name: null }])
    expect(composer.unfinished).toBeNull()
    let release: (() => void) | null = null
    api.duringFile = () => new Promise<void>((resolve) => (release = resolve))
    const attaching = composer.attach([{ name: 'slow.bin', type: 'application/octet-stream', size: 10, body: 'blob' }])
    expect(composer.unfinished).toBe('files')
    await vi.waitFor(() => expect(release).not.toBeNull())
    // Also while another draft is open: the files are only in memory.
    composer.openNew()
    expect(composer.unfinished).toBe('files')
    api.duringFile = null
    release!()
    await attaching
    expect(composer.unfinished).toBeNull()

    composer.openNew([{ address: 'anna@example.test', name: null }])
    let sendNow: (() => void) | null = null
    sendGate = new Promise<void>((resolve) => (sendNow = resolve))
    const listener = vi.fn()
    composer.subscribe(listener)
    const sending = composer.send()
    await vi.waitFor(() => expect(composer.unfinished).toBe('sending'))
    expect(listener).toHaveBeenCalled()
    sendNow!()
    await sending
    expect(composer.unfinished).toBeNull()
  })

  it('refuses to send without an account or recipients, or with a wrong address', async () => {
    composer.openNew()
    await composer.send()
    expect(composer.state.error).toBe('Add at least one recipient.')

    composer.update({ to: [{ address: 'not an address', name: null }] })
    await composer.send()
    expect(composer.state.error).toBe('not an address is not a valid address.')

    composer.update({ to: [{ address: 'anna@example.test', name: null }], mailAccountId: null })
    await composer.send()
    expect(composer.state.error).toBe('Choose the account to send from.')

    composer.update({ mailAccountId: 'work', subject: 'Two\nlines' })
    await composer.send()
    expect(composer.state.error).toBe('The subject cannot contain line breaks.')

    composer.update({ subject: 'x'.repeat(999) })
    await composer.send()
    expect(composer.state.error).toBe('The subject is too long.')

    composer.update({ subject: 'Fine', to: Array.from({ length: 101 }, (_, index) => ({ address: `p${index}@example.test`, name: null })) })
    await composer.send()
    expect(composer.state.error).toBe('A message can have at most 100 recipients.')
    expect(sent).toEqual([])
  })

  it('sends after the undo window with the draft, and brings it back on undo', async () => {
    await composer.openReply(original, 'reply')
    composer.update({ html: '<p>Yes.</p>' })
    const id = composer.state.draft!.id

    await composer.send()

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ mailAccountId: 'work', subject: 'Re: Budget', draftId: id, inReplyToMessageId: 'm1' })
    expect(Date.parse(sent[0]!.sendAt!) - Date.now()).toBeGreaterThanOrEqual(4900)
    expect(sent[0]!.html.indexOf('<p>Yes.</p>')).toBe(0)
    expect(composer.state.draft).toBeNull()
    expect(composer.state.undoable?.outgoingId).toBe('o1')
    expect(await store.draft(id)).toMatchObject({ outgoingId: 'o1', pendingSave: false })

    await composer.undo()

    expect(cancelled).toEqual(['o1'])
    expect(composer.state.draft).toMatchObject({ id, outgoingId: null, pendingSave: true })
  })

  it('asks before sending files that could not be scanned, and sends them once confirmed', async () => {
    await composer.openReply(original, 'reply')
    await composer.attach([{ name: 'statement.pdf', type: 'application/pdf', size: 10, body: 'blob' }])
    const confirm = new ApiFailure(422, { acceptUnscanned: '"statement.pdf" could not be scanned for malware. Confirm that you want to send it anyway.' })
    sendFails = confirm

    await composer.send()

    expect(sent).toEqual([])
    expect(composer.state.error).toBeNull()
    expect(composer.state.unscannedToConfirm).toEqual({ message: confirm.violations.acceptUnscanned, sendAt: null })

    sendFails = null
    await composer.sendAnyway()

    expect(sent).toHaveLength(1)
    expect(sent[0]!.acceptUnscanned).toBe(true)
    expect(composer.state.unscannedToConfirm).toBeNull()
  })

  it('sends nothing when the user keeps editing instead', async () => {
    await composer.openReply(original, 'reply')
    sendFails = new ApiFailure(422, { acceptUnscanned: 'Confirm that you want to send it anyway.' })
    await composer.send()

    composer.keepEditing()

    expect(composer.state.unscannedToConfirm).toBeNull()
    expect(sent).toEqual([])
    expect(composer.state.draft).not.toBeNull()
  })

  it('gives a file that could not be scanned a link only on request', async () => {
    api.scanOf.set('statement.pdf', 'failed')
    composer.openNew()
    await composer.attach([{ name: 'statement.pdf', type: 'application/pdf', size: 10, body: 'blob' }])
    const id = composer.state.draft!.attachments[0]!.id

    expect(await composer.attachmentLink(id)).toEqual({ url: null, access: 'confirm' })
    expect(await composer.unscannedAttachmentLink(id)).toContain('unscanned=1')
  })

  it('lets the undo lapse after the window', async () => {
    await composer.openReply(original, 'reply')
    await composer.send()

    await vi.advanceTimersByTimeAsync(5000)

    expect(composer.state.undoable).toBeNull()
  })

  it('schedules a message for later and says when', async () => {
    composer.openNew([{ address: 'anna@example.test', name: null }])

    await composer.send(new Date('2026-10-20T08:00:00Z'))

    expect(sent[0]?.sendAt).toBe('2026-10-20T08:00:00.000Z')
    expect(composer.state.undoable).toBeNull()
    expect(notices[0]?.text).toMatch(/^Scheduled for /)
  })

  it('keeps the draft open and shows why when sending fails', async () => {
    composer.openNew([{ address: 'anna@example.test', name: null }])
    sendFails = new ApiFailure(422, { subject: 'Too long.' })

    await composer.send()

    expect(composer.state.draft).not.toBeNull()
    expect(composer.state).toMatchObject({ error: 'HTTP 422', violations: { subject: 'Too long.' }, sending: false })
  })

  it('removes a draft once sent, and offers a failed one for editing once', async () => {
    await composer.openReply(original, 'reply')
    const id = composer.state.draft!.id
    await composer.send()

    await store.apply(page({ cursor: 2, outgoingMessages: [outgoing('failed', 'Mailbox full')] }))
    await composer.followUp()
    await composer.followUp()

    expect(notices.filter((notice) => notice.tone === 'error').map((notice) => notice.text)).toEqual(['"Re: Budget" was not sent. Mailbox full'])
    expect(notices[0]?.action?.label).toBe('Edit and send again')
    expect(await composer.draftFor('o1')).toMatchObject({ id })

    await store.apply(page({ cursor: 3, outgoingMessages: [outgoing('sent')] }))
    await composer.followUp()
    expect(await store.draft(id)).toBeNull()
  })

  it('closes the form keeping the draft, and discards one here and on the server', async () => {
    composer.openNew()
    composer.update({ subject: 'Kept' })
    const kept = composer.state.draft!.id
    composer.close()
    await vi.advanceTimersByTimeAsync(10)
    expect(composer.state.draft).toBeNull()
    expect(await store.draft(kept)).toMatchObject({ subject: 'Kept' })

    await composer.openDraft(kept)
    await composer.discard()
    expect(await store.draft(kept)).toBeNull()
    expect(api.drafts.has(kept)).toBe(false)
  })

  it('sends a draft that was saved before with the draft, keeping the version the server knows', async () => {
    composer.openNew([{ address: 'anna@example.test', name: null }])
    composer.update({ subject: 'Saved first' })
    await vi.advanceTimersByTimeAsync(1000)
    const id = composer.state.draft!.id
    expect(api.drafts.get(id)?.version).toBe(1)

    await composer.send()

    expect(composer.state.error).toBeNull()
    expect(sent[0]?.draftId).toBe(id)
    // The edits on screen went up as version 2 on top of the saved version 1, not as a second create.
    expect(api.drafts.get(id)?.version).toBe(2)
    expect(await store.draft(id)).toMatchObject({ version: 2, outgoingId: 'o1' })
  })

  it('offers undo until the moment the message leaves', async () => {
    composer.openNew([{ address: 'anna@example.test', name: null }])
    await composer.send()

    expect(composer.state.undoable?.until).toBe(Date.parse(sent[0]!.sendAt!))
  })

  it('does not send a draft with a conflict before it is settled', async () => {
    composer.openNew([{ address: 'anna@example.test', name: null }])
    composer.update({ subject: 'Here' })
    await vi.advanceTimersByTimeAsync(1000)
    const id = composer.state.draft!.id
    await store.saveDraft({ ...(await store.draft(id))!, remoteVersion: 3 })
    await composer.openDraft(id)

    await composer.send()

    expect(composer.state.error).toBe('This draft was changed on another device. Choose which version to keep first.')
    expect(sent).toEqual([])
  })

  it('does not bring back a draft deleted while its upload was under way, and removes the server copy', async () => {
    composer.openNew()
    composer.update({ subject: 'Short-lived' })
    const id = composer.state.draft!.id
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    api.during = () => held
    await vi.advanceTimersByTimeAsync(1000)

    const discarding = composer.discard()
    api.during = null
    release()
    expect(await discarding).toBe(true)

    expect(await store.draft(id)).toBeNull()
    expect(api.drafts.has(id)).toBe(false)
  })

  it('keeps a draft open, saying why, when it cannot be deleted from the server', async () => {
    composer.openNew()
    composer.update({ subject: 'Offline' })
    await vi.advanceTimersByTimeAsync(1000)
    api.offline = true

    expect(await composer.discard()).toBe(false)

    expect(composer.state.draft).not.toBeNull()
    expect(composer.state.error).toBe('The draft could not be deleted: Network request failed')
    expect(await store.draft(composer.state.draft!.id)).not.toBeNull()
  })

  it('writes nothing into another copy after a sign-out or another user, and forgets the draft on reset', async () => {
    composer.openNew()
    composer.update({ subject: 'Anna writes' })
    const id = composer.state.draft!.id
    const other = await SqliteMailStore.open(await memorySql())
    currentStore = other

    await vi.advanceTimersByTimeAsync(1000)
    await composer.send()

    expect(await other.draft(id)).toBeNull()
    expect(await store.draft(id)).toBeNull()
    expect(composer.state.error).toBe('You were signed out. Sign in again to send this message.')

    composer.reset()
    expect(composer.state.draft).toBeNull()
  })

  it('saves a draft still waiting for typing to stop before another one opens', async () => {
    composer.openNew()
    composer.update({ subject: 'Typed just now' })
    const first = composer.state.draft!.id

    composer.openNew()
    await vi.advanceTimersByTimeAsync(10)

    expect(await store.draft(first)).toMatchObject({ subject: 'Typed just now' })
  })

  it('keeps a draft that is being sent when the form closes, so a failure shows', async () => {
    composer.openNew([{ address: 'anna@example.test', name: null }])
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    api.during = () => held
    const sending = composer.send()

    composer.close()
    sendFails = new ApiFailure(500)
    release()
    await sending

    expect(composer.state.draft).not.toBeNull()
    expect(composer.state.error).toBe('HTTP 500')
  })

  it('holds plain data whatever it is handed, and says when it changed the copy', async () => {
    composer.openNew()
    const reactive = new Proxy({ address: 'anna@example.test', name: null }, {})
    composer.update({ to: [reactive] })

    expect(Object.getPrototypeOf(composer.state.draft!.to[0])).toBe(Object.prototype)
    await vi.advanceTimersByTimeAsync(1000)
    expect(changes).toBeGreaterThan(0)
  })

  it('tells of a send that fails after another draft took the screen, without touching that one', async () => {
    composer.openNew([{ address: 'anna@example.test', name: null }])
    composer.update({ subject: 'First' })
    const first = composer.state.draft!.id
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    api.during = () => held
    const sending = composer.send()
    composer.close()
    composer.openNew()
    sendFails = new ApiFailure(500)
    release()
    await sending

    expect(composer.state.draft?.id).not.toBe(first)
    expect(composer.state.error).toBeNull()
    expect(notices.at(-1)).toMatchObject({ text: '"First" was not sent: HTTP 500', tone: 'error', action: { label: 'Edit' } })
    await notices.at(-1)!.action!.run()
    await vi.waitFor(() => expect(composer.state.draft?.id).toBe(first))
  })

  it('lets a save into a closing copy go quietly, and says when saving fails otherwise', async () => {
    composer.openNew()
    composer.update({ subject: 'Closing' })
    await store.shut()

    await vi.advanceTimersByTimeAsync(1000)

    expect(composer.state.error).toBeNull()
  })

  it('tells lists of a new draft and one put away, not of every pause in typing', async () => {
    composer.openNew()
    composer.update({ subject: 'One' })
    await vi.advanceTimersByTimeAsync(1000)
    const afterFirst = changes
    composer.update({ subject: 'Two' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(changes).toBe(afterFirst)

    composer.update({ subject: 'Three' })
    composer.close()
    await vi.advanceTimersByTimeAsync(10)
    expect(changes).toBe(afterFirst + 1)

    // Put away with its edits saved already: nothing is written, but the lists are told, since autosaves did not.
    await composer.openDraft((await store.drafts())[0]!.id)
    composer.update({ subject: 'Four' })
    await vi.advanceTimersByTimeAsync(1000)
    const written = (await store.draft(composer.state.draft!.id))!.updatedAt
    composer.close()
    await vi.advanceTimersByTimeAsync(10)
    expect(changes).toBe(afterFirst + 2)
    expect((await store.draft((await store.drafts())[0]!.id))!.updatedAt).toBe(written)
  })

  it('puts the draft on the server before attaching files, and shows them as they arrive', async () => {
    composer.openNew()
    composer.update({ subject: 'With files' })
    const id = composer.state.draft!.id

    await composer.attach([
      { name: 'notes.txt', type: 'text/plain', size: 10, body: 'blob-1' },
      { name: 'plan.pdf', type: 'application/pdf', size: 20, body: 'blob-2' },
    ])

    expect(api.calls).toEqual([`create ${id}`, `attach ${id} notes.txt`, `attach ${id} plan.pdf`])
    expect(composer.state.draft!.attachments.map((a) => a.filename)).toEqual(['notes.txt', 'plan.pdf'])
    expect(composer.state.attaching).toEqual([])
    expect((await store.draft(id))!.attachments.map((a) => a.filename)).toEqual(['notes.txt', 'plan.pdf'])
    expect((await composer.attachmentLink(composer.state.draft!.attachments[0]!.id))?.url).toMatch(/^https:/)
  })

  it('says a file could not be attached without a connection, keeping the draft', async () => {
    composer.openNew()
    api.offline = true

    await composer.attach([{ name: 'notes.txt', type: 'text/plain', size: 10, body: 'blob' }])

    expect(composer.state.error).toBe('Not attached. notes.txt: Attaching files needs a connection. Try again when you are online.')
    expect(composer.state.draft!.attachments).toEqual([])
  })

  it('removes a file, also one the server lost already', async () => {
    composer.openNew()
    await composer.attach([{ name: 'notes.txt', type: 'text/plain', size: 10, body: 'blob' }])
    const [file] = composer.state.draft!.attachments

    await composer.removeAttachment(file!.id)

    expect(composer.state.draft!.attachments).toEqual([])
    expect(api.drafts.get(composer.state.draft!.id)!.attachments).toEqual([])
    await composer.removeAttachment('gone')
    expect(composer.state.error).toBeNull()
  })

  it("takes a forwarded message's files along, but not its inline images or malware", async () => {
    const file = (id: string, extra: Partial<MessageAttachment> = {}): MessageAttachment => ({ id, filename: `${id}.pdf`, contentType: 'application/pdf', size: 100, inline: false, contentId: null, scanStatus: 'clean', access: 'allowed', scanSignature: null, scanFailure: null, url: null, ...extra })
    originalFiles = [file('invoice'), file('logo', { inline: true }), file('virus', { scanStatus: 'infected' })]

    await composer.openReply(original, 'forward')

    expect(api.calls.filter((call) => call.startsWith('forward'))).toEqual([`forward ${composer.state.draft!.id} invoice`])
    expect(composer.state.draft!.attachments.map((a) => a.filename)).toEqual(['invoice.pdf'])
  })

  it('does not send while files are on their way, nor without the draft that has them', async () => {
    composer.openNew([{ address: 'anna@example.test', name: null }])
    let release: (() => void) | null = null
    api.duringFile = () => new Promise<void>((resolve) => (release = resolve))
    const attaching = composer.attach([{ name: 'slow.bin', type: 'application/octet-stream', size: 10, body: 'blob' }])
    // On its way from the click, before the draft has even gone up.
    expect(composer.state.attaching).toEqual(['slow.bin'])
    await vi.waitFor(() => expect(release).not.toBeNull())

    await composer.send()
    expect(composer.state.error).toBe('Wait until the files are attached.')
    api.duringFile = null
    release!()
    await attaching

    api.offline = true
    await composer.send()
    expect(composer.state.error).toBe('Attaching files needs a connection. Try again when you are online.')
    expect(sent).toEqual([])
  })

  it("sends a reply's quoted images along, referred to by content id, and shows them through fresh links", async () => {
    const signed = 'https://api.example.test/content/attachments/logo?expires=1&signature=a'
    // As the body sanitizer writes it.
    originalHtml = '<p>Numbers?</p><img src="https://api.example.test/content/attachments/logo?expires&#61;1&amp;signature&#61;a" alt="Logo" />'
    originalFiles = [{ id: 'logo', filename: 'logo.png', contentType: 'image/png', size: 100, inline: true, contentId: 'logo@example.test', scanStatus: 'clean', access: 'allowed', scanSignature: null, scanFailure: null, url: signed }]
    api.received.set('logo', { filename: 'logo.png', contentType: 'image/png', inline: true, contentId: 'logo@example.test' })

    await composer.openReply(original, 'reply')
    await vi.advanceTimersByTimeAsync(5000)

    const draft = composer.state.draft!
    expect(api.calls).toContain(`forward ${draft.id} logo`)
    expect(draft.attachments).toMatchObject([{ id: 'forwarded-logo', inline: true, contentId: 'logo@example.test' }])
    expect(draft.quoteHtml).toContain('src="cid:logo@example.test"')
    expect(draft.quoteHtml).not.toContain('signature')
    expect(api.drafts.get(draft.id)!.quoteHtml).toContain('cid:logo@example.test')
    expect(composer.state.conflict).toBe(false)
    expect(await composer.shownQuote(draft.quoteHtml)).toContain('src="https://api.example.test/content/draft-attachments/forwarded-logo?signed"')
  })

  it('takes the version a file gave the draft, so the next edit is no conflict', async () => {
    composer.openNew([{ address: 'anna@example.test', name: null }])
    await composer.attach([{ name: 'plan.pdf', type: 'application/pdf', size: 10, body: 'blob' }])
    const id = composer.state.draft!.id

    composer.update({ subject: 'With the plan' })
    await vi.advanceTimersByTimeAsync(5000)
    expect(composer.state.conflict).toBe(false)
    expect(api.drafts.get(id)!.subject).toBe('With the plan')

    await composer.removeAttachment(composer.state.draft!.attachments[0]!.id)
    composer.update({ subject: 'Without it' })
    await vi.advanceTimersByTimeAsync(5000)
    expect(composer.state.conflict).toBe(false)
    expect(api.drafts.get(id)).toMatchObject({ subject: 'Without it', attachments: [] })
  })

  it('keeps files on their way with their own draft when another one is opened', async () => {
    composer.openNew([{ address: 'anna@example.test', name: null }])
    const first = composer.state.draft!.id
    let release: (() => void) | null = null
    api.duringFile = () => new Promise<void>((resolve) => (release = resolve))
    const attaching = composer.attach([{ name: 'slow.bin', type: 'application/octet-stream', size: 10, body: 'blob' }])
    await vi.waitFor(() => expect(release).not.toBeNull())

    composer.openNew()
    expect(composer.state.attaching).toEqual([])
    await composer.openDraft(first)
    expect(composer.state.attaching).toEqual(['slow.bin'])

    api.duringFile = null
    release!()
    await attaching
    expect(composer.state.attaching).toEqual([])
    expect(composer.state.draft!.attachments.map((attachment) => attachment.filename)).toEqual(['slow.bin'])
  })

  it('shows files attached to the open draft on another device, and does not save over them', async () => {
    composer.openNew([{ address: 'anna@example.test', name: null }])
    await composer.save()
    const id = composer.state.draft!.id
    const stored = (await store.draft(id))!
    const other = { id: 'other-file', filename: 'other.pdf', contentType: 'application/pdf', size: 5, scanStatus: 'clean' as const, inline: false, contentId: null }
    await store.saveDraft({ ...stored, attachments: [other] })

    await composer.followUp()
    expect(composer.state.draft!.attachments).toEqual([other])

    await store.saveDraft({ ...stored, attachments: [other, { ...other, id: 'second' }] })
    composer.update({ subject: 'Typed meanwhile' })
    await vi.advanceTimersByTimeAsync(5000)
    expect((await store.draft(id))!.attachments.map((attachment) => attachment.id)).toEqual(['other-file', 'second'])
  })

  /** A draft saved by this device (version 1 on the server), then saved by another device as version 2 with other text. */
  async function changedElsewhere(): Promise<string> {
    composer.openNew([{ address: 'anna@example.test', name: null }])
    composer.update({ subject: 'Mine' })
    await vi.advanceTimersByTimeAsync(1000)
    const id = composer.state.draft!.id
    expect(await store.draft(id)).toMatchObject({ version: 1, pendingSave: false })
    api.drafts.set(id, { ...api.drafts.get(id)!, subject: 'Theirs', version: 2 })
    await store.apply(page({ cursor: 2, drafts: [api.drafts.get(id)!] }))
    return id
  }

  it("does not overwrite another device's newer version when an idle draft is edited, but asks which to keep", async () => {
    const id = await changedElsewhere()

    composer.update({ html: '<p>Typed here</p>' })
    await vi.advanceTimersByTimeAsync(1000)

    expect(composer.state.conflict).toBe(true)
    expect(await store.draft(id)).toMatchObject({ subject: 'Mine', html: '<p>Typed here</p>', version: 1, remoteVersion: 2, pendingSave: true })
    expect(api.drafts.get(id)).toMatchObject({ subject: 'Theirs', version: 2 })
    expect(api.calls.filter((call) => call.startsWith('update'))).toEqual([])
  })

  it("does not send an idle draft over another device's newer version", async () => {
    const id = await changedElsewhere()

    expect(await composer.send()).toBeNull()

    expect(sent).toEqual([])
    expect(composer.state).toMatchObject({ conflict: true, error: 'This draft was changed on another device. Choose which version to keep first.' })
    expect(api.drafts.get(id)).toMatchObject({ subject: 'Theirs', version: 2 })
  })

  it("shows another device's version in an idle form, and closes one sent or deleted there", async () => {
    const id = await changedElsewhere()

    await composer.followUp()

    expect(composer.state.draft).toMatchObject({ id, subject: 'Theirs', version: 2 })
    expect(notices.map((notice) => notice.text)).toContain('"Theirs" was changed on another device. It shows that version now.')

    await store.apply(page({ cursor: 3, deleted: [{ type: 'draft', id }] }))
    await composer.followUp()

    expect(composer.state.draft).toBeNull()
    expect(await store.draft(id)).toBeNull()
  })

  it("keeps the form on the user's newest text when a page with an older version of it arrives late", async () => {
    composer.openNew([{ address: 'anna@example.test', name: null }])
    composer.update({ subject: 'First' })
    await vi.advanceTimersByTimeAsync(1000)
    const id = composer.state.draft!.id
    // The server read this page before the second upload; it is applied after that upload's answer.
    const older = { ...api.drafts.get(id)! }
    composer.update({ subject: 'Second' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(await store.draft(id)).toMatchObject({ subject: 'Second', version: 2, pendingSave: false })

    await store.apply(page({ cursor: 2, drafts: [older] }))
    expect(await store.draft(id)).toMatchObject({ subject: 'Second', version: 2 })
    // Even a copy that took the older version (as an older store would) does not move the form back.
    await store.saveDraft({ ...(await store.draft(id))!, subject: 'First', version: 1 })
    await composer.followUp()

    expect(composer.state.draft).toMatchObject({ subject: 'Second' })
    expect(notices.filter((notice) => notice.text.includes('changed on another device'))).toEqual([])
  })

  it('keeps edits typed while the copy is read, rather than showing what was stored before them', async () => {
    composer.openNew([{ address: 'anna@example.test', name: null }])
    composer.update({ subject: 'First' })
    await vi.advanceTimersByTimeAsync(1000)
    composer.update({ subject: 'Second' })
    // The copy is read (still "First") while "Second" waits to be saved; it is saved before the read comes back.
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const draft = store.draft.bind(store)
    vi.spyOn(store, 'draft').mockImplementationOnce(async (id) => {
      const stale = await draft(id)
      await gate
      return stale
    })
    const refreshing = composer.refreshOpen()
    await vi.advanceTimersByTimeAsync(1000)
    release()
    await refreshing

    expect(composer.state.draft).toMatchObject({ subject: 'Second' })
  })

  it('does not write back an unedited draft that was deleted on another device while it was open', async () => {
    const id = await changedElsewhere()
    await composer.openDraft(id)
    await store.apply(page({ cursor: 3, deleted: [{ type: 'draft', id }] }))

    composer.close()
    await vi.advanceTimersByTimeAsync(1000)

    expect(await store.draft(id)).toBeNull()
  })

  it('keeps the draft of an undone message a draft in the copy, whatever opens next', async () => {
    composer.openNew([{ address: 'anna@example.test', name: null }])
    composer.update({ subject: 'Undone' })
    const id = composer.state.draft!.id
    await composer.send()

    await composer.undo()
    composer.openNew()
    await vi.advanceTimersByTimeAsync(1000)

    expect(await store.draft(id)).toMatchObject({ subject: 'Undone', outgoingId: null })
  })

  it('makes the draft of a message cancelled elsewhere (the Outbox, another device) a draft again', async () => {
    composer.openNew([{ address: 'anna@example.test', name: null }])
    const id = composer.state.draft!.id
    await composer.send()
    const before = changes

    await store.apply(page({ cursor: 2, outgoingMessages: [outgoing('cancelled')] }))
    await composer.followUp()

    expect(await store.draft(id)).toMatchObject({ outgoingId: null, noticedStatus: null })
    expect(changes).toBeGreaterThan(before)
  })

  it('opens a reply whose original could not be loaded, saying the quote is incomplete', async () => {
    bodyFails = new Error('Timed out')

    await composer.openReply(original, 'reply')

    expect(composer.state.draft).toMatchObject({ kind: 'reply', inReplyToMessageId: 'm1' })
    expect(composer.state.error).toBe('The original message could not be loaded (Timed out), so the quote is incomplete.')
  })

  it('does not open a forward whose original could not be loaded', async () => {
    bodyFails = new Error('Timed out')

    await composer.openReply(original, 'forward')
    expect(composer.state.draft).toBeNull()
    expect(notices.at(-1)).toMatchObject({ tone: 'error', text: 'The message could not be forwarded: it could not be loaded (Timed out).' })

    await expect(composer.openReply(original, 'forward', { strict: true })).rejects.toBeInstanceOf(OriginalUnavailableError)
    expect(composer.state.draft).toBeNull()
  })

  it('says why a conflict could not be settled, and keeps it to try again', async () => {
    const id = await changedElsewhere()
    composer.update({ html: '<p>Typed here</p>' })
    await vi.advanceTimersByTimeAsync(1000)
    api.offline = true

    await composer.resolveConflict('mine')

    expect(composer.state).toMatchObject({ conflict: true, error: 'The versions could not be compared: Network request failed' })
    api.offline = false
    await composer.resolveConflict('mine')
    expect(composer.state.conflict).toBe(false)
    expect(api.drafts.get(id)).toMatchObject({ html: '<p>Typed here</p>', version: 3 })
  })

  it('treats a message the server took as sent, also when noting it on this device fails', async () => {
    composer.openNew([{ address: 'anna@example.test', name: null }])
    const changeDraft = store.changeDraft.bind(store)
    vi.spyOn(store, 'changeDraft').mockImplementation((id, change) => (sent.length > 0 ? Promise.reject(new Error('disk full')) : changeDraft(id, change)))

    const outgoingMessage = await composer.send()

    expect(outgoingMessage).toMatchObject({ id: 'o1' })
    expect(composer.state).toMatchObject({ draft: null, error: null, sending: false })
    expect(composer.state.undoable?.outgoingId).toBe('o1')
    expect(notices.at(-1)).toMatchObject({ tone: 'error', text: 'Sent, but this device could not note it (disk full). The draft may stay in Drafts.' })
    expect(await composer.send()).toBeNull()
    expect(sent).toHaveLength(1)
  })

  it("counts the undo window on the server's clock, and offers undo for that long on this device", async () => {
    const serverBehind = new Composer({ ...deps, now: () => Date.now() - 600_000 })
    serverBehind.openNew([{ address: 'anna@example.test', name: null }])
    const at = Date.now()

    await serverBehind.send()

    expect(Date.parse(sent[0]!.sendAt!)).toBe(at - 600_000 + 5000)
    expect(serverBehind.state.undoable?.until).toBe(at + 5000)
    await vi.advanceTimersByTimeAsync(4900)
    expect(serverBehind.state.undoable).not.toBeNull()
    await vi.advanceTimersByTimeAsync(200)
    expect(serverBehind.state.undoable).toBeNull()
    serverBehind.dispose()
  })

  describe('the id of a send', () => {
    const lost = new Error('Network request failed')

    it('is a UUIDv7 of the server time, chosen once and dropped once the server has the message', async () => {
      const serverAhead = new Composer({ ...deps, now: () => Date.now() + 120_000 })
      serverAhead.openNew([{ address: 'anna@example.test', name: null }])
      const id = serverAhead.state.draft!.id

      await serverAhead.send()

      expect(uuidV7Time(sent[0]!.outgoingId!)).toBe(Date.now() + 120_000)
      expect(await store.draft(id)).toMatchObject({ outgoingId: 'o1', sendAttemptId: null })
      serverAhead.dispose()
    })

    it('is reused when Send is pressed again after an answer was lost, and ends with an answer that queued nothing', async () => {
      composer.openNew([{ address: 'anna@example.test', name: null }])
      const id = composer.state.draft!.id
      sendFails = lost

      await composer.send()
      const first = tried[0]!.outgoingId
      expect(first).toBeDefined()
      expect(await store.draft(id)).toMatchObject({ sendAttemptId: first })
      sendFails = new ApiFailure(502)
      await composer.send()
      expect(tried[1]!.outgoingId).toBe(first)

      // A refusal says the server queued nothing: that send is over, and the confirmation is a new one.
      sendFails = new ApiFailure(422, { acceptUnscanned: 'Send it anyway?' })
      await composer.send()
      expect(tried[2]!.outgoingId).toBe(first)
      expect(await store.draft(id)).toMatchObject({ sendAttemptId: null })
      sendFails = null
      await composer.sendAnyway()

      expect(tried[3]!.outgoingId).not.toBe(first)
      expect(sent).toHaveLength(1)
    })

    it('survives a restart between the request and its answer', async () => {
      composer.openNew([{ address: 'anna@example.test', name: null }])
      const id = composer.state.draft!.id
      sendFails = lost
      await composer.send()
      composer.dispose()

      sendFails = null
      const restarted = new Composer(deps)
      await restarted.openDraft(id)
      await restarted.send()

      expect(sent[0]!.outgoingId).toBe(tried[0]!.outgoingId)
      restarted.dispose()
    })

    it('is new once the draft was edited after a failed send', async () => {
      composer.openNew([{ address: 'anna@example.test', name: null }])
      const id = composer.state.draft!.id
      sendFails = lost
      await composer.send()

      composer.update({ subject: 'Changed my mind' })
      await vi.advanceTimersByTimeAsync(1000)
      expect(await store.draft(id)).toMatchObject({ sendAttemptId: null })
      sendFails = null
      await composer.send()

      expect(sent[0]!.outgoingId).toBeDefined()
      expect(sent[0]!.outgoingId).not.toBe(tried[0]!.outgoingId)
    })

    it('is made anew when the server refused the id itself', async () => {
      composer.openNew([{ address: 'anna@example.test', name: null }])
      const id = composer.state.draft!.id
      sendFails = new ApiFailure(422, { outgoingId: 'The id lies in the future; check the clock of this device.' })
      await composer.send()
      expect(await store.draft(id)).toMatchObject({ sendAttemptId: null })

      sendFails = null
      await composer.send()

      expect(sent[0]!.outgoingId).not.toBe(tried[0]!.outgoingId)
    })

    it('recognises a send whose answer was lost once the message shows up, and closes its form', async () => {
      composer.openNew([{ address: 'anna@example.test', name: null }])
      composer.update({ subject: 'Lost answer' })
      const id = composer.state.draft!.id
      sendFails = lost
      await composer.send()
      const attempt = tried[0]!.outgoingId!
      // The form saves what the failed send left to write.
      await vi.advanceTimersByTimeAsync(1000)

      // The server did queue it: the delta brings the message with the send's id.
      await store.apply(page({ cursor: 2, outgoingMessages: [{ ...outgoing('scheduled'), id: attempt }] }))
      await composer.followUp()

      expect(await store.draft(id)).toMatchObject({ outgoingId: attempt, sendAttemptId: null, pendingSave: false })
      expect(composer.state.draft).toBeNull()
      expect(notices.map((notice) => notice.text)).toContain('"Lost answer" reached the server after all and is on its way.')
    })

    /** The page the server sends once it queued the message: the draft is gone (being sent), the message is there. */
    function queued(draftId: string, outgoingId: string) {
      return page({ cursor: 3, deleted: [{ type: 'draft', id: draftId }], outgoingMessages: [{ ...outgoing('scheduled'), id: outgoingId }] })
    }

    it('does not send twice when the server queued the message, its answer was lost and the delta came while it was open', async () => {
      composer.openNew([{ address: 'anna@example.test', name: null }])
      composer.update({ subject: 'Once' })
      const id = composer.state.draft!.id
      let answer!: () => void
      sendGate = new Promise<void>((resolve) => (answer = resolve))
      const sending = composer.send()
      await vi.advanceTimersByTimeAsync(10)
      const attempt = tried[0]!.outgoingId!

      // The server queued it and told the device, then the answer got lost on its way.
      await store.apply(queued(id, attempt))
      sendFails = lost
      answer()
      await sending
      await vi.advanceTimersByTimeAsync(1000)

      expect(await store.draft(id)).toMatchObject({ outgoingId: attempt, sendAttemptId: null })
      expect(composer.state.draft).toBeNull()
      sendGate = null
      sendFails = null
      expect(await composer.send()).toBeNull()
      expect(tried).toHaveLength(1)
    })

    it('does not send twice when the delta comes after the failed send was saved again, nor when Send is pressed before', async () => {
      composer.openNew([{ address: 'anna@example.test', name: null }])
      composer.update({ subject: 'Once' })
      const id = composer.state.draft!.id
      sendFails = lost
      await composer.send()
      const attempt = tried[0]!.outgoingId!
      await vi.advanceTimersByTimeAsync(1000)

      await store.apply(queued(id, attempt))
      // Send again before the follow-up: the message is in the copy, so nothing is sent.
      sendFails = null
      expect(await composer.send()).toMatchObject({ id: attempt })

      expect(tried).toHaveLength(1)
      expect(await store.draft(id)).toMatchObject({ outgoingId: attempt, sendAttemptId: null })
      expect(composer.state.draft).toBeNull()
    })

    it('keeps what was typed while the lost send was recognised as a new draft, saying so', async () => {
      composer.openNew([{ address: 'anna@example.test', name: null }])
      composer.update({ subject: 'Once' })
      const id = composer.state.draft!.id
      sendFails = lost
      await composer.send()
      const attempt = tried[0]!.outgoingId!
      await vi.advanceTimersByTimeAsync(1000)
      await store.apply(queued(id, attempt))
      const changeDraft = store.changeDraft.bind(store)
      vi.spyOn(store, 'changeDraft').mockImplementationOnce(async (draftId, change) => {
        const stored = await changeDraft(draftId, change)
        composer.update({ html: '<p>One more thing</p>' })
        return stored
      })

      await composer.followUp()

      expect(composer.state.draft).toMatchObject({ html: '<p>One more thing</p>' })
      expect(composer.state.draft!.id).not.toBe(id)
      expect(await store.draft(id)).toMatchObject({ outgoingId: attempt })
      expect(notices.map((notice) => notice.text)).toContain('"Once" reached the server after all and is on its way, without what you typed since. That is kept as a new draft.')
    })

    it("removes a draft kept for its send once the deletion turns out to be another device's", async () => {
      composer.openNew([{ address: 'anna@example.test', name: null }])
      composer.update({ subject: 'Sent from the laptop' })
      const id = composer.state.draft!.id
      sendFails = lost
      await composer.send()
      await vi.advanceTimersByTimeAsync(1000)

      // Sent (or deleted) on another device: the server hides the draft; no message with this device's id comes.
      await store.apply(page({ cursor: 3, deleted: [{ type: 'draft', id }] }))
      expect(await store.draft(id)).toMatchObject({ hiddenOnServer: true })
      await composer.followUp()

      expect(await store.draft(id)).toBeNull()
      expect(composer.state.draft).toBeNull()
      expect(notices.map((notice) => notice.text)).toContain('"Sent from the laptop" is no longer a draft on the server: it was sent, or deleted on another device.')
    })

    it('keeps what was typed on such a draft as a new draft, without the send', async () => {
      composer.openNew([{ address: 'anna@example.test', name: null }])
      composer.update({ subject: 'Typed on' })
      const id = composer.state.draft!.id
      sendFails = lost
      await composer.send()
      await vi.advanceTimersByTimeAsync(1000)
      await store.apply(page({ cursor: 3, deleted: [{ type: 'draft', id }] }))
      composer.update({ html: '<p>More</p>' })

      await composer.followUp()

      expect(await store.draft(id)).toBeNull()
      const kept = (await store.drafts()).find((each) => each.html === '<p>More</p>')
      expect(kept).toMatchObject({ subject: 'Typed on', sendAttemptId: null, outgoingId: null })
      expect(kept!.id).not.toBe(id)
      expect(composer.state.draft).toMatchObject({ id: kept!.id, html: '<p>More</p>' })
    })

    it('does not keep a draft for ever on a server that does not take the send id', async () => {
      composer.openNew([{ address: 'anna@example.test', name: null }])
      composer.update({ subject: 'Old server' })
      const id = composer.state.draft!.id
      sendFails = lost
      await composer.send()
      await vi.advanceTimersByTimeAsync(1000)

      // The message is queued under the server's own id.
      await store.apply(page({ cursor: 3, deleted: [{ type: 'draft', id }], outgoingMessages: [{ ...outgoing('scheduled'), id: 'server-chosen' }] }))
      await composer.followUp()

      expect(await store.draft(id)).toBeNull()
      expect(composer.state.draft).toBeNull()
    })

    it('says when an earlier version went out after all, keeping what was typed since as a new draft', async () => {
      composer.openNew([{ address: 'anna@example.test', name: null }])
      composer.update({ subject: 'First words' })
      const id = composer.state.draft!.id
      sendFails = lost
      await composer.send()
      const attempt = tried[0]!.outgoingId!
      composer.update({ html: '<p>Second thoughts</p>' })
      await vi.advanceTimersByTimeAsync(1000)
      expect(await store.draft(id)).toMatchObject({ sendAttemptId: null, unsureSendId: attempt })

      await store.apply(queued(id, attempt))
      await composer.followUp()

      expect(await store.draft(id)).toMatchObject({ outgoingId: attempt, unsureSendId: null })
      const kept = (await store.drafts()).find((each) => each.html === '<p>Second thoughts</p>' && each.id !== id)
      expect(kept).toMatchObject({ outgoingId: null, sendAttemptId: null })
      expect(composer.state.draft).toMatchObject({ id: kept!.id })
      expect(notices.map((notice) => notice.text)).toContain('An earlier version of "First words" reached the server after all and is on its way. What you typed since is kept as a new draft.')
    })

    /** A draft the server has, edited offline and sent there, then sent or deleted on another device. */
    async function editedOfflineThenGone(closeFirst: boolean): Promise<string> {
      composer.openNew([{ address: 'anna@example.test', name: null }])
      composer.update({ subject: 'On the server' })
      await vi.advanceTimersByTimeAsync(1000)
      const id = composer.state.draft!.id
      api.offline = true
      composer.update({ subject: 'Typed offline' })
      sendFails = lost
      await composer.send()
      await vi.advanceTimersByTimeAsync(1000)
      expect(await store.draft(id)).toMatchObject({ subject: 'Typed offline', pendingSave: true, sendAttemptId: tried[0]!.outgoingId })
      if (closeFirst) {
        composer.close()
        await vi.advanceTimersByTimeAsync(10)
      }
      api.offline = false
      sendFails = null
      await store.apply(page({ cursor: 3, deleted: [{ type: 'draft', id }] }))
      expect(api.calls.filter((call) => call.startsWith('create')).length).toBe(1)
      await composer.followUp()
      return id
    }

    it('keeps text written offline on a draft another device sent or deleted, as a new draft, with the form open', async () => {
      const id = await editedOfflineThenGone(false)

      expect(await store.draft(id)).toBeNull()
      const kept = (await store.drafts()).find((each) => each.subject === 'Typed offline')
      expect(kept).toMatchObject({ sendAttemptId: null, outgoingId: null })
      expect(kept!.id).not.toBe(id)
      expect(composer.state.draft).toMatchObject({ id: kept!.id, subject: 'Typed offline' })
      expect(notices.map((notice) => notice.text)).toContain('"Typed offline" is no longer a draft on the server: it was sent, or deleted on another device. What you wrote here since is kept as a new draft.')
    })

    it('keeps text written offline the same way when its form is closed, and says so', async () => {
      const id = await editedOfflineThenGone(true)

      expect(await store.draft(id)).toBeNull()
      expect((await store.drafts()).find((each) => each.subject === 'Typed offline')).toMatchObject({ sendAttemptId: null, unsureSendId: null })
      expect(notices.map((notice) => notice.text)).toContain('"Typed offline" is no longer a draft on the server: it was sent, or deleted on another device. What you wrote here since is kept as a new draft.')
    })

    it('keeps text edited after a failed send when another device sent or deleted the draft', async () => {
      composer.openNew([{ address: 'anna@example.test', name: null }])
      composer.update({ subject: 'Failed once' })
      const id = composer.state.draft!.id
      sendFails = new ApiFailure(502)
      await composer.send()
      api.offline = true
      composer.update({ html: '<p>Edited offline</p>' })
      await vi.advanceTimersByTimeAsync(1000)
      composer.close()
      await vi.advanceTimersByTimeAsync(10)
      expect(await store.draft(id)).toMatchObject({ unsureSendId: tried[0]!.outgoingId, pendingSave: true })
      api.offline = false

      await store.apply(page({ cursor: 3, deleted: [{ type: 'draft', id }] }))
      await composer.followUp()

      expect(await store.draft(id)).toBeNull()
      expect((await store.drafts()).find((each) => each.html === '<p>Edited offline</p>')).toMatchObject({ unsureSendId: null, sendAttemptId: null })
    })

    it('leaves the autosave of another open draft alone when a closed one is kept as a new draft', async () => {
      composer.openNew([{ address: 'anna@example.test', name: null }])
      composer.update({ subject: 'First words' })
      const id = composer.state.draft!.id
      sendFails = lost
      await composer.send()
      const attempt = tried[0]!.outgoingId!
      composer.update({ html: '<p>Second thoughts</p>' })
      await vi.advanceTimersByTimeAsync(1000)
      composer.close()
      await vi.advanceTimersByTimeAsync(10)
      sendFails = null

      composer.openNew()
      composer.update({ subject: 'Another message' })
      const other = composer.state.draft!.id
      await store.apply(queued(id, attempt))
      await composer.followUp()
      await vi.advanceTimersByTimeAsync(1000)

      expect(await store.draft(other)).toMatchObject({ subject: 'Another message' })
      expect(composer.state.draft).toMatchObject({ id: other })
    })

    it('comes along when the draft moves into a copy that was opened again', async () => {
      composer.openNew([{ address: 'anna@example.test', name: null }])
      composer.update({ subject: 'Moved' })
      const id = composer.state.draft!.id
      sendFails = lost
      await composer.send()
      const attempt = tried[0]!.outgoingId!
      await vi.advanceTimersByTimeAsync(1000)

      // The copy was removed under this window and opened again, empty, for the same user.
      const reopened = await SqliteMailStore.open(await memorySql())
      currentStore = reopened
      await composer.rebind()
      expect(await reopened.draft(id)).toMatchObject({ subject: 'Moved', sendAttemptId: attempt })

      sendFails = null
      await composer.send()
      expect(sent[0]!.outgoingId).toBe(attempt)
    })

    /** A send whose answer was lost, then the server's deletion of the draft without the message (another device's). */
    async function hiddenAfterLostAnswer(subject: string): Promise<string> {
      composer.openNew([{ address: 'anna@example.test', name: null }])
      composer.update({ subject })
      const id = composer.state.draft!.id
      sendFails = lost
      await composer.send()
      sendFails = null
      await vi.advanceTimersByTimeAsync(1000)
      await store.apply(page({ cursor: 3, deleted: [{ type: 'draft', id }] }))
      return id
    }

    it('keeps text of a form closed while the follow-up was on its way to settling the hidden draft', async () => {
      const id = await hiddenAfterLostAnswer('Closing')
      composer.update({ html: '<p>Typed, then closed</p>' })
      let release!: () => void
      const gate = new Promise<void>((resolve) => (release = resolve))
      const outgoingOf = store.outgoing.bind(store)
      vi.spyOn(store, 'outgoing').mockImplementationOnce(async (outgoingId) => {
        await gate
        return outgoingOf(outgoingId)
      })
      const following = composer.followUp()
      await vi.advanceTimersByTimeAsync(10)

      composer.close()
      release()
      await following
      await composer.followUp()

      expect(await store.draft(id)).toBeNull()
      expect((await store.drafts()).find((each) => each.html === '<p>Typed, then closed</p>')).toMatchObject({ sendAttemptId: null })
    })

    it('keeps what is typed while the hidden draft is deleted', async () => {
      const id = await hiddenAfterLostAnswer('Typing on')
      const deleteDraft = store.deleteDraft.bind(store)
      vi.spyOn(store, 'deleteDraft').mockImplementationOnce(async (draftId) => {
        await deleteDraft(draftId)
        composer.update({ html: '<p>Just now</p>' })
      })

      await composer.followUp()

      expect(await store.draft(id)).toBeNull()
      const kept = (await store.drafts()).find((each) => each.html === '<p>Just now</p>')
      expect(kept).toBeDefined()
      expect(composer.state.draft).toMatchObject({ id: kept!.id, html: '<p>Just now</p>' })
    })

    it('writes the kept copy before the hidden draft goes when no form is open', async () => {
      const id = await hiddenAfterLostAnswer('Written here')
      api.offline = true
      composer.update({ html: '<p>Not on the server</p>' })
      await vi.advanceTimersByTimeAsync(1000)
      composer.close()
      await vi.advanceTimersByTimeAsync(10)
      api.offline = false
      const order: string[] = []
      const saveDraft = store.saveDraft.bind(store)
      const deleteDraft = store.deleteDraft.bind(store)
      vi.spyOn(store, 'saveDraft').mockImplementation(async (draft) => {
        order.push(draft.id === id ? 'save hidden' : 'save copy')
        await saveDraft(draft)
      })
      vi.spyOn(store, 'deleteDraft').mockImplementation(async (draftId) => {
        order.push(draftId === id ? 'delete hidden' : 'delete other')
        await deleteDraft(draftId)
      })

      await composer.followUp()

      expect(order.slice(0, 2)).toEqual(['save copy', 'delete hidden'])
      expect((await store.drafts()).find((each) => each.html === '<p>Not on the server</p>')).toBeDefined()
    })

    it('carries the send id into a copy reopened while the send was under way', async () => {
      composer.openNew([{ address: 'anna@example.test', name: null }])
      composer.update({ subject: 'Mid-send' })
      const id = composer.state.draft!.id
      let answer!: () => void
      sendGate = new Promise<void>((resolve) => (answer = resolve))
      sendFails = lost
      const sending = composer.send()
      await vi.waitFor(() => expect(tried).toHaveLength(1))
      const attempt = tried[0]!.outgoingId!
      const reopened = await SqliteMailStore.open(await memorySql())
      currentStore = reopened
      await composer.rebind()
      answer()
      await sending
      await vi.advanceTimersByTimeAsync(1000)

      expect(await reopened.draft(id)).toMatchObject({ sendAttemptId: attempt })
      sendGate = null
      sendFails = null
      await composer.send()
      expect(sent[0]!.outgoingId).toBe(attempt)
    })

    it('opens nothing for a reply whose original loaded only after a sign-out', async () => {
      let answer!: () => void
      const loading = new Promise<void>((resolve) => (answer = resolve))
      const late = new Composer({ ...deps, body: async () => {
        await loading
        return { html: '<p>Old user</p>', text: null, attachments: [] }
      } })
      const opening = late.openReply(original, 'forward', { strict: true })
      late.reset()
      answer()

      await expect(opening).rejects.toBeInstanceOf(OriginalUnavailableError)
      expect(late.state.draft).toBeNull()
      late.dispose()
    })

    it('is dropped by an undo, so sending again is a new send', async () => {
      composer.openNew([{ address: 'anna@example.test', name: null }])
      const id = composer.state.draft!.id
      await composer.send()
      await composer.undo()
      expect(await store.draft(id)).toMatchObject({ sendAttemptId: null, outgoingId: null })

      await composer.send()

      expect(sent).toHaveLength(2)
      expect(sent[1]!.outgoingId).not.toBe(sent[0]!.outgoingId)
    })
  })
})
