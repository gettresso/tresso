/** Wire format of /api/v1/connected-apps. */

/** An app that is not ours (such as an MCP client) that the user allowed to act for them. */
export interface ConnectedApp {
  id: string
  /** The name the app gave itself; nobody checked it. */
  name: string
  /**
   * Every place the app may send the user back to, which is what is checked: hosts, a loopback host for an app on this
   * computer, or an app's reverse-domain scheme.
   */
  domains: string[]
  scopes: string[]
  /** When the user first allowed the app. */
  connectedAt: string
  /** When the app last got a token for the user, to within the hour. */
  lastUsedAt: string | null
}
