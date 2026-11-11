import { beforeEach, describe, expect, it } from 'vitest'
import { defaultSignatureOf, DraftSync, editedFields, newDraft, reopenedDraft, replyDraft, sendRequest, sentOutcome, withEdits } from './drafts'
import { syncedDraft } from './store/rules'
import { ApiFailure, FakeDraftApi } from './drafts.fake'
import { accounts, draft, message, signature } from './store/contract'
import { memorySql } from './store/memorySql'
import { SqliteMailStore } from './store/sqlite'
import type { SyncedOutgoingMessage } from './sync/types'

describe('DraftSync', () => {
  let store: SqliteMailStore
  let api: FakeDraftApi
  let conflicts: number
  let sync: DraftSync

  beforeEach(async () => {
    store = await SqliteMailStore.open(await memorySql())
    api = new FakeDraftApi()
    conflicts = 0
    sync = new DraftSync(() => store, api, () => (conflicts += 1))
  })

  it('creates a new draft on the server, then updates it on its version', async () => {
    await store.saveDraft(draft('d1', { pendingSave: true }))
    await sync.upload('d1')
    expect(await store.draft('d1')).toMatchObject({ version: 1, pendingSave: false })

    await store.saveDraft({ ...(await store.draft('d1'))!, subject: 'Second', pendingSave: true, updatedAt: 2 })
    await sync.upload('d1')

    expect(api.calls).toEqual(['create d1', 'update d1 @1'])
    expect(api.drafts.get('d1')).toMatchObject({ subject: 'Second', version: 2 })
    expect(await store.draft('d1')).toMatchObject({ version: 2, pendingSave: false })
  })

  it("takes no file change of its own for another device's, when the sync brings it back before the answer", async () => {
    await store.saveDraft(draft('d1', { pendingSave: true, updatedAt: 1 }))
    await sync.upload('d1')
    const realAttach = api.attach.bind(api)
    api.attach = async (id, file) => {
      // Typed while the file goes up: the edit waits for its upload.
      await store.saveDraft({ ...(await store.draft('d1'))!, subject: 'Typed', pendingSave: true, updatedAt: 2 })
      const answer = await realAttach(id, file)
      // The realtime sync brings the draft as the file leaves it, before the answer to adding it.
      await store.apply({ cursor: 2, hasMore: false, mailAccounts: [], folders: [], threads: [], messages: [], outgoingMessages: [], signatures: [], drafts: [{ ...api.drafts.get('d1')! }], smartInboxes: [], calendars: [], calendarEvents: [], notifications: [], eventNotes: [], todos: [], mailNotifications: [], handOvers: [], deleted: [] })
      return answer
    }

    await sync.attach('d1', { name: 'plan.pdf', type: 'application/pdf', size: 3, body: 'pdf' })

    expect(await store.draft('d1')).toMatchObject({ version: 2, remoteVersion: null, pendingSave: true })
    await sync.upload('d1')
    expect(conflicts).toBe(0)
    expect(api.drafts.get('d1')).toMatchObject({ subject: 'Typed', version: 3, attachments: [{ filename: 'plan.pdf' }] })
  })

  it('uploads again on the version the copy moved on to while the refused upload was under way', async () => {
    await store.saveDraft(draft('d1', { pendingSave: true, updatedAt: 1 }))
    await sync.upload('d1')
    api.drafts.set('d1', { ...api.drafts.get('d1')!, version: 2 })
    await store.saveDraft({ ...(await store.draft('d1'))!, subject: 'Typed', pendingSave: true, updatedAt: 2 })
    api.during = async () => {
      api.during = null
      // Meanwhile the copy took version 2 (as after a file change of its own).
      await store.changeDraft('d1', (stored) => stored && { ...stored, version: 2 })
    }

    await sync.upload('d1')

    expect(conflicts).toBe(0)
    expect(api.calls.slice(-2)).toEqual(['update d1 @1', 'update d1 @2'])
    expect(api.drafts.get('d1')).toMatchObject({ subject: 'Typed', version: 3 })
  })

  it('asks to settle a draft the server has an older version of, instead of asking again and again', async () => {
    await store.saveDraft(draft('d1', { pendingSave: true, updatedAt: 1 }))
    await sync.upload('d1')
    // The server was restored from a backup: its copy is older than the one here.
    await store.saveDraft({ ...(await store.draft('d1'))!, version: 7, subject: 'Typed', pendingSave: true, updatedAt: 2 })

    await sync.upload('d1')

    expect(api.calls.filter((call) => call.startsWith('update'))).toEqual(['update d1 @7'])
    expect(conflicts).toBe(1)
    expect(await store.draft('d1')).toMatchObject({ remoteVersion: 1, pendingSave: true })
    expect(await sync.resolveConflict('d1', 'mine')).toMatchObject({ remoteVersion: null })
    expect(api.drafts.get('d1')).toMatchObject({ subject: 'Typed', version: 2 })
  })

  it("takes no upload of its own for another device's either", async () => {
    await store.saveDraft(draft('d1', { pendingSave: true, updatedAt: 1 }))
    api.during = async () => {
      api.during = null
      await store.saveDraft({ ...(await store.draft('d1'))!, subject: 'Typed meanwhile', updatedAt: 2 })
    }
    const realCreate = api.create.bind(api)
    api.create = async (id, request) => {
      const saved = await realCreate(id, request)
      // The echo of the upload arrives first; the edit typed meanwhile is still pending.
      await store.apply({ cursor: 2, hasMore: false, mailAccounts: [], folders: [], threads: [], messages: [], outgoingMessages: [], signatures: [], drafts: [saved], smartInboxes: [], calendars: [], calendarEvents: [], notifications: [], eventNotes: [], todos: [], mailNotifications: [], handOvers: [], deleted: [] })
      return saved
    }

    await sync.upload('d1')

    expect(conflicts).toBe(0)
    expect(await store.draft('d1')).toMatchObject({ version: 2, remoteVersion: null, pendingSave: false })
    expect(api.drafts.get('d1')?.subject).toBe('Typed meanwhile')
  })

  it('keeps edits made during an upload pending and sends them right after, never two uploads at once', async () => {
    await store.saveDraft(draft('d1', { pendingSave: true, updatedAt: 1 }))
    let edited = false
    api.during = async () => {
      if (!edited) {
        edited = true
        await store.saveDraft({ ...(await store.draft('d1'))!, subject: 'Typed meanwhile', updatedAt: 2 })
        // Asked for while the first upload runs: it joins that one.
        void sync.upload('d1')
      }
    }

    await sync.upload('d1')

    expect(api.calls).toEqual(['create d1', 'update d1 @1'])
    expect(api.drafts.get('d1')?.subject).toBe('Typed meanwhile')
    expect(await store.draft('d1')).toMatchObject({ version: 2, pendingSave: false })
  })

  it('notes a newer version from another device instead of overwriting it, and settles it either way', async () => {
    await store.saveDraft(draft('d1', { pendingSave: true }))
    await sync.upload('d1')
    api.drafts.set('d1', { ...api.drafts.get('d1')!, subject: 'Elsewhere', version: 5 })
    await store.saveDraft({ ...(await store.draft('d1'))!, subject: 'Here', pendingSave: true, updatedAt: 2 })

    await sync.upload('d1')

    expect(await store.draft('d1')).toMatchObject({ subject: 'Here', remoteVersion: 5, pendingSave: true })
    expect(conflicts).toBe(1)
    // Noted: no more uploads until it is settled.
    await sync.upload('d1')
    expect(api.calls).toEqual(['create d1', 'update d1 @1'])

    expect(await sync.resolveConflict('d1', 'mine')).toMatchObject({ subject: 'Here', version: 6, remoteVersion: null, pendingSave: false })
    expect(api.drafts.get('d1')?.subject).toBe('Here')

    api.drafts.set('d1', { ...api.drafts.get('d1')!, subject: 'Elsewhere again', version: 9 })
    await store.saveDraft({ ...(await store.draft('d1'))!, remoteVersion: 9 })
    expect(await sync.resolveConflict('d1', 'theirs')).toMatchObject({ subject: 'Elsewhere again', version: 9, remoteVersion: null, pendingSave: false })
  })

  it('settles a conflict whose other version is gone by keeping the edits here as a new draft', async () => {
    await store.saveDraft(draft('d1', { pendingSave: true }))
    await sync.upload('d1')
    await store.saveDraft({ ...(await store.draft('d1'))!, subject: 'Here', pendingSave: true, remoteVersion: 3, updatedAt: 2 })
    api.drafts.delete('d1')

    expect(await sync.resolveConflict('d1', 'mine')).toMatchObject({ subject: 'Here', version: 1, remoteVersion: null, pendingSave: false })
    expect(api.calls).toEqual(['create d1', 'create d1'])

    await store.saveDraft({ ...(await store.draft('d1'))!, subject: 'Again', pendingSave: true, remoteVersion: 4, updatedAt: 3 })
    api.drafts.delete('d1')
    expect(await sync.resolveConflict('d1', 'theirs')).toMatchObject({ subject: 'Again', remoteVersion: null })
  })

  it('still says why a conflict cannot be settled when the server cannot be reached', async () => {
    await store.saveDraft(draft('d1', { pendingSave: true, version: 1, remoteVersion: 3 }))
    api.offline = true

    await expect(sync.resolveConflict('d1', 'mine')).rejects.toThrow('Network request failed')
    expect(await store.draft('d1')).toMatchObject({ remoteVersion: 3 })
  })

  it('recognises a create the server has already (its answer was lost), and goes on from there', async () => {
    await store.saveDraft(draft('d1', { pendingSave: true }))
    await sync.upload('d1')
    // The copy here never got the answer: it still has version 0.
    await store.saveDraft({ ...(await store.draft('d1'))!, version: 0, pendingSave: true })

    await sync.upload('d1')

    expect(await store.draft('d1')).toMatchObject({ version: 1, pendingSave: false, remoteVersion: null })
    expect(conflicts).toBe(0)

    // Edited before the lost answer was known: the edits go up on the server's first version.
    await store.saveDraft({ ...(await store.draft('d1'))!, version: 0, subject: 'Edited', pendingSave: true, updatedAt: 2 })
    await sync.upload('d1')

    expect(api.calls).toEqual(['create d1', 'create d1', 'create d1', 'update d1 @1'])
    expect(api.drafts.get('d1')).toMatchObject({ subject: 'Edited', version: 2 })
    expect(await store.draft('d1')).toMatchObject({ version: 2, pendingSave: false, remoteVersion: null })
  })

  it("notes another device's later version when a create is refused, rather than writing over it", async () => {
    await store.saveDraft(draft('d1', { pendingSave: true }))
    await sync.upload('d1')
    api.drafts.set('d1', { ...api.drafts.get('d1')!, subject: 'Elsewhere', version: 4 })
    await store.saveDraft({ ...(await store.draft('d1'))!, version: 0, subject: 'Here', pendingSave: true, updatedAt: 2 })

    await sync.upload('d1')

    expect(await store.draft('d1')).toMatchObject({ subject: 'Here', version: 0, remoteVersion: 4, pendingSave: true })
    expect(conflicts).toBe(1)
    expect(api.drafts.get('d1')).toMatchObject({ subject: 'Elsewhere' })
  })

  it('makes a draft deleted on another device a new one again', async () => {
    await store.saveDraft(draft('d1', { pendingSave: true }))
    await sync.upload('d1')
    api.drafts.delete('d1')
    await store.saveDraft({ ...(await store.draft('d1'))!, pendingSave: true, updatedAt: 2 })

    await sync.upload('d1')

    expect(api.calls).toEqual(['create d1', 'update d1 @1', 'create d1'])
    expect(await store.draft('d1')).toMatchObject({ version: 1, pendingSave: false })
  })

  it('leaves sent drafts and drafts without edits alone, and uploads the rest that are pending', async () => {
    await store.saveDraft(draft('pending', { pendingSave: true }))
    await store.saveDraft(draft('saved', { pendingSave: false, version: 3 }))
    await store.saveDraft(draft('sent', { pendingSave: true, outgoingId: 'o1' }))

    await sync.uploadPending()

    expect(api.calls).toEqual(['create pending'])
  })

  it('deletes a draft here and on the server, also when the server lost it already', async () => {
    await store.saveDraft(draft('d1', { pendingSave: true }))
    await sync.upload('d1')
    await store.saveDraft(draft('local', { pendingSave: true }))

    await sync.deleteEverywhere('d1')
    await sync.deleteEverywhere('local')

    expect(api.calls).toEqual(['create d1', 'remove d1'])
    expect(await store.drafts()).toEqual([])

    await store.saveDraft(draft('gone', { version: 2 }))
    await sync.deleteEverywhere('gone')
    expect(await store.draft('gone')).toBeNull()
  })

  it('says whether the server has the draft before it is sent', async () => {
    expect(await sync.uploadForSending(draft('d1', { pendingSave: true }))).toBe(true)

    api.create = async () => Promise.reject(new ApiFailure(503))
    expect(await sync.uploadForSending(draft('offline', { pendingSave: true }))).toBe(false)
    expect(await store.draft('offline')).not.toBeNull()
  })
})

