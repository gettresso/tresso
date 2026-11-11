import { providerCompany, providerLabel, type MailServiceProvider } from '@tresso/core'

/** What a user can pick in the provider list: the large providers, an Exchange server, or any IMAP server. */
export type ProviderChoice = MailServiceProvider | 'exchange' | 'manual'

/** How a provider connects: its own sign-in page, an app password, or server settings. */
export type ConnectKind = 'oauth' | 'app-password' | 'manual'

export interface ProviderDescription {
  id: ProviderChoice
  /** As the provider list and "uses ..." name it. */
  name: string
  /** The company in sentences: "You sign in on Microsoft's own page". */
  company: string
  /** The letter on the provider's round mark. */
  mark: string
  /** What the provider list says under the name. */
  note: string
  kind: ConnectKind
}

/** iCloud and Yahoo: how to make an app password there. */
export interface AppPasswordGuide {
  /** The mail service's own name: "Connect iCloud Mail with an app password". */
  full: string
  why: string
  steps: string[]
  /** Where the steps start, shown on the button that opens it. */
  site: string
  url: string
  /** What the password looks like, as the field's placeholder. */
  format: string
  /** Under the field: what has to be true for an app password to work. */
  needs: string
}

function described(id: MailServiceProvider, mark: string, note: string, kind: ConnectKind): ProviderDescription {
  return { id, name: providerLabel(id), company: providerCompany(id), mark, note, kind }
}

/** In the order the provider list shows them. */
export const PROVIDERS: Record<ProviderChoice, ProviderDescription> = {
  google: described('google', 'G', 'Gmail and Google Workspace', 'oauth'),
  outlook: described('outlook', 'O', 'Outlook.com, Hotmail and Live', 'oauth'),
  m365: described('m365', 'M', 'Work or school account', 'oauth'),
  icloud: described('icloud', 'i', 'iCloud, me.com and mac.com', 'app-password'),
  yahoo: described('yahoo', 'Y', 'Yahoo Mail', 'app-password'),
  exchange: { id: 'exchange', name: 'Exchange', company: 'your company', mark: 'E', note: "Your company's own mail server", kind: 'manual' },
  manual: { id: 'manual', name: 'Set up manually', company: 'your provider', mark: '@', note: 'Any provider with IMAP and SMTP', kind: 'manual' },
}

export const PICKER_ORDER: ProviderChoice[] = ['google', 'outlook', 'm365', 'icloud', 'yahoo', 'exchange', 'manual']

export const APP_PASSWORD_GUIDES: Record<'icloud' | 'yahoo', AppPasswordGuide> = {
  icloud: {
    full: 'iCloud Mail',
    why: 'Apple does not let other apps use your Apple Account password. Instead you make a separate password just for Tresso. It takes about a minute, and you can remove it at any time.',
    steps: [
      'Go to account.apple.com and sign in with your Apple Account.',
      'Open Sign-In and Security, then choose App-Specific Passwords.',
      'Click the + button, type Tresso as the name and click Create.',
      'Copy the password Apple shows you and paste it below.',
    ],
    site: 'account.apple.com',
    url: 'https://account.apple.com/account/manage',
    format: 'abcd-efgh-ijkl-mnop',
    needs: 'This only works when two-factor authentication is on for your Apple Account. For most accounts it already is.',
  },
  yahoo: {
    full: 'Yahoo Mail',
    why: 'Yahoo does not let other apps use your normal Yahoo password. Instead you make a separate password just for Tresso. It takes about a minute, and you can remove it at any time.',
    steps: [
      'Go to login.yahoo.com and sign in. Open Account info, then Account security.',
      'Click Generate app password. On some accounts it is under App passwords.',
      'Type Tresso as the app name and click Generate password.',
      'Copy the password Yahoo shows you and paste it below.',
    ],
    site: 'login.yahoo.com',
    url: 'https://login.yahoo.com/account/security',
    format: '16 letters',
    needs: 'You can make an app password once two-step verification is on for your Yahoo account. Yahoo shows you how if it is off.',
  },
}

/** The step a provider list choice leads to. */
export function stepFor(choice: ProviderChoice): ConnectKind {
  return PROVIDERS[choice].kind
}
