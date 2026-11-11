import type { Verdict } from '../domain'
import type { SyncedDraft, SyncedMessage, SyncedThread, SyncedUnsubscription } from '../sync/types'
import type { Contact, Draft } from './mailStore'

/** Everyone on a new message is a suggestion, under a lower-cased address; addresses without an @ are left out. */
export function peopleOn(message: SyncedMessage): { key: string; person: SyncedMessage['from'] }[] {
  const people = [message.from, ...message.recipients.to, ...message.recipients.cc]
  return people.map((person) => ({ key: person.address.trim().toLowerCase(), person })).filter(({ key }) => key !== '' && key.includes('@'))
}

/** A contact after one more message with them: the newest name and spelling win. */
export function mergeContact(known: Contact | null | undefined, key: string, person: SyncedMessage['from'], at: number): Contact {
  const newer = known == null || at >= known.lastSeen
  return {
    key,
    address: newer ? person.address : known.address,
    name: (newer ? person.name : known.name) ?? known?.name ?? null,
    lastSeen: Math.max(at, known?.lastSeen ?? 0),
    messages: (known?.messages ?? 0) + 1,
  }
}

/** Whether a contact matches what the user typed: the start of its address or of a word of its name. */
export function contactMatches(contact: Contact, query: string): boolean {
  const needle = query.trim().toLowerCase()
  const words = [contact.key, ...(contact.name ?? '').toLowerCase().split(/\s+/)]
  return needle === '' || words.some((word) => word.startsWith(needle))
}

/**
 * What a draft from the server makes of the one on this device. Unsaved edits are never overwritten: when the server
 * moved past the version they build on, the newer version is noted for the user to settle. Returns null when the
 * device's draft stays as it is.
 */
export function syncedDraft(local: Draft | null | undefined, draft: SyncedDraft): Draft | null {
  if (local?.pendingSave) {
    // The text waits for its upload; the files are the server's either way.
    const remoteVersion = draft.version > local.version ? draft.version : local.remoteVersion
    const attachments = draft.attachments ?? []
    if (remoteVersion === local.remoteVersion && JSON.stringify(attachments) === JSON.stringify(local.attachments ?? [])) {
      return null
    }
    return { ...local, remoteVersion, attachments }
  }
  return {
    ...draft,
    updatedAt: Date.parse(draft.updatedAt),
    pendingSave: false,
    remoteVersion: null,
    outgoingId: local?.outgoingId ?? null,
    noticedStatus: local?.noticedStatus ?? null,
    attachments: draft.attachments ?? [],
  }
}

/**
 * What a draft the server deleted leaves on this device: a sent one stays until its outcome is known (the server keeps
 * it meanwhile, version and files, so an undo or a failure brings it back); unsaved edits stay too, as a new draft:
 * the server's copy they build on is gone, and so is any newer version of another device that was noted on them.
 * Returns the draft to keep, or null to delete it.
 */
export function deletedDraft(local: Draft): Draft | null {
  if (local.outgoingId) {
    return { ...local, pendingSave: false, remoteVersion: null }
  }
  return local.pendingSave ? { ...local, version: 0, remoteVersion: null } : null
}

/** A draft as stored by an earlier version of the app, with what it did not know yet. */
export function storedDraft(draft: Draft): Draft {
  return draft.attachments === undefined ? { ...draft, attachments: [] } : draft
}

/** Whether a draft holds something that exists nowhere else: edits not uploaded, or a message whose outcome is pending. */
export function draftOnlyHere(draft: Draft): boolean {
  return draft.pendingSave || draft.outgoingId !== null
}

/** A thread as the user's choice leaves it, before the server confirms: in the smart inbox, with the verdict. */
export function classifiedByUser(thread: SyncedThread, smartInboxId: string, verdict: Verdict): SyncedThread {
  return { ...thread, smartInboxId, verdict, classificationReason: 'user' }
}

/** Whether a thread still shows the user's unconfirmed choice, so putting it back undoes nothing the delta brought. */
export function stillAsClassified(current: SyncedThread | null | undefined, optimistic: { smartInboxId: string; verdict: Verdict }): boolean {
  return current?.smartInboxId === optimistic.smartInboxId && current.verdict === optimistic.verdict && current.classificationReason === 'user'
}

/**
 * Whether the answer to an unsubscribe request should replace what the store has: only when it is a newer request
 * (asked again after a failure). For the same request the stored copy came with the delta, which is at least as new.
 */
export function newerUnsubscription(stored: SyncedUnsubscription | null | undefined, answer: SyncedUnsubscription): boolean {
  return !stored || Date.parse(answer.requestedAt) > Date.parse(stored.requestedAt)
}
