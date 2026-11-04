import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { LocationQuery } from 'vue-router'
import type {
  CompleteProviderAuthorization,
  MailAccount,
  MailAccountUpdate,
  NewMailAccount,
  OAuthProviderId,
  OAuthProviderInfo,
  ProviderAuthorization,
  ProviderConnectError,
  ProviderConnection,
  ProviderFeature,
  StartProviderAuthorization,
  SuggestedServerSettings,
} from '@tresso/core'
import { isDesktop, openInBrowser } from '@/platform/desktop'
import { useAuthStore } from '@/stores/auth'

/** Mail account settings, read and written through the API (the synced copy has no server settings). */
export const useAccountsStore = defineStore('accounts', () => {
  const auth = useAuthStore()
  const accounts = ref<MailAccount[]>([])
  const loaded = ref(false)

  async function load(): Promise<void> {
    accounts.value = await auth.api<MailAccount[]>('/api/v1/mail-accounts')
    loaded.value = true
  }

  async function get(id: string): Promise<MailAccount> {
    const account = await auth.api<MailAccount>(`/api/v1/mail-accounts/${encodeURIComponent(id)}`)
    accounts.value = accounts.value.some((a) => a.id === id) ? accounts.value.map((a) => (a.id === id ? account : a)) : [...accounts.value, account]

    return account
  }

  async function create(account: NewMailAccount): Promise<MailAccount> {
    const created = await auth.send<MailAccount>('POST', '/api/v1/mail-accounts', account)
    accounts.value = [...accounts.value, created]

    return created
  }

  async function update(id: string, changes: MailAccountUpdate): Promise<MailAccount> {
    const updated = await auth.send<MailAccount>('PATCH', `/api/v1/mail-accounts/${encodeURIComponent(id)}`, changes)
    accounts.value = accounts.value.map((account) => (account.id === id ? updated : account))

    return updated
  }

  async function remove(id: string): Promise<void> {
    await auth.send<void>('DELETE', `/api/v1/mail-accounts/${encodeURIComponent(id)}`)
    accounts.value = accounts.value.filter((account) => account.id !== id)
  }

  /** Providers this server can sign in with; empty when the operator registered none. */
  const providers = ref<OAuthProviderInfo[]>([])

  async function loadProviders(): Promise<void> {
    providers.value = await auth.api<OAuthProviderInfo[]>('/api/v1/oauth-providers')
  }

  /**
   * Starts a sign-in at the provider and returns where to send the browser; it comes back to the page it left, which
   * finishes with {@link finishProviderSignIn}. With an account id, signs that account in
   * again (after a failed sign-in), or allows more of it (its calendars). The API also asks for what the account
   * allows already, so signing in again for mail keeps the calendars, and nothing is asked for that the user did not
   * choose (a Microsoft tenant may not let its users allow calendars themselves).
   *
   * The desktop app asks for the answer to come back through its `tresso://` link: it opens the provider in the
   * system browser, whose tabs hold none of its tokens, so the web app there could not finish the sign-in.
   */
  async function startProviderSignIn(provider: OAuthProviderId, mailAccountId?: string, features: ProviderFeature[] = ['mail']): Promise<string> {
    const body: StartProviderAuthorization = { provider, features }
    if (mailAccountId !== undefined) body.mailAccountId = mailAccountId
    if (isDesktop) body.returnTo = 'native'
    const started = await auth.send<ProviderAuthorization>('POST', '/api/v1/provider-authorizations', body)

    return started.authorizationUrl
  }

  /**
   * Starts a provider sign-in and opens the provider's page: the web app leaves for it in this tab; the desktop app
   * opens it in the system browser, as its own sign-in does, and stays where it is until the link brings the answer
   * back. Leaving the desktop window itself would end on the web app, another origin without the desktop app's tokens.
   *
   * @returns `browser` when the page opened in the system browser and this window waits, `left` when this tab leaves
   */
  async function openProviderSignIn(provider: OAuthProviderId, mailAccountId?: string, features?: ProviderFeature[]): Promise<'browser' | 'left'> {
    const url = await startProviderSignIn(provider, mailAccountId, features)
    if (!isDesktop) {
      window.location.assign(url)
      return 'left'
    }
    await openInBrowser(url)
    return 'browser'
  }

  /**
   * Back from a provider sign-in: the API passed the provider's answer on in the query (`state` with `code` or
   * `error`), which this hands in with the signed-in user's token, so the sign-in does not depend on the API's own
   * browser session. In the desktop app the query comes from the `tresso://` link the system browser opened. A query with `connectError` already holds the outcome. Null when the query holds no sign-in.
   */
  async function finishProviderSignIn(query: LocationQuery): Promise<ProviderConnection | null> {
    const { provider, state, code, error, connectError } = query
    if (provider !== 'google' && provider !== 'microsoft') return null
    if (typeof connectError === 'string') {
      return { provider, connected: null, grant: null, connectError: connectError as ProviderConnectError }
    }
    if (typeof state !== 'string') return null

    const answer: CompleteProviderAuthorization = { provider, state }
    if (typeof code === 'string') answer.code = code
    if (typeof error === 'string') answer.error = error

    return auth.send<ProviderConnection>('POST', '/api/v1/provider-connections', answer)
  }

  function suggest(emailAddress: string): Promise<SuggestedServerSettings> {
    return auth.api<SuggestedServerSettings>(`/api/v1/mail-server-settings?${new URLSearchParams({ emailAddress })}`)
  }

  return { accounts, loaded, load, get, create, update, remove, suggest, providers, loadProviders, startProviderSignIn, openProviderSignIn, finishProviderSignIn }
})
