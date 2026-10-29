import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SendMessageRequest } from './compose'
import { Composer, type ComposerNotice } from './composer'
import { DraftSync } from './drafts'
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
  let cancelled: string[]
  let notices: ComposerNotice[]
  let api: FakeDraftApi
  let originalFiles: MessageAttachment[]
  let originalHtml: string
  let sendFails: unknown
  let sendGate: Promise<void> | null
  let currentStore: SqliteMailStore | null
  let changes: number
  let composer: Composer

  beforeEach(async () => {
    vi.useFakeTimers()
    store = await SqliteMailStore.open(await memorySql())
    await store.apply(page({ cursor: 1, mailAccounts: accounts, signatures: [signature('sig-work', 'Work')] }))
    sent = []
    cancelled = []
    notices = []
    sendFails = null
    sendGate = null
    currentStore = store
    changes = 0
    api = new FakeDraftApi()
    originalFiles = []
    originalHtml = '<p>Numbers?</p>'
    composer = new Composer({
      store: () => currentStore,
      drafts: new DraftSync(() => currentStore, api),
      accounts: () => accounts,
      signatures: () => [signature('sig-work', 'Work')],
      defaultAccount: () => 'work',
      body: async () => ({ html: originalHtml, text: null, attachments: originalFiles }),
      send: async (request) => {
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
    })
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

    composer.close()
    await vi.advanceTimersByTimeAsync(10)
    expect(changes).toBe(afterFirst + 1)
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
})
