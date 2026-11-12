# Operations

Steps for whoever runs a Tresso server or tags a release. A self-hosted server needs only the README
([Your own server](../README.md#-your-own-server)); this page adds what Tresso Cloud does around it and what is
checked by hand.

## Moving sign-in and MCP to their own addresses

Tresso Cloud moves its sign-in pages from `api.gettresso.com` to `app.gettresso.com` (`TRESSO_AUTH_URL`) and gives MCP
a host of its own, `mcp.gettresso.com` (`TRESSO_MCP_URL`). Section "Self-hosted and Tresso Cloud" in
[ARCHITECTURE.md](ARCHITECTURE.md) describes what the two settings do. Tresso Cloud's deployment lives in
`gettresso/tresso-internal`; the steps below name its files. Do them in this order.

1. **Tag the release with both settings unset.** The release workflow's "Tell Tresso Cloud" step deploys it to
   production by itself; the server behaves as before, plus the fixes of the release. Right after the deploy, sign in
   once on the web and once from the desktop app: this is the first real use of the Redis session handler, which the
   tests only drive directly. Every browser signs in once more after this deploy (sessions moved from files to Redis);
   apps and their tokens are not touched.
2. **DNS** (`SherinBloemendaal/dns`, `zone_gettresso_com.tf`): add `mcp.gettresso.com`, A and AAAA, proxied, to the
   same server as `api` and `app`. No firewall or Terraform change.
3. **One change in tresso-internal, deployed as one:**
   - `infra/server/env.tpl`: add `TRESSO_AUTH_URL=https://app.gettresso.com` and
     `TRESSO_MCP_URL=https://mcp.gettresso.com`. Leave `TRESSO_MCP_ON_API_HOST` unset (it means on). Then run
     `scripts/push-env`.
   - `infra/server/compose.cloud.yaml`, `configs.proxy` (kept in step with `compose.prod.yaml` by hand): in the
     `${TRESSO_WEB_URL}` block, before the web route, send the six sign-in paths to the API and put the web route in a
     `handle` of its own:

     ```
     @signin path /login /logout /oauth/authorize /auth/auth.css /auth/tresso.svg /auth/fonts/*
     handle @signin {
     	reverse_proxy api:80 {
     		header_up X-Forwarded-For {client_ip}
     	}
     }
     handle {
     	reverse_proxy web:80 { ... as now ... }
     }
     ```

     `/auth/callback` is the web client's own route: never send `/auth/*` as a whole to the API, or every web sign-in
     ends on a 404 after the password. Add the MCP host to the API site address,
     `${TRESSO_API_URL} ${TRESSO_MCP_URL:-} {`, with the same `reverse_proxy api:80` and `header_up` line.
   - Login throttling behind the proxy: the sign-in form counts wrong passwords per client address (5 per address and
     IP, 25 per IP, 15 minutes). The API takes that address from `X-Forwarded-For` only from a proxy that
     `SYMFONY_TRUSTED_PROXIES` covers (`compose.prod.yaml` sets `private_ranges`, which covers the proxy container),
     and the `header_up` line makes the proxy pass the visitor's address instead of Cloudflare's. `{client_ip}` is the
     visitor's address only when Caddy trusts Cloudflare's ranges (`trusted_proxies`); check that it does. Without
     both, every visitor counts as one address and 25 wrong passwords lock the form for everyone.
   - The API and web services get the three settings from the release's `compose.prod.yaml`; pass them on yourself
     only where `compose.cloud.yaml` overrides those environments (`AUTH_PUBLIC_URL`, `MCP_PUBLIC_URL`,
     `MCP_ON_API_HOST` for the API, `TRESSO_AUTH_URL` for the web image).
   - Never set `TRESSO_AUTH_URL` before the proxy routes are live: `/login` on the web address would reach the web
     client and nobody could sign in.
4. **`.github/workflows/deploy.yml`**: besides `/health` and the web root, check that
   `https://app.gettresso.com/login` answers 200, and that a POST without a token to `https://mcp.gettresso.com/mcp`
   answers 401 naming `https://mcp.gettresso.com/.well-known/oauth-protected-resource/mcp` in its `resource_metadata`.
5. **Cloudflare**: no cache or page rule may cache `/login`, `/logout` or `/oauth/authorize` on `app.gettresso.com`
   (the API sends `no-store` on all three). The web image sends a Content-Security-Policy with `script-src 'self'`:
   Rocket Loader must be off for `app.gettresso.com` (it would break the app), and Web Analytics injection would only
   log an error. Open the browser console on `app.gettresso.com` once after the deploy and look for CSP errors.
6. **Check by hand:**
   - Web sign-in from a signed-out browser, on `app.gettresso.com`.
   - An installed desktop app signs in: it opens the API address and is sent on to the app address.
   - An existing MCP connection on `https://api.gettresso.com/mcp` still calls a tool and refreshes its token.
   - A new MCP connection on `https://mcp.gettresso.com/mcp` registers and signs in.
   - A third-party client that sends `resource=https://api.gettresso.com/mcp` still reaches its consent screen.

   Every browser signs in once more on the app address, since its sign-in cookie belonged to the API host. Tokens are
   not touched.
7. **Then** change the public MCP address to `https://mcp.gettresso.com/mcp` in the README (the Claude section) and on
   the website, and add `mcp.gettresso.com` and the sign-in on `app.gettresso.com` to the address table in
   tresso-internal's `docs/CLOUD-RUNBOOK.md`.
8. **Much later**, on the owner's decision: `TRESSO_MCP_ON_API_HOST=0` ends MCP on the API host. Clients set up with
   the old address then add the server again under the new one and sign in once.
9. **Nothing changes at Google, Microsoft or Stripe:** `/connect/...` and the Stripe webhook stay on the API host.

A self-hosted server does the same with its own names; the README has the short version
([Sign-in on the web address, MCP on its own host](../README.md#sign-in-on-the-web-address-mcp-on-its-own-host)).

## Check by hand after a release

No test covers these. Tick them on a built app, a device or the server once per release.

Phone:

1. Android: a link in a mail opens, a link to a place inside the mail (a table of contents) scrolls there, and the
   mail body grows to its content.
2. iOS: the same three checks.
3. Sign out, then Sign in asks for the password again.
4. After a session expired (not a sign-out), the mail and an unsent draft are still there after signing in again.

Desktop app:

5. A `mailto:` link in an HTML mail opens the mail app and leaves the Tresso window as it was (macOS and Linux).
6. An http(s) link in an HTML mail opens in the default browser on macOS, Windows and Linux.
7. A keychain question at launch or refresh (macOS access prompt, a locked Linux keyring) keeps the window drawing
   and movable.
8. Windows: sign in, quit, start again: still signed in.
9. macOS: an installed previous release updated through Sparkle is still signed in and shows the mail without a full
   sync (expect one keychain question; Deny shows "The saved sign-in could not be read").

DMG:

10. `Tresso-<version>.dmg` mounts as "Tresso <version>" with its background, the icons on the arrow, and the app
    named "Tresso", not "Tresso.app".

Web client, in the desktop app and in browsers:

11. The verdict bar wraps at narrow widths; the hand-over dialog and its suggestion list sit right.
12. The back link and calendar drawer below 1100 px; compose, reading pane and settings at 375 px; touch sizes.
13. Dark mode: notices, a yellow or pastel calendar, avatars; the same calendars in WKWebView and WebKitGTK.
14. The sync banner with a long error at 375, 1100, 1280 and 1440 px, with no draft, an open and a minimized one:
    Send, Send later, Undo and the minimized bar stay clickable; hide it, recover, break it again.
15. In the macOS app and in Chrome: Escape inside Hand over (list open, twice, after Send later opened with the
    mouse) returns focus to the Hand over button; the dialog in a 600 px high window; the drawer by keyboard.
16. The three segmented controls have one size.

Server:

17. Sign in once on the web right after the deploy (the Redis session handler).
18. After moving sign-in and MCP: the five checks of step 6 above.
19. A Microsoft 365 tenant: an event update or cancellation from a colleague is applied, one from outside the
    organization waits for the user.
