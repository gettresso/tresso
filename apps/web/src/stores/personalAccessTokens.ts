import { ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { CreatedPersonalAccessToken, NewPersonalAccessToken, PersonalAccessToken } from '@tresso/core'
import { useAuthStore } from '@/stores/auth'

/**
 * The user's personal access tokens, read and written through the API (they are not part of the synced copy). The
 * secret of a new token is only in what create() returns; the store never keeps it.
 */
export const usePersonalAccessTokensStore = defineStore('personalAccessTokens', () => {
  const auth = useAuthStore()

  const tokens = ref<PersonalAccessToken[]>([])

  async function load(): Promise<PersonalAccessToken[]> {
    tokens.value = await auth.api<PersonalAccessToken[]>('/api/v1/personal-access-tokens')
    return tokens.value
  }

  async function create(token: NewPersonalAccessToken): Promise<CreatedPersonalAccessToken> {
    const created = await auth.send<CreatedPersonalAccessToken>('POST', '/api/v1/personal-access-tokens', token)
    const { token: _secret, ...listed } = created
    tokens.value = [{ ...listed, lastUsedAt: null, revokedAt: null }, ...tokens.value.filter((t) => t.id !== created.id)]
    return created
  }

  async function revoke(id: string): Promise<void> {
    await auth.send<void>('DELETE', `/api/v1/personal-access-tokens/${encodeURIComponent(id)}`)
    await load()
  }

  // The desktop app signs another user in without a reload: nothing of the previous one may show meanwhile.
  watch(
    () => auth.generation,
    () => {
      tokens.value = []
    },
  )

  return { tokens, load, create, revoke }
})
