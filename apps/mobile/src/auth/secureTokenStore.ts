import * as SecureStore from 'expo-secure-store'
import type { TokenSet } from '@tresso/core'
import type { TokenStore } from '@/auth/session'

// Three entries rather than one JSON value: some iOS releases refuse values above about 2 KB, and an access token
// alone comes close to that.
const ACCESS_TOKEN = 'auth.accessToken'
const REFRESH_TOKEN = 'auth.refreshToken'
const EXPIRES_AT = 'auth.expiresAt'
/**
 * Who was signed in last, for opening their mail before the server answers (see MailProvider). It goes on a sign-out
 * the user asked for and before a new sign-in is kept, but stays when the sign-in expires: signing in again as the
 * same user then opens their copy, with the drafts that did not reach the server yet.
 */
export const LAST_USER = 'auth.lastUserId'
/** Set by a sign-out the user asked for, until a sign-in completes: that sign-in asks for the password again. */
const LOGIN_REQUIRED = 'auth.loginRequired'

/** The OS secure store: the iOS Keychain, or values encrypted with the Android Keystore. */
export const secureTokenStore: TokenStore = {
  async load() {
    const [accessToken, refreshToken, expiresAt] = await Promise.all([
      SecureStore.getItemAsync(ACCESS_TOKEN),
      SecureStore.getItemAsync(REFRESH_TOKEN),
      SecureStore.getItemAsync(EXPIRES_AT),
    ])
    // A first save that was cut off leaves an incomplete set; that is no sign-in.
    if (accessToken === null || expiresAt === null || !Number.isFinite(Number(expiresAt))) {
      return null
    }
    return { accessToken, refreshToken, expiresAt: Number(expiresAt) } satisfies TokenSet
  },
  async save(tokens) {
    if (tokens === null) {
      await Promise.all([ACCESS_TOKEN, REFRESH_TOKEN, EXPIRES_AT].map((key) => SecureStore.deleteItemAsync(key)))
      return
    }
    // A save cut off at any step still loads as a sign-in that holds the newest refresh token written: the refresh
    // token goes first (the server retired the old one already), and the old expiry stays until the new one goes in
    // last. An old expiry is earlier than the new one, so at worst the app refreshes sooner than it had to.
    if (tokens.refreshToken === null) {
      await SecureStore.deleteItemAsync(REFRESH_TOKEN)
    } else {
      await SecureStore.setItemAsync(REFRESH_TOKEN, tokens.refreshToken)
    }
    await SecureStore.setItemAsync(ACCESS_TOKEN, tokens.accessToken)
    await SecureStore.setItemAsync(EXPIRES_AT, String(tokens.expiresAt))
  },
  async forgetUser() {
    await SecureStore.deleteItemAsync(LAST_USER)
  },
  refreshToken() {
    return SecureStore.getItemAsync(REFRESH_TOKEN)
  },
  async loginRequired() {
    return (await SecureStore.getItemAsync(LOGIN_REQUIRED)) === 'yes'
  },
  async setLoginRequired(required) {
    await (required ? SecureStore.setItemAsync(LOGIN_REQUIRED, 'yes') : SecureStore.deleteItemAsync(LOGIN_REQUIRED))
  },
}