describe('writing mail', () => {
  const signatures = [signature('sig-work', 'Work')]

  it('starts a reply to the sender and a reply to all without the user, with the quote apart', () => {
    const original = message('m1', 't1', 'work', ['work-inbox'], '2026-10-19T08:00:00+00:00', {
      subject: 'Budget',
      recipients: { to: [{ address: 'kim@company.example', name: 'Kim' }, { address: 'jeroen@example.test', name: 'Jeroen' }], cc: [], bcc: [], replyTo: [] },
    })

    const reply = replyDraft(original, { html: '<p>Numbers</p>', text: null }, 'reply', accounts, signatures)
    const all = replyDraft(original, { html: '<p>Numbers</p>', text: null }, 'replyAll', accounts, signatures)
    const forward = replyDraft(original, { html: null, text: 'Numbers' }, 'forward', accounts, signatures)

    expect(reply).toMatchObject({ kind: 'reply', subject: 'Re: Budget', to: [{ address: 'm1@sender.example' }], cc: [], inReplyToMessageId: 'm1', signatureId: 'sig-work', html: '' })
    expect(reply.quoteHtml).toContain('<p>Numbers</p>')
    expect(all.to.map((a) => a.address).concat(all.cc.map((a) => a.address))).toEqual(['m1@sender.example', 'jeroen@example.test'])
    expect(forward).toMatchObject({ kind: 'forward', subject: 'Fwd: Budget', to: [] })
    expect(forward.quoteHtml).toContain('Numbers')
  })

  it('picks the default signature only when it still exists', () => {
    expect(defaultSignatureOf(accounts, signatures, 'work')).toBe('sig-work')
    expect(defaultSignatureOf(accounts, [], 'work')).toBeNull()
    expect(defaultSignatureOf(accounts, signatures, 'home')).toBeNull()
  })

  it('builds the send request with signature and quote, naming the draft only when the server has it', () => {
    const written = { ...newDraft('reply', 'work', 'sig-work', 'd1'), to: [{ address: 'anna@example.test', name: null }], html: '<p>Yes</p>', quoteHtml: '<blockquote>Q</blockquote>', inReplyToMessageId: 'm1' }
    const at = new Date('2026-10-19T09:00:05Z')

    const request = sendRequest(written, signatures, at, true)

    expect(request).toMatchObject({ mailAccountId: 'work', sendAt: '2026-10-19T09:00:05.000Z', inReplyToMessageId: 'm1', draftId: 'd1' })
    expect(request.html.indexOf('<p>Yes</p>')).toBeLessThan(request.html.indexOf('<p>Work</p>'))
    expect(request.html.indexOf('<p>Work</p>')).toBeLessThan(request.html.indexOf('<blockquote>Q</blockquote>'))
    expect(sendRequest(written, signatures, at, false)).not.toHaveProperty('draftId')
    expect(() => sendRequest({ ...written, mailAccountId: null }, signatures, at, true)).toThrow('Choose the account to send from.')
  })

  it('tells each outcome of a sent draft once, and reopens a failed one for editing', () => {
    const outgoing = (status: SyncedOutgoingMessage['status']): SyncedOutgoingMessage => ({
      id: 'o1',
      mailAccountId: 'work',
      status,
      subject: 'S',
      recipients: { to: [], cc: [], bcc: [] },
      sendAt: '2026-10-19T09:00:00Z',
      sentAt: null,
      lastError: null,
      inReplyToMessageId: null,
    })
    const sent = draft('d1', { outgoingId: 'o1' })

    expect(sentOutcome(sent, outgoing('sent'))).toBe('sent')
    expect(sentOutcome(sent, outgoing('failed'))).toBe('failed')
    expect(sentOutcome(sent, outgoing('scheduled'))).toBe('other')
    expect(sentOutcome(sent, outgoing('cancelled'))).toBe('cancelled')
    expect(sentOutcome({ ...sent, noticedStatus: 'failed' }, outgoing('failed'))).toBeNull()
    expect(sentOutcome(sent, null)).toBeNull()
    expect(sentOutcome(draft('d2'), outgoing('sent'))).toBeNull()

    expect(reopenedDraft({ ...sent, noticedStatus: 'failed', pendingSave: false })).toMatchObject({ outgoingId: null, noticedStatus: null, pendingSave: true })
    expect(reopenedDraft(draft('d2'))).toEqual(draft('d2'))
    expect(reopenedDraft({ ...sent, sendAttemptId: 'a1' }).sendAttemptId).toBeNull()
  })

  it('compares recipients as the server keeps them: trimmed, an empty name none at all', () => {
    const typed = draft('d1', { to: [{ address: ' anna@example.test ', name: '  ' }], cc: [{ address: 'lisa@example.test', name: ' Lisa ' }] })
    const kept = draft('d1', { to: [{ address: 'anna@example.test', name: null }], cc: [{ address: 'lisa@example.test', name: 'Lisa' }] })

    expect(editedFields(typed)).toBe(editedFields(kept))
    expect(editedFields(typed)).not.toBe(editedFields({ ...kept, cc: [{ address: 'lisa@example.test', name: 'Lisa B' }] }))
  })

  it("keeps a send's id while the text it sends stays the same, here and from the server", () => {
    const sending = draft('d1', { sendAttemptId: 'a1', version: 2 })
    const synced = { ...sending, version: 3, updatedAt: '2026-10-19T08:00:00Z' }

    expect(withEdits(sending, { ...sending, sendAttemptId: null }).sendAttemptId).toBe('a1')
    expect(withEdits(sending, { ...sending, subject: 'Edited' }).sendAttemptId).toBeNull()
    expect(syncedDraft(sending, synced)?.sendAttemptId).toBe('a1')
    expect(syncedDraft(sending, { ...synced, html: '<p>Other text</p>' })?.sendAttemptId).toBeNull()
    expect(sendRequest(sending, [], new Date('2026-10-19T09:00:00Z'), true).outgoingId).toBe('a1')
    expect(sendRequest({ ...sending, sendAttemptId: null }, [], new Date('2026-10-19T09:00:00Z'), true)).not.toHaveProperty('outgoingId')
  })
})
