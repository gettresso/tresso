import { signInProvider, type MailAccount } from '@tresso/core'

/** What stands next to a mail account or WhatsApp: a brand mark, or the plain mail icon for a mail server. */
export type ProviderKind = 'microsoft' | 'google' | 'mail' | 'whatsapp'

/** The kinds a mail account can get: WhatsApp is not a mail account. */
export type MailProviderKind = Exclude<ProviderKind, 'whatsapp'>

/** The kinds drawn with a brand mark; `mail` is the AppIcon `mail` instead. */
export type BrandKind = Exclude<ProviderKind, 'mail'>

/**
 * The brand marks next to accounts: one path each in a 24x24 viewBox, copied unchanged from Simple Icons (the SVG files
 * are CC0, https://github.com/simple-icons/simple-icons), drawn inline so nothing is fetched at runtime.
 */
export interface ProviderBrandMark {
  path: string
  /** The brand colour on the light tile. Microsoft's grey does not read on the dark tile; ProviderMark.vue swaps it there. */
  color: string
}

export const PROVIDER_MARKS: Readonly<Record<BrandKind, ProviderBrandMark>> = {
  /**
   * https://cdn.jsdelivr.net/npm/simple-icons@12.4.0/icons/microsoft.svg (slug microsoft, brand hex 5E5E5E). Later
   * versions no longer carry this file.
   */
  microsoft: {
    path: 'M0 0v11.408h11.408V0zm12.594 0v11.408H24V0zM0 12.594V24h11.408V12.594zm12.594 0V24H24V12.594z',
    color: '#5E5E5E',
  },
  /** https://cdn.jsdelivr.net/npm/simple-icons@16.38.1/icons/google.svg (slug google, brand hex 4285F4). */
  google: {
    path: 'M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z',
    color: '#4285F4',
  },
  /** https://cdn.jsdelivr.net/npm/simple-icons@16.38.1/icons/whatsapp.svg (slug whatsapp, brand hex 25D366). */
  whatsapp: {
    path: 'M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z',
    color: '#25D366',
  },
}

/**
 * The kind of mark for a mail account.
 *
 * Security: the kind comes only from the provider type the server reports for the account (`provider`: "gmail",
 * "microsoft" or "imap"), never from the display name, the address or its domain, or anything else a user or an app
 * typed. Otherwise any mail server account could dress up as Google or Microsoft by its name or address. The parameter
 * takes only `provider`, so nothing else can slip in: an IMAP account named "Google" at a gmail.com address gets `mail`.
 */
export function markForAccount(account: Pick<MailAccount, 'provider'>): MailProviderKind {
  return signInProvider(account) ?? 'mail'
}
