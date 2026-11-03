/** Wire format of /api/v1/personal-access-tokens. */

/** A token as the list shows it: never with its secret. */
export interface PersonalAccessToken {
  id: string
  name: string
  /** The start of the secret, such as `tresso_pat_Xk3f9a`, to tell tokens apart. */
  prefix: string
  scopes: string[]
  createdAt: string
  expiresAt: string
  lastUsedAt: string | null
  revokedAt: string | null
}

/** The answer to creating a token: the only time the secret (`token`) is handed out. */
export interface CreatedPersonalAccessToken {
  id: string
  name: string
  prefix: string
  scopes: string[]
  createdAt: string
  expiresAt: string
  token: string
}

export const PERSONAL_ACCESS_TOKEN_LIFETIMES = [30, 90, 365] as const
export type PersonalAccessTokenLifetime = (typeof PERSONAL_ACCESS_TOKEN_LIFETIMES)[number]
export const DEFAULT_PERSONAL_ACCESS_TOKEN_LIFETIME: PersonalAccessTokenLifetime = 90

export interface NewPersonalAccessToken {
  name: string
  scopes: string[]
  expiresInDays: PersonalAccessTokenLifetime
}

export interface PersonalAccessTokenScope {
  value: string
  label: string
  /** What a script holding this can do, in plain words. */
  description: string
}

/** What a personal access token may hold, mirroring the API (Scope::personalAccessTokenScopes()). */
export const PERSONAL_ACCESS_TOKEN_SCOPES: readonly PersonalAccessTokenScope[] = [
  { value: 'mail:read', label: 'Read mail', description: 'Read your messages, conversations and attachments in every account.' },
  { value: 'mail:write', label: 'Organize mail', description: 'Archive, move, flag, mark as read and delete messages.' },
  { value: 'mail:send', label: 'Send mail', description: 'Send messages from your accounts, in your name.' },
  { value: 'todos:read', label: 'See todos', description: 'See your todos and when they are planned.' },
  { value: 'todos:write', label: 'Change todos', description: 'Add, complete, change and delete todos.' },
  { value: 'calendar:read', label: 'See calendar', description: 'See your calendars and events, with their guests.' },
  { value: 'calendar:write', label: 'Change calendar', description: 'Add, change and delete events and set your answers. Telling guests or organizers also needs Send mail.' },
  { value: 'signatures:read', label: 'See signatures', description: 'See your email signatures.' },
  { value: 'signatures:write', label: 'Change signatures', description: 'Add, change and delete email signatures.' },
  { value: 'settings:read', label: 'See settings', description: 'See your mail accounts, smart inboxes and other settings.' },
  { value: 'settings:write', label: 'Change settings', description: 'Change settings such as account names, smart inboxes, rules and notifications. Never how a mail account connects, access tokens or connected apps.' },
]

/** The label of a scope, or the scope itself for one this version does not know. */
export function personalAccessTokenScopeLabel(scope: string): string {
  return PERSONAL_ACCESS_TOKEN_SCOPES.find((known) => known.value === scope)?.label ?? scope
}

export type PersonalAccessTokenStatus = 'active' | 'expired' | 'revoked'

export function personalAccessTokenStatus(token: Pick<PersonalAccessToken, 'expiresAt' | 'revokedAt'>, now: Date = new Date()): PersonalAccessTokenStatus {
  if (token.revokedAt !== null) {
    return 'revoked'
  }

  return new Date(token.expiresAt).getTime() <= now.getTime() ? 'expired' : 'active'
}
