/**
 * Where the browser signs in. A server may put its sign-in pages on another address than the API (`AUTH_PUBLIC_URL`)
 * and names it as `authorization_endpoint` in its authorization server metadata (RFC 8414), which stays on the API
 * address. When the metadata cannot be read or names no usable address, the API's own `/oauth/authorize` is used:
 * every server answers there, and one with a separate sign-in address sends the browser on to it with the same query.
 */
export async function authorizationEndpoint(apiUrl: string, fetchImpl: typeof fetch = (input, init) => fetch(input, init)): Promise<string> {
  const api = apiUrl.replace(/\/+$/, '')
  const fallback = `${api}/oauth/authorize`
  try {
    const response = await fetchImpl(`${api}/.well-known/oauth-authorization-server`, { headers: { Accept: 'application/json' } })
    if (!response.ok) {
      return fallback
    }
    const metadata: unknown = await response.json()
    const named = typeof metadata === 'object' && metadata !== null ? (metadata as { authorization_endpoint?: unknown }).authorization_endpoint : undefined
    if (typeof named !== 'string') {
      return fallback
    }
    const endpoint = new URL(named)
    // A plain http sign-in page only for a server that is itself reached over http (a development server).
    return endpoint.protocol === 'https:' || endpoint.protocol === new URL(api).protocol ? endpoint.toString() : fallback
  } catch {
    return fallback
  }
}
