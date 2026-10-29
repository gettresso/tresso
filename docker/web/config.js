// Rendered by Caddy on every request (see the web image's Caddyfile): the API this web client talks to.
window.tressoConfig = { apiUrl: {{env "TRESSO_API_URL" | toJson}} }
