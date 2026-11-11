import type { SyncedFolder, SyncedMailAccount, SyncedMessage } from './sync/types'

/**
 * What the user does to messages: read, flag, archive, trash, move. `POST /api/v1/message-actions` makes the change
 * at once and the account's sync worker makes it on the mail server.
 */
export type MessageAction = 'markRead' | 'markUnread' | 'flag' | 'unflag' | 'archive' | 'trash' | 'move'

export interface MessageActionRequest {
  messageIds: string[]
  action: MessageAction
  /** The folder to move into; only for `move`. */
  folderId?: string
  /** Only for `move`: move just the copies in this folder (e.g. to undo a move exactly), not every copy. */
  fromFolderId?: string
}

export interface MessageActionResult {
  /** How many of the messages changed; the others already were that way. */
  changed: number
}

/** Most messages one request takes. */
export const MAX_MESSAGES_PER_ACTION = 500

/** The account has no folder for the action, e.g. nothing to archive into. */
export class MissingFolderError extends Error {
  constructor(
    readonly account: string,
    readonly folder: string,
  ) {
    super(`${account} has no ${folder} folder.`)
    this.name = 'MissingFolderError'
  }
}

/**
 * A large selection went partly through: `accepted` is what the server took, `rejected` how many of the requested
 * messages it did not, and `reason` why.
 */
export class PartialActionError extends Error {
  constructor(
    readonly reason: unknown,
    readonly accepted: AppliedAction,
    readonly rejected: number,
  ) {
    super(reason instanceof Error ? reason.message : String(reason))
    this.name = 'PartialActionError'
  }
}

/** Messages as they were before an action and as it left them, to undo it with. */
export interface AppliedAction {
  before: SyncedMessage[]
  after: SyncedMessage[]
}

/** The part of an applied action that concerns these messages. */
export function appliedFor(applied: AppliedAction, messageIds: Set<string>): AppliedAction {
  const keep = applied.before.map((message) => messageIds.has(message.id))
  return { before: applied.before.filter((_, i) => keep[i]), after: applied.after.filter((_, i) => keep[i]) }
}

/**
 * The messages as an action leaves them, the way the server makes it: flags change, and archived, trashed or moved
 * messages change folders (archiving takes them out of the inbox into Archive, or All Mail where there is none; a move
 * with `fromFolderId` takes only that folder's copy). Clients show this at once, before the server confirms it.
 *
 * @throws MissingFolderError when an account has nothing to archive or trash into
 */
export function actionResult(
  messages: SyncedMessage[],
  action: MessageAction,
  context: { folders: SyncedFolder[]; accounts: SyncedMailAccount[]; folderId?: string | undefined; fromFolderId?: string | undefined },
): SyncedMessage[] {
  const accounts = new Map(context.accounts.map((account) => [account.id, account.emailAddress]))
  const inboxFolders = new Set(context.folders.filter((folder) => folder.role === 'inbox').map((folder) => folder.id))
  const byRole = (accountId: string, ...roles: SyncedFolder['role'][]): SyncedFolder | undefined => {
    for (const role of roles) {
      const folder = context.folders.find((candidate) => candidate.mailAccountId === accountId && candidate.role === role)
      if (folder !== undefined) {
        return folder
      }
    }
    return undefined
  }
  const { folderId, fromFolderId } = context

  return messages.map((message) => {
    const flags = message.flags
    switch (action) {
      case 'markRead':
      case 'markUnread':
        return { ...message, flags: { ...flags, seen: action === 'markRead' } }
      case 'flag':
      case 'unflag':
        return { ...message, flags: { ...flags, flagged: action === 'flag' } }
      case 'archive': {
        const target = byRole(message.mailAccountId, 'archive', 'all')
        if (target === undefined) {
          throw new MissingFolderError(accounts.get(message.mailAccountId) ?? message.mailAccountId, 'Archive')
        }
        if (!message.folderIds.some((id) => inboxFolders.has(id))) {
          return message
        }
        return { ...message, folderIds: withFolder(message.folderIds.filter((id) => !inboxFolders.has(id)), target.id) }
      }
      case 'trash': {
        const target = byRole(message.mailAccountId, 'trash')
        if (target === undefined) {
          throw new MissingFolderError(accounts.get(message.mailAccountId) ?? message.mailAccountId, 'Trash')
        }
        return { ...message, folderIds: [target.id] }
      }
      case 'move':
        if (folderId === undefined) {
          throw new Error('A move needs a folder.')
        }
        if (fromFolderId !== undefined) {
          return message.folderIds.includes(fromFolderId) ? { ...message, folderIds: withFolder(message.folderIds.filter((id) => id !== fromFolderId), folderId) } : message
        }
        return { ...message, folderIds: [folderId] }
    }
  })
}

type Part = 'seen' | 'flagged' | 'folders'

