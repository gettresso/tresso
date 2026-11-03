import { z } from 'zod'

/** Mirrors the API's rules for a new personal access token (CreatePersonalAccessToken). */
export const personalAccessTokenSchema = z.object({
  name: z.string().trim().min(1, 'Give the token a name.').max(80, 'Use at most 80 characters.'),
  scopes: z.array(z.string()).min(1, 'Choose at least one permission.'),
  // The same choices as PERSONAL_ACCESS_TOKEN_LIFETIMES.
  expiresInDays: z.union([z.literal(30), z.literal(90), z.literal(365)]),
})

export type PersonalAccessTokenValues = z.infer<typeof personalAccessTokenSchema>
