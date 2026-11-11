// Rendered by Caddy on every request (see the web image's Caddyfile): the API this web client talks to, and where its
// users sign in and out (TRESSO_AUTH_URL; empty means the API address).
window.tressoConfig = { apiUrl: {{env "TRESSO_API_URL" | toJson}}, authUrl: {{env "TRESSO_AUTH_URL" | toJson}} }
