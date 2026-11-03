/** Wire format of /api/v1/connected-apps. */

/** An app that is not ours (such as an MCP client) that the user allowed to act for them. */
export interface ConnectedApp {
  id: string
  /** The name the app gave itself; nobody checked it. */
  name: string
  /** Where the app sends the user back to: a host, `localhost`, or `scheme://host` for an app's own scheme. */
  domain: string
  scopes: string[]
  /** When the user first allowed the app. */
  connectedAt: string
  /** When the app last got a token for the user, to within the hour. */
  lastUsedAt: string | null
}