const PARTS: { part: Part; read: (message: SyncedMessage) => string; write: (message: SyncedMessage, value: string) => SyncedMessage }[] = [
  { part: 'seen', read: (message) => String(message.flags.seen), write: (message, value) => ({ ...message, flags: { ...message.flags, seen: value === 'true' } }) },
  { part: 'flagged', read: (message) => String(message.flags.flagged), write: (message, value) => ({ ...message, flags: { ...message.flags, flagged: value === 'true' } }) },
  { part: 'folders', read: (message) => JSON.stringify(message.folderIds), write: (message, value) => ({ ...message, folderIds: JSON.parse(value) as string[] }) },
]

/**
 * The actions of this device that changed a part of a message (read, flagged, folders) and that the server has not
 * answered for yet, so one it refuses can be taken back. Actions on the same part may overlap (marked read, then
 * unread, before either request was answered): the part goes back only once the last one open was refused, to how it
 * was before the first, and only while it still shows the newest one's result. A change the delta brings for the
 * message ends them all: the server has spoken.
 */
export class OpenActions {
  private readonly open = new Map<string, { count: number; before: string; latest: string }>()

  /** An action changed `before` into `after` on this device. */
  applied(before: SyncedMessage, after: SyncedMessage): void {
    for (const { part, read } of PARTS) {
      if (read(before) === read(after)) {
        continue
      }
      const key = `${before.id} ${part}`
      const known = this.open.get(key)
      if (known === undefined) {
        this.open.set(key, { count: 1, before: read(before), latest: read(after) })
      } else {
        known.count += 1
        known.latest = read(after)
      }
    }
  }

  /** The delta brought the message: whatever was open for it, the server's version stays. */
  confirmed(messageId: string): void {
    for (const { part } of PARTS) {
      this.open.delete(`${messageId} ${part}`)
    }
  }

  /**
   * The action that changed `before` into `after` was refused. Returns the message as it is to be stored (`current`
   * with each part put back that no other open action holds and that still shows the newest result), or null when
   * nothing goes back.
   */
  refused(current: SyncedMessage, before: SyncedMessage, after: SyncedMessage): SyncedMessage | null {
    let reverted = current
    for (const { part, read, write } of PARTS) {
      if (read(before) === read(after)) {
        continue
      }
      const key = `${before.id} ${part}`
      const known = this.open.get(key)
      if (known === undefined) {
        continue
      }
      known.count -= 1
      if (known.count > 0) {
        continue
      }
      this.open.delete(key)
      if (read(current) === known.latest) {
        reverted = write(reverted, known.before)
      }
    }
    return reverted === current ? null : reverted
  }
}

function withFolder(folderIds: string[], folderId: string): string[] {
  return folderIds.includes(folderId) ? folderIds : [...folderIds, folderId]
}

/** Moves that put messages back: from the folder an action took them to, into the one it took them from. */
export interface UndoMove {
  fromFolderId: string
  folderId: string
  messageIds: string[]
}

export interface UndoPlan {
  moves: UndoMove[]
  /** Whether the moves put every changed message back exactly. */
  exact: boolean
  /** Changed messages the moves leave where they are, because no move puts them back exactly. */
  unrestorable: number
}

/**
 * How to undo an archive, trash or move. Only messages the action changed are put back, each from where it went into
 * the one folder it came from. A message that came from several folders (Gmail's All Mail aside, which holds every
 * message anyway) cannot be put back exactly, because a move takes every copy along; neither can mail archived into
 * Gmail's All Mail, where moving out would delete it from Gmail. Those stay where they are and are counted.
 */
export function undoPlan(applied: AppliedAction, action: 'archive' | 'trash' | 'move', folders: SyncedFolder[]): UndoPlan {
  const roles = new Map(folders.map((folder) => [folder.id, folder.role]))
  const groups = new Map<string, UndoMove>()
  let unrestorable = 0

  applied.before.forEach((before, index) => {
    const after = applied.after[index]
    if (after === undefined || sameFolders(before.folderIds, after.folderIds)) {
      return
    }
    const original = before.folderIds.filter((id) => roles.get(id) !== 'all')
    let from: string | undefined
    let to: string | undefined
    if (action === 'archive') {
      const left = original.filter((id) => roles.get(id) === 'inbox')
      from = after.folderIds.find((id) => roles.get(id) === 'archive')
      // A copy that was in Archive already would go back to the inbox with the archived one.
      to = left.length === 1 && (from === undefined || !before.folderIds.includes(from)) ? left[0] : undefined
    } else {
      from = after.folderIds.find((id) => !before.folderIds.includes(id)) ?? after.folderIds[0]
      to = original.length === 1 ? original[0] : undefined
    }
    if (from === undefined || to === undefined || roles.get(to) === 'drafts' || roles.get(to) === 'all') {
      unrestorable++
      return
    }
    const key = `${from}>${to}`
    const group = groups.get(key) ?? { fromFolderId: from, folderId: to, messageIds: [] }
    group.messageIds.push(before.id)
    groups.set(key, group)
  })

  return { moves: [...groups.values()], exact: unrestorable === 0, unrestorable }
}

function sameFolders(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id))
}
