/**
 * The local mail copies this browser or app keeps, by user id and name. A copy whose session expired stays (it may hold
 * drafts that never reached the server, and the same user signing in again uploads them); it goes when the user signs
 * out, or when another user signs in here. This list is how a later sign-in finds the copies to remove. A copy whose
 * removal at a sign-out failed is marked (`remove`), so the next start removes it, signed in or not.
 */
const KEY = 'tresso.mail.copies'

export interface KeptCopy {
  userId: string
  name: string
  /** The user signed out and removing the copy failed: it goes at the next start. */
  remove?: true
}

function isKeptCopy(value: unknown): value is KeptCopy {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const copy = value as KeptCopy
  return typeof copy.userId === 'string' && typeof copy.name === 'string' && (copy.remove === undefined || copy.remove === true)
}

/** The copies kept here; empty when storage is refused or holds something else. */
export function keptCopies(): KeptCopy[] {
  let raw: string | null
  try {
    raw = localStorage.getItem(KEY)
  } catch {
    return []
  }
  if (raw === null) {
    return []
  }
  try {
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value) ? value.filter(isKeptCopy) : []
  } catch {
    return []
  }
}

function write(copies: KeptCopy[]): void {
  try {
    if (copies.length === 0) {
      localStorage.removeItem(KEY)
    } else {
      localStorage.setItem(KEY, JSON.stringify(copies))
    }
  } catch (error) {
    // Without storage a later sign-in of someone else cannot find this copy; say so in the console at least.
    console.error('The list of mail copies on this device could not be saved', error)
  }
}

/**
 * Notes a copy that was opened, so it can be found again once its session is over. A mark to remove it goes: its user
 * is back and uses it.
 */
export function rememberCopy(copy: { userId: string; name: string }): void {
  const others = keptCopies().filter((kept) => kept.name !== copy.name)
  write([...others, { userId: copy.userId, name: copy.name }])
}

/** Removing the copy at a sign-out failed: it is to go at the next start, whoever signs in then (or nobody). */
export function markForRemoval(copy: { userId: string; name: string }): void {
  const others = keptCopies().filter((kept) => kept.name !== copy.name)
  write([...others, { userId: copy.userId, name: copy.name, remove: true }])
}

/**
 * Adds copies found on the device that the list does not know: copies left by a release from before this list (0.7
 * and earlier), which would otherwise never be removed when another user signs in. Listed as kept, so the usual rules
 * apply to them.
 */
export function listFoundCopies(found: { userId: string; name: string }[]): void {
  const kept = keptCopies()
  const known = new Set(kept.map((copy) => copy.name))
  const added = found.filter((copy) => !known.has(copy.name))
  if (added.length > 0) {
    write([...kept, ...added.map((copy) => ({ userId: copy.userId, name: copy.name }))])
  }
}

/** The copy is gone. */
export function forgetCopy(name: string): void {
  write(keptCopies().filter((kept) => kept.name !== name))
}
