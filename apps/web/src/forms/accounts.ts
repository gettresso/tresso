import { z } from 'zod'

const PORT_MESSAGE = 'Use a number from 1 to 65535.'

/** A server's settings; `example` is the host name the "enter the server name" message suggests. */
function serverSettings(example: string) {
  const hostMessage = `Enter the server name, for example ${example}.`
  return z.object({
    host: z
      .string()
      .trim()
      .min(1, hostMessage)
      .max(253, 'The server name is too long.')
      .regex(/^[a-z0-9.-]+$/i, hostMessage),
    port: z.number({ invalid_type_error: PORT_MESSAGE }).int(PORT_MESSAGE).min(1, PORT_MESSAGE).max(65535, PORT_MESSAGE),
    security: z.enum(['tls', 'starttls', 'none']),
  })
}

export const serverSchema = serverSettings('mail.example.com')

export const EMAIL_MESSAGE = 'This does not look like an email address. Check for a missing @ or a typo.'

/** The first step of connecting a mail account: only the address. */
export const emailSchema = z.string().trim().min(1, EMAIL_MESSAGE).max(320, EMAIL_MESSAGE).email(EMAIL_MESSAGE)

/** The server form of a new account; the messages suggest server names of the account's own domain. */
export function manualSchema(domain: string) {
  const base = domain === '' ? 'example.com' : domain
  return z.object({
    imap: serverSettings(`imap.${base}`),
    smtp: serverSettings(`smtp.${base}`),
    username: z.string().trim().min(1, 'Enter the username, usually your email address.').max(320),
    password: z.string().min(1, 'Enter the password for this mail account.').max(1024),
  })
}

export const displayNameSchema = z.string().trim().min(1, 'Enter the name people see.').max(120, 'Use at most 120 characters.')

export const accountSchema = z.object({
  displayName: displayNameSchema,
  username: z.string().trim().min(1, 'Enter the username.').max(320),
  /** Empty keeps the current password. */
  password: z.string().max(1024),
  imap: serverSchema,
  smtp: serverSchema,
  /** The CalDAV address of the account's calendars; empty lets Tresso find it. */
  calendarUrl: z
    .string()
    .trim()
    .max(2048, 'The address is too long.')
    .refine((value) => value === '' || /^https:\/\/[^\s/:]+\.[^\s/:]+(:\d+)?(\/\S*)?$/i.test(value), 'Enter an address that starts with https://, for example https://dav.example.com/.'),
})

/** Gmail and Microsoft 365 accounts: only the name is theirs to change; signing in again replaces the rest. */
export const providerAccountSchema = z.object({
  displayName: displayNameSchema,
})

export type ManualValues = z.infer<ReturnType<typeof manualSchema>>
export type AccountValues = z.infer<typeof accountSchema>
export type ProviderAccountValues = z.infer<typeof providerAccountSchema>

/** Validation messages for one server, from a form's flat error map ("imap.host" and so on). */
export function serverErrors(errors: Partial<Record<string, string | undefined>>, prefix: 'imap' | 'smtp'): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [path, message] of Object.entries(errors)) {
    if (message !== undefined && path.startsWith(`${prefix}.`)) result[path.slice(prefix.length + 1)] = message
  }
  return result
}

/** A zod error as a flat map from field path ("imap.host") to its first message. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const issue of error.issues) {
    const path = issue.path.join('.')
    if (!(path in errors)) errors[path] = issue.message
  }
  return errors
}
