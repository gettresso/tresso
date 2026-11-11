/**
 * The local mail copies this browser or app keeps, by user id and name. A copy whose session expired stays (it may hold
 * drafts that never reached the server, and the same user signing in again uploads them); it goes when the user signs
 * out, or when another user signs in here. This list is how a later sign-in finds the copies to remove.
 */
const KEY = 'tresso.mail.copies'

export interface KeptCopy {
  userId: string
  name: string
}

function isKeptCopy(value: unknown): value is KeptCopy {
  return typeof value === 'object' && value !== null && typeof (value as KeptCopy).userId === 'string' && typeof (value as KeptCopy).name === 'string'
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

/** Notes a copy that was opened, so it can be found again once its session is over. */
export function rememberCopy(copy: KeptCopy): void {
  const others = keptCopies().filter((kept) => kept.name !== copy.name)
  write([...others, copy])
}

/** The copy is gone. */
export function forgetCopy(name: string): void {
  write(keptCopies().filter((kept) => kept.name !== name))
}
