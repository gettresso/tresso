# Architecture

Product name: **Tresso**.

## 1. Product principle

> An email is something you need to **do**, **hand over** to someone else, or just **know**.

Every message converges on one of three verdicts:

| Verdict | Created artifact | Resolved when |
|---|---|---|
| `do` | Todo linked to the thread (due date extracted when present) | Todo completed, email auto-archives |
| `delegate` | Handed over with a note and due date: forwarded to someone, or later assigned to a teammate; appears in "Waiting on" | The other person completes it or replies |
| `know` | Entry in the daily brief, one-click "Noted" | Read or acknowledged, email auto-archives |

Categories (built-in: `spam`, `notification`, `advertise`, `todo`, `informational`; plus user-defined) feed the
verdicts through configurable mappings (e.g. `todo` -> `do`, `informational` -> `know`). Tresso classifies with
rules; AI classification is planned, with your own key or endpoint.

## Self-hosted and Tresso Cloud

Everything Tresso does is in this repository, licensed `AGPL-3.0-only`: the apps, the API, the sync workers and the
shared libraries. Running it on your own server is free and has every feature.

| | What it is | Costs |
|---|---|---|
| **Self-hosted** | This repository on your own server: accounts, mail, calendar, smart inboxes, the three verdicts, todos, signatures, settings, web, desktop and mobile apps, and every feature still to come | Free |
| **Tresso Cloud** | The managed hosting of the same code and the same image, run for you with backups and support | A subscription per organization, paying for its members |

A subscription pays for hosting, never for features. The managed service adds only operations around the same code.
Billing lives in this repository too, turned on by configuration on that server (`TRESSO_BILLING`) and off everywhere
else; its infrastructure, secrets and runbooks live outside this repository. [Billing](BILLING.md) describes the model,
the API and the Stripe side. Features with an outside provider, such as AI, take your own key or endpoint, so they work
self-hosted too.

### Deployment

Every release publishes three images on `ghcr.io/gettresso`: `tresso-api` (FrankenPHP; the same image runs the API and,
with another command, every Messenger worker), `tresso-sync` (the Go sync workers) and `tresso-web` (the web client on
Caddy), each for amd64 and arm64. Nothing server-specific is built in: the web image renders `/config.js` from
`TRESSO_API_URL` (and the optional `TRESSO_AUTH_URL`, where users sign in when that is not the API address) when it
serves it, and sends a Content-Security-Policy that lets the page load code only from itself, connect only to itself,
the API's origin and the realtime hub's (the API's origin, or `TRESSO_HUB_URL` when `MERCURE_PUBLIC_URL` is on another
host), and send forms only to itself, the API and the sign-in pages; the API reads everything from its environment. `compose.prod.yaml` runs them
with a Caddy proxy that gets the certificates, and with the services they need. Before anything else the API image runs
`app:settings:check`, which refuses to start while a secret is missing, too short or one of the development values in
the repository's `.env` files, since a production image would otherwise fall back to those public values. The API
container (`RUN_MIGRATIONS=1`) then makes the OAuth signing keys once, in a volume, migrates the database and updates
the first-party OAuth clients; the workers start when it is healthy.

Migrations keep the large tables (`message` above all) usable while they run. A new column is nullable or has a
constant default, which changes only the catalog. An index on such a table gets a migration of its own that runs
outside a transaction (`isTransactional()` is false) with `CREATE INDEX CONCURRENTLY`, first dropping an index of the
same name that a cut-off build left invalid. What an operator sees: the migration log names that migration and it
takes as long as a scan of the table, while reads and writes go on (Messenger workers, and on a rolling deploy API
instances of the previous release, keep working); if the start is cut off during the build, the migration is not recorded as
done and the next start builds the index again.

A server has two public addresses, the web client's (`WEB_APP_URL`) and the API's (`API_PUBLIC_URL`), and may give two
things a host of their own (`App\Deployment\PublicAddresses`):

- `AUTH_PUBLIC_URL`: the sign-in pages (`/login`, `/logout`, `/oauth/authorize` with the consent screen). Tresso Cloud
  sets it to the web address, where its proxy sends `/login`, `/logout`, `/oauth/authorize` and the pages' files
  (`/auth/auth.css`, `/auth/tresso.svg`, `/auth/fonts/*`) to the API, and nothing else: `/auth/callback` is the web
  client's own route and stays with it. So the browser's sign-in belongs to the address people use. The authorization server metadata names it as `authorization_endpoint`; the
  issuer, the token, registration and revocation endpoints and the metadata stay on the API host (RFC 8414 allows
  that), so no app sees another authorization server. A GET of a sign-in page on the API or web host that is not
  `AUTH_PUBLIC_URL` is redirected there with its path and query (`SignInHost`): installed apps that open
  `<API_PUBLIC_URL>/oauth/authorize` keep working. Other hosts are left alone.
- `MCP_PUBLIC_URL`: the MCP endpoint at `<MCP_PUBLIC_URL>/mcp`. That host answers only `/mcp` and its protected
  resource metadata (404 for anything else, `McpHost`). While `MCP_ON_API_HOST` is on (the default), `/mcp` keeps
  answering on the API host too, for clients set up with that address; a redirect would break them (clients drop the
  `Authorization` header on a redirect to another host, and many do not follow a redirected POST). Only clients that
  follow RFC 9728 are supported on the MCP host: `/.well-known/oauth-authorization-server` stays on the API host.
- Left empty, both are the API address and nothing changes. In production both must then be empty or a bare https
  origin, and the MCP host may not be the web or sign-in host (`app:settings:check`). `compose.prod.yaml` passes them
  from `TRESSO_AUTH_URL`, `TRESSO_MCP_URL` and `TRESSO_MCP_ON_API_HOST`, routes the sign-in paths on the web host to
  the API and serves the MCP host from the API; the web image renders `TRESSO_AUTH_URL` as `authUrl` in
  `/config.js`. Provider callbacks (`/connect/...`), signed content URLs and the Stripe webhook stay on the API host.
  The API takes the host from the `Host` header the proxy passes on unchanged.

### Organizations

Every user owns a personal organization from the moment the account exists; teams (planned, 3.9) will be organizations
with more members. A subscription belongs to an organization and its members are the seats it pays for, so one user with
several mail accounts pays once. `GET /api/v1/organizations` lists the signed-in user's organizations, their own
personal one first, with their role (`owner`, `admin` or `member`) and the number of seats. A personal organization goes
by its owner's name and is removed together with them.

## 2. System overview

```
 ┌──────────── Clients ─────────────┐
 │ Web (Vue 3)  Desktop (Tauri+Vue) │
 │ Mobile (Expo / React Native)     │
 └──────────────┬───────────────────┘
                │ OAuth2 (auth code + PKCE)
                ▼
 ┌─────────────────────────────────────────────────────────────┐
 │ API: Symfony 8 on FrankenPHP (worker mode)                  │
 │  - OAuth2 authorization server (league/oauth2-server)       │
 │  - Domain: accounts, mail metadata, categories, todos,      │
 │    calendars, signatures, settings                          │
 │  - Delta sync endpoint for clients                          │
 │  - Mercure hub (built into FrankenPHP) for realtime         │
 └───────┬──────────────────────┬───────────────────┬──────────┘
         │ Messenger (Redis)    │ Postgres          │ S3 (RustFS locally)
         ▼                      ▼                   ▼
 ┌──────────────────┐   ┌──────────────┐   ┌──────────────────┐
 │ Messenger workers│   │ PostgreSQL   │   │ Raw MIME, bodies,│
 │ classify, scan,  │   │ metadata     │   │ attachments      │
 │ push, index,     │   └──────────────┘   └──────────────────┘
 │ daily brief      │   ┌──────────────┐   ┌──────────────────┐
 └──────────────────┘   │ Meilisearch  │   │ ClamAV (clamd)   │
                        └──────────────┘   └──────────────────┘
         ▲
         │ HTTPS, OAuth2 client_credentials (scope sync:*)
 ┌───────┴─────────────────────────────────────────────────────┐
 │ Sync workers: Go                                            │
 │  - Lease mail accounts from the API, hold IMAP IDLE /       │
 │    Gmail push / Microsoft Graph subscriptions               │
 │  - Upload raw MIME straight to S3, send parsed metadata     │
 │    to the API in batches (ingest endpoint)                  │
 │  - Execute outgoing actions (flags, moves, send via SMTP)   │
 └─────────────────────────────────────────────────────────────┘
```

## 3. Components

### 3.1 API (`apps/api`)

- Symfony 8.1, PHP 8.5, FrankenPHP worker mode, Doctrine ORM, PostgreSQL 18.
- Symfony Messenger with Redis transport for async jobs. Transports are split so slow jobs never block others:
  `async` (outgoing mail), `search` (indexing) and `scan` (attachment scans), and more where a feature needs its own.
- Mercure (bundled in FrankenPHP) pushes realtime updates to web and desktop clients.
- Identifiers: UUIDv7 everywhere (time ordered, index friendly, safe to expose).

### 3.2 Authentication and authorization

Symfony is the single OAuth2 authorization server (`league/oauth2-server-bundle`).

| Client | Grant | Notes |
|---|---|---|
| Web, Desktop, Mobile | Authorization code + PKCE | Public clients, refresh token rotation |
| Go sync workers | Client credentials | Confidential client, scopes `sync:lease sync:ingest sync:credentials` |
| Scripts and tools of a user | Personal access token | `tresso_pat_...` sent as a Bearer token, see below |
| Third-party apps and MCP clients | Authorization code + PKCE (S256) | Register themselves, consent screen, see below |

Only first-party clients are approved automatically; every other app goes through the consent screen.

- **Refresh tokens rotate.** Every refresh revokes the old refresh token and its access token and issues a new pair.
  For 30 seconds after that (`RefreshTokenRotation`, OAuth 2.0 Security BCP 4.14.2), a lost response does not end the
  sign-in: the same public client presenting the old refresh token with the same scope gets the very response already
  issued for it (the same new pair, `expires_in` counted from now), and the old access token keeps working, so
  requests already sent with it do not fail. Both only while the new refresh token is live: once it is used or
  revoked, the old ones are dead at once, and after the 30 seconds the old refresh token gets `invalid_grant` as
  before. The issued response waits in Redis (`cache.oauth_rotation`), encrypted with `OAUTH_ENCRYPTION_KEY`. This
  covers a retry after the first response went out, not two requests at the very same moment: one that arrives while
  the first is still running gets `invalid_grant` (or a second pair) as without the grace, so clients refresh one at
  a time.
- **Revocation.** `POST /oauth/revoke` (RFC 7009, form encoded: `token`, optional `token_type_hint`, `client_id`) is
  for public clients and open to browsers like the token endpoint. A refresh token takes the access token issued with
  it along, an access token its refresh token, and a refresh token that rotated moments ago what it rotated into, so
  signing out with a token whose refresh response never arrived still ends everything. Only tokens of the client that
  asks are revoked, and only for clients without a secret. The answer is always 200 with an empty body, whatever the
  token is (unknown, expired, another client's); only a request without `token` or `client_id` gets 400
  `invalid_request`. The authorization server metadata names it as `revocation_endpoint`. Our apps call it when the
  user signs out, before they forget the tokens; the web app then also ends the browser sign-in (see The sign-in
  session below).
- **Clean-up.** A nightly job (`PurgeExpiredOAuthTokens`, 03:53) deletes expired refresh tokens, then expired access
  tokens that no remaining refresh token was issued with (disconnecting an app finds its refresh tokens through
  them), and expired authorization codes.

The web client and the desktop app keep a sign-in until the server refuses it, by these rules; the phone follows the
same rules as of this release (the mobile app in section 3.10). They refresh the access token before it expires,
one refresh at a time (refresh tokens rotate, so a second refresh with the same token would be refused), and only an
`invalid_grant`, `invalid_request`, `invalid_client` or `unauthorized_client` answer of the token endpoint
(`refreshRefusalEndsSession` in `packages/core`, the rule of every client), or a 401 from the API that a refresh and one retry do not cure, ends the session. A network error, a timeout (20 seconds for
the whole answer) or a 5xx keeps the tokens; the request fails with an error that says the next one tries again. When
the answer was lost (a network error or the timeout, not an error answer), the client asks once more after 2 seconds:
the server may have rotated the token already, and answers the old one with the same new pair for 30 seconds. A device
that sleeps longer than that between the lost answer and the retry, or a hidden tab whose timers the browser holds
back as long, is signed out at its next request; the client cannot prevent that. Signing out revokes the refresh token
at `POST /oauth/revoke` (RFC 7009) before the client forgets it, best effort (5 seconds): an unreachable server does not
keep the user signed in. After a sign-out (not after a session that expired) the device remembers it, and every
authorization request it starts until a sign-in completes carries `prompt=login` (also one opened again, and on the
web, where the sign-out form already ended the browser session: it costs nothing there and covers a sign-out whose
form could not be sent). The sign-in pages then ask for the password although they may still remember the browser.

Scopes: `mail:read`, `mail:write`, `mail:send`, `todos:read`, `todos:write`, `calendar:read`, `calendar:write`,
`settings:read`, `settings:write`, `signatures:read`, `signatures:write`, `chat:read`, `chat:send`. The scopes `teams:read`, `teams:write` and `webhooks:manage` are reserved for
the planned features in 3.9.

WhatsApp chats relayed to the server have their own scopes: `chat:read` (read chat accounts, chats, messages and
replies) and `chat:send` (queue a reply); no other scope implies them. `App\Security\ChatAccessVoter` is the one rule:
our own apps reach chats with the mail scope of the action (`mail:read` to read, `mail:send` to queue a reply,
`mail:write` to change or remove the chat account), and any other caller only with `chat:read` or `chat:send`, never to
change the account. Our own apps never ask for the chat scopes (`USER_SCOPES` in packages/core). An app that is not
ours gets them only by naming them when it registers, and the user allows them on a consent screen that lists them
apart from the others; a personal access token holds them only when the user ticks them (see both below). The two
are independent: `chat:send` alone queues a reply and reads nothing, not even the chat's name.

#### Personal access tokens

A user makes a personal access token under Settings, Access tokens for their own scripts and tools, and sends it as
`Authorization: Bearer tresso_pat_...` to the same API the apps use:

```bash
curl -H "Authorization: Bearer $TRESSO_TOKEN" https://tresso.example/api/v1/signatures
```

- **Secret.** `tresso_pat_` followed by 32 random bytes in base64url. The API returns it once, in the response to
  `POST /api/v1/personal-access-tokens`; it stores only its SHA-256 (`personal_access_token.token_hash`, unique) and
  the first characters (`prefix`, such as `tresso_pat_Xk3f9a`) so the user can tell tokens apart. The name is
  plaintext like other names users write themselves (3.16).
- **Scopes.** Chosen per token from the user scopes, without the reserved `teams:*` and `webhooks:manage`; never a
  `sync:*` scope. Anything else is refused with 422. The chat scopes `chat:read` and `chat:send` are offered too
  (WhatsApp in an MCP client of the user's own is the usual reason), off unless ticked, in a group of their own under
  "WhatsApp" in the web app's token form. A token gets no scope the
  session that makes it lacks; our apps hold no chat scope and reach chats through their mail scopes, so for
  `chat:read` and `chat:send` the session must pass `ChatAccessVoter` (`mail:read`, and `mail:send` to queue replies).
- **Lifetime.** 30, 90 (default) or 365 days, always with an end. Revoking sets `revoked_at`; revoked and expired
  tokens stay in the list for 30 days, after which a nightly job deletes them. Deleting the user deletes their tokens
  (foreign key cascade).
- **Signing in.** `PersonalAccessTokenAuthenticator` on the `api` firewall takes bearer tokens that start with
  `tresso_pat_`; every OAuth2 authenticator is wrapped so it leaves those alone, and still takes every other bearer
  token. A known, unrevoked and unexpired token signs in its owner with the roles of its scopes, exactly as an OAuth2
  access token with those scopes would (`ROLE_OAUTH2_<SCOPE>`), so `is_granted()` and `CurrentUser` work unchanged.
  The security token is an `OAuth2Token` whose client id is `personal-access-token`, which is no OAuth2 client, so
  it never counts as a first-party app or a sync worker. Anything else gets the same 401 as a rejected OAuth2 token.
  The last use (`last_used_at`) is written at most once a minute per token. The `mcp` firewall uses the same
  authenticator (see MCP endpoint below).
- **Not for realtime.** `GET /api/v1/realtime/token` refuses personal access tokens (403): a Mercure subscriber token
  lives an hour and would outlast revoking the token, and scripts and MCP clients fetch the delta instead. Personal
  access tokens never reach `/internal/` either, since they cannot hold a `sync:*` scope.
- **Only in our own apps.** Whatever its scopes, a token cannot add or remove mail accounts, change how one connects,
  sign in with a mail provider, register a notification device or touch billing; see "Only in our own apps" under
  third-party apps below.
- **Managing tokens.** `GET` and `POST /api/v1/personal-access-tokens` and `DELETE
  /api/v1/personal-access-tokens/{id}` (revoke) need `settings:read` or `settings:write` and an access token of one of
  our own apps (web, desktop, mobile: the `FIRST_PARTY_CLIENT` check), so a personal access token or a
  third-party app can never make, see or revoke tokens. A token gets no scope the signed-in session lacks (422).
  Users only see their own tokens; another user's id is a 404. The list never contains a secret or a hash, and every
  response of these endpoints is sent with `Cache-Control: no-store, private` and `Pragma: no-cache`, like
  `/internal/`.

#### Third-party apps and MCP clients

Apps that are not ours, such as Claude, Claude Code, Cursor or the MCP Inspector, find this server, register
themselves and sign in with the user's consent. `App\Security\OAuth` holds the pieces; everything is addressed from
`API_PUBLIC_URL`, which is also the issuer, except the authorization endpoint (`AUTH_PUBLIC_URL`) and the MCP endpoint
(`MCP_PUBLIC_URL`, see Deployment).

- **Metadata.** `GET /.well-known/oauth-authorization-server` (RFC 8414): issuer, authorization, token,
  registration and revocation endpoints, `scopes_supported` (only what such an app may ask for: the user scopes without `teams:*`,
  `webhooks:manage` and `sync:*`, the same set as a personal access token, `chat:read` and `chat:send` included),
  response type `code`, grants
  `authorization_code` and `refresh_token`, PKCE `S256` and token endpoint authentication `none`. There is no
  `/.well-known/openid-configuration`: this server issues no ID tokens. `GET /.well-known/oauth-protected-resource`
  and `GET /.well-known/oauth-protected-resource/mcp` (RFC 9728) describe the API and the MCP endpoint
  (`<MCP_PUBLIC_URL>/mcp`) with this server as their authorization server. `ProtectedResources` gives the MCP
  resource, its metadata URL and the `WWW-Authenticate: Bearer resource_metadata="..."` value the MCP endpoint sends
  with a 401, each for the host the request came to: an MCP client checks that the metadata names the URL it
  connected to (RFC 9728 3.3), so on the API host, while `/mcp` still answers there, they name `<API_PUBLIC_URL>/mcp`. These documents, registering and the token endpoint answer CORS requests from any origin (without
  cookies), for clients that run in a browser, as does revocation; the API itself does not.
- **Registering.** `POST /oauth/register` (RFC 7591) is open to anyone, limited to 60 registrations per IPv4 address
  (also when it arrives IPv4-mapped, `::ffff:a.b.c.d`) or IPv6 /64 per hour, 200 per IPv4 /24 or IPv6 /48 and 5000 in
  total per hour (`symfony/rate-limiter`, in Redis; 429 with `Retry-After`). Only public clients: `token_endpoint_auth_method`
  `none` (or left out), grants `authorization_code` and optionally `refresh_token` (both when left out), response
  type `code`. `client_name` is required (at most 100 characters; after NFKC folding only Latin letters and characters
  every script shares; no control or formatting characters such as right-to-left overrides and no spaces but the
  ordinary one; nothing whose skeleton (look-alikes such as `€`, `°`, `ɵ` and `℮` merged) reads "tresso" inside a
  word, or across separators unless it starts at least three letters into a word, so `Tress0`, `Tr€sso`,
  `𝐓𝐫𝐞𝐬𝐬𝐨`, `T r e s s o` and `MyTres so` are refused while `Fortress Office` and `Mattress Sort` are not) and is what the consent screen calls the app. `redirect_uris` is required, at most 10, plain ASCII: `https://` on a host of ASCII letters, digits,
  hyphens and dots (internationalized names as punycode), `http://` only on `127.0.0.1`, `[::1]` or `localhost`, or
  an app's own scheme in reverse-domain form (`com.example.app:/cb`). Never a fragment, a wildcard, credentials, a
  backslash or percent sign in the host, a one-word scheme (`smb:`, `ms-msdt:`, `cursor:`), a scheme of the operating
  system (`com.apple.*`, `x-apple.*`, `com.microsoft.*`, `microsoft.*`, `ms-*`, `com.google.*`, `android*`,
  `windows*`), a Tresso host (`tresso.app`, `gettresso.com`, this server's own hosts), or any host or scheme with a
  label whose skeleton without hyphens has "tresso" in it (`login-tresso.app`, `gettresso.co`, `tress0.com`,
  `tres-so.app`, `app.tresso.mobile:`). The authorization request must use one of the
  registered URIs exactly, except that the port may differ on `127.0.0.1` and `[::1]` (RFC 8252 7.3); `localhost` is
  matched with its port. `scope`
  (optional) may only hold allowed scopes; left out, the app may ask for every allowed scope except `chat:read` and
  `chat:send` (`Scope::thirdPartyDefaultScopes()`), so an app made for mail never ends up asking for WhatsApp: an
  app gets the chat scopes only by naming them here. A client stored without scopes gets the same set. `client_uri`, `logo_uri` and other
  metadata are ignored. Refusals are RFC 7591 errors (`invalid_redirect_uri`, `invalid_client_metadata`). The
  client is an `oauth2_client` row without a secret and without plain PKCE, marked by a `registered_client` row with
  `created_at` and `last_used_at` (the last token issued to it). A nightly job deletes registered clients that got no
  token within 30 days and that no user allowed, with everything that cascades from them; our own clients have no
  `registered_client` row and are never touched.
- **Consent screen.** On `/oauth/authorize`, after signing in, a request from an app that is not ours must ask only
  for allowed scopes that the client registered (else `invalid_scope`) and, with a `resource` parameter (RFC 8707),
  name the API or the MCP endpoint, under either of its addresses while both answer (else `invalid_target`); PKCE `S256` is required by the bundle. Such errors only go
  back to the app's redirect URI once the user allowed the app; before that the user sees them on a page of ours and
  the browser goes nowhere, so the endpoint is no open redirect (RFC 9700 4.11.2). That page explains each error in
  fixed words of ours and never repeats text from the request. When
  the user already allowed every scope asked for, the request is approved at once, but only for an app on the web
  (an https redirect URI): for an app on the user's own computer (a loopback or an app's own scheme) nothing proves
  which program asks, since any program there can use a public client id and listen on that port or claim that scheme
  (RFC 8252 8.6), so the page is shown every time and says the user allowed the app before. Otherwise the page shows the app's
  name, the host it sends the user back to (the part that is checked), each scope in plain words, the signed-in
  account and a warning that Tresso has not checked the app. The chat scopes are listed apart, inside the form under
  "WhatsApp" ("Read your WhatsApp chats", "Send WhatsApp messages as you"), with a line that this is separate from
  mail and reaches messages other people sent, each as a box (`chat_scopes[]`) that is never ticked beforehand, not
  even for an app allowed them before; the page needs no JavaScript. Allow and Deny post back to the same URL with a CSRF
  token; Deny sends `access_denied`. Allow grants the other scopes asked for and the ticked chat scopes, and takes back
  the chat scopes asked for and left unticked (`OAuthConsent::withdraw()`, in the same locked transaction); when that
  takes back one the app held, its access tokens for the user end at once (`TokenRevocation::revokeAccessTokensOf()`),
  while its refresh tokens stay for what is still allowed. Nothing to grant at all (only chat scopes asked, none
  ticked) is `access_denied`. The bundle cannot narrow an authorization code, so the narrowing happens when a token is
  issued: `TokensNeedConsent` (on `SCOPE_RESOLVE`, which league's `finalizeScopes()` dispatches for both the code
  exchange and a refresh) refuses with `invalid_grant` when the consent does not cover the other scopes, leaves out the
  chat scopes the consent does not hold, and refuses a token left with no scope. The token response always carries
  `scope` (`ScopedBearerTokenResponse`, the bundle's `response_type_class`), so a client learns it got less than it
  asked for (RFC 6749 5.1). A consent for mail never covers the chat scopes, and a refresh token cannot widen to them. The page cannot be framed and is not cached. Allowing stores an `oauth_consent`
  row (user, client, scopes, `created_at`, `last_used_at`); asking for more later shows the page again and adds the
  new scopes. Two answers at once keep one row with every scope. Tokens are not bound to a resource: the API and the
  MCP endpoint are one resource server. Access tokens live an hour, refresh tokens 30 days and rotate. Every token
  for such an app, also for an old authorization code or refresh token, needs a consent that covers its scopes at that
  moment (`invalid_grant` otherwise), so nothing slips past a disconnect.
- **Only in our own apps.** With any scope, an app that is not ours and a personal access token cannot (403, the
  `FIRST_PARTY_CLIENT` check): manage personal access tokens or connected apps; add or remove mail accounts, look up
  their server settings, or change how one connects (servers, ports, username, password, calendar server); sign in
  with Google or Microsoft; register a device for notifications; see or change billing; get a realtime token; or
  reach `/internal/`. Plain settings stay open with `settings:write`: account names and pausing, smart inboxes,
  batches, the brief, rules, notification and calendar preferences, signatures. Organizations can only be read.
  Whoever changes it, a new IMAP or SMTP host, username or calendar server host needs the password again (422 on
  `password`): the saved password is never sent to another server.
- **Invitations are mail.** Creating, changing or deleting an event with guests, answering an invitation, and applying
  calendar mail from a message tell other people by mail (our iTIP mail or the provider's), so they need `mail:send`
  as well as `calendar:write` (403 otherwise, and the change is rolled back; our own apps have every scope). The
  event editor decides this from the mail that would actually go out for the whole calendar object, so a guest on one
  occurrence counts when the series is changed or deleted; for a provider that schedules, any guest in the old or new
  object counts. A client that means to tell nobody
  passes `notify=false` (or `notify: false` on an answer); the request is never quietly changed into that.
- **Connected apps.** `GET /api/v1/connected-apps` and `DELETE /api/v1/connected-apps/{id}` (`settings:read` /
  `settings:write` and our own apps only) list and disconnect the user's apps: name, domain, scopes, since and last
  use (the last token issued for the user, so to within an hour); `domains` lists every place the app may send the user
  back to. Another user's id is a 404. Disconnecting deletes
  the consent and revokes the app's access tokens, refresh tokens and authorization codes for that user in one
  transaction. The web app has this under Settings, Connected apps. Deleting a user deletes their consents (foreign
  key cascade) with their tokens.

#### MCP endpoint

`<MCP_PUBLIC_URL>/mcp` (and `<API_PUBLIC_URL>/mcp` while `MCP_ON_API_HOST` is on; one address when the endpoint has
no host of its own, see Deployment) is an MCP server (Streamable HTTP, `symfony/mcp-bundle` with the official PHP SDK, `mcp/sdk`)
for Claude, Claude Code and other MCP clients. Its tools change the user's settings and read and answer WhatsApp chats
the server holds; tools for mail, todos and events come later. The code is in `App\Mcp`.

- **Signing in.** The firewall `mcp` takes the same tokens as the API: OAuth2 access tokens (an app the user allowed
  on the consent screen, or one of our own apps) and personal access tokens. A request without a token, or with one
  that is unknown, revoked or expired, gets a 401 with `WWW-Authenticate: Bearer
  resource_metadata="<MCP_PUBLIC_URL>/.well-known/oauth-protected-resource/mcp"` (on the API host the API address)
  (and `error="invalid_token"` when a
  token was refused), and `scope="..."` naming the scopes to ask for (RFC 6750 3; the MCP authorization spec has a
  client prefer it over `scopes_supported`): every scope an app may have except `chat:read` and `chat:send`, so a
  client that follows the challenge does not ask for WhatsApp unless it means to. From there a client finds this authorization server, registers and signs in by itself. A sync
  worker's token has no user and gets a 403 (`MCP_USER`).
- **Transport.** POST for messages, DELETE to end a session; GET (a server stream) answers 405, since the server sends
  nothing unasked. Sessions live in Redis (`cache.mcp_sessions`) for an hour after their last request and belong to
  the user and app (or personal access token) that started them: another connection that names one gets a 404, and
  so does a session id written other than as the RFC 9562 text the server hands out (base58, base32). Both
  protocol eras of the SDK are served on the one endpoint. The Host header must be the MCP endpoint's host, or the API
  host while `/mcp` answers there (`McpHosts`), and an Origin header must be the request's own origin; dev and test
  also accept `localhost`, `127.0.0.1` and `[::1]` (DNS rebinding,
  403 otherwise). There is no CORS on `/mcp`: hosted clients call it from their servers and the MCP Inspector through
  its proxy.
- **Tools.** Each tool runs the API operations it stands for as sub-requests of the MCP request (`App\Mcp\Api`),
  addressed to `API_PUBLIC_URL` whatever host the MCP request came to, so URLs the API makes inside a tool point at
  the API:
  the same token, so the same scopes, voters, first-party checks, validation and messages as the REST call, and no
  tool can do what the API would not do with that token. The payment wall of a server that bills
  (`App\Billing\PaymentWall`) is asked for every such sub-request too, so a user past the trial gets the 402 message
  as a tool error wherever REST answers 402. A refusal comes back as a tool error (`isError`) in the
  API's words, with each refused field; the answer is the API's JSON as text and as structured content (lists under
  `items`). Input schemas are written per tool, refuse fields they do not name and carry the MCP annotations
  (`readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint`, true only for `send_whatsapp_message`,
  the one tool that reaches other people). `tools/list` shows only the tools whose scopes the token
  holds; calling another one is a tool error that names the missing scope. A resource, `tresso://scopes`, lists the
  scopes and the tools each one unlocks. Tools come from `App\Mcp\Tool\ToolProvider` services, one per part of the
  API; more tools are another provider.

| Scope | Tools |
|---|---|
| none | `get_me` (who, which scopes, and with `settings:read` the mail accounts), `get_server_info` |
| `signatures:read` | `list_signatures`, `get_signature` |
| `signatures:write` | `create_signature`, `update_signature`, `delete_signature`; with `signatures:read` and `settings:read`: `set_default_signature` (reads the mail account, so an unknown or another user's account is not found, then sets or clears its default through the signature's `defaultFor`) |
| `settings:read` | `list_mail_accounts`, `get_mail_account` (without how the account connects), `list_smart_inboxes`, `get_smart_inbox`, `list_sender_rules`, `get_notification_settings`, `list_notification_devices`, `get_batch_delivery`, `get_daily_brief_settings`, `list_reminder_rules`, `get_reminder_rule`, `get_scheduling_preferences` |
| `settings:write` | `update_mail_account` (name, pause and resume), `create_smart_inbox`, `update_smart_inbox`, `delete_smart_inbox`, `delete_sender_rule`, `update_notification_settings`, `update_notification_device` (name, on or off), `delete_notification_device`, `create_reminder_rule`, `delete_reminder_rule`, `update_scheduling_preferences`; with `settings:read` (they change part of what the API saves whole, or of a list): `add_smart_inbox_senders`, `remove_smart_inbox_senders`, `update_batch_delivery`, `update_daily_brief_settings`, `update_reminder_rule` |
| `mail:read` | `get_smart_inbox_senders` (who sends the mail in a smart inbox) |
| `calendar:read` | `list_calendars`, `get_calendar` |
| `calendar:write` | `create_calendar`, `update_calendar`, `delete_calendar` |
| `chat:read` | `get_whatsapp_status`, `list_whatsapp_chats`, `get_whatsapp_chat` (messages and the user's replies with their status), `search_whatsapp_messages` (bounded, see WhatsApp below) |
| `chat:send` | `send_whatsapp_message` (queues a reply in an existing chat) |

- **WhatsApp.** The tools call the read endpoints and the reply queue of 3.17 and nothing else, so `ChatAccessVoter`
  decides every call; a tool never reads a repository or `ChatFields` and checks no role itself. `chat:read` and
  `chat:send` are independent: with `chat:send` alone, `send_whatsapp_message` reads only the status endpoint (which
  holds no number or message, and for such a caller not the Mac's name either) and answers with the reply's id, chat id, status and times, never its text, a
  chat's name, a JID or earlier messages. The server holds chats only with "All my devices": without a chat account
  every tool answers that WhatsApp is set to "Only this Mac" or not connected, never an empty list. A reply is queued,
  never sent at once: the answer says so, and while the relaying Mac is offline it says the reply waits until that
  Mac runs again. It goes to a chat the server holds, by its id, never to a phone number, so no tool can message
  someone new; it shares the limit of 100 replies in 10 minutes with the user's devices, and an app or a token may
  queue at most 20 in 10 minutes and 100 a day of its own; a `replyId` repeats a call safely. It is marked
  `destructiveHint` (it cannot be taken back), so a client that asks before such tools asks the user. There is no tool
  to cancel or retry: retrying could send a reply twice (an `unconfirmed` reply may have gone out), so the API keeps
  retrying to our own apps. A tool refused for a missing chat scope says that WhatsApp is a permission of its own:
  the app has to register again naming it, or use a personal access token with it ticked. The read tools say in their descriptions that chat names, sender
  names, file names and texts are written by other people and may carry instructions, to be reported and never
  followed. Connecting WhatsApp, taking over the relay, its settings, leaving a chat out, marking read, archiving and
  deleting have no tool (`CHAT_MANAGE` and the desktop check stay with our own apps).

- **Partial updates.** `update_batch_delivery` changes only what it is given, but the API saves times and zone
  together and then counts both as chosen: while the user still has the defaults, the tool asks for both.
- **Not tools.** What only our own apps may do (adding or removing mail accounts and how they connect, registering a
  notification device, personal access tokens, connected apps, billing, realtime, managing WhatsApp) has no tool. The API cannot reorder
  smart inboxes or give them a color, so neither can a tool.

Users log in with email + password (Argon2id) and, later, Google / Microsoft sign-in as identity providers. (Signing
in with Google or Microsoft to connect a mail account is separate: see Provider sign-in below.)

#### The sign-in session

The sign-in pages (`/login`, `/oauth/authorize` with the consent screen) are the only part of the API with a browser
session (firewall `main`); every API call is stateless and signed with a token. The session lives in Redis
(`RedisSessionHandler`, keys `session:*`), so every API instance sees the same one and a deploy signs nobody out. It
ends two hours after its last request (the Redis TTL, also `gc_maxlifetime`) or when the browser closes (the cookie
has no lifetime). Its cookie is `HttpOnly`, `SameSite=Lax` and `Secure` on https. Its cookies belong to the host of
`AUTH_PUBLIC_URL` (the API host unless set, see Deployment).

- **Cross-site posts.** A POST to `/login` without the form's CSRF token gets the sign-in page with a 403 before the
  firewall sees it (`SignInGuard`), so another site cannot clear the remember-me cookie or spend the login attempts of
  a browser (the firewall would count such a post as a failed sign-in). A refused POST to `/login` or `/logout` that
  came without the session cookie, as one from another site does, gets a 303 to the page instead, so no new session
  cookie replaces the browser's.
- **Password guessing.** Five wrong passwords for one address from one IP address, or 25 from one IP address, lock
  the form for 15 minutes (Symfony's `login_throttling`, in Redis through `cache.rate_limiter_shared`, so the limit
  holds across API instances); the page then says to try again later, and even the right password waits.
- **Keep me signed in.** The sign-in form has this checkbox, ticked by default. It sets Symfony's remember-me cookie
  (`REMEMBERME`, `HttpOnly`, `SameSite=Lax`, `Secure` on https) for 30 days, as long as a refresh token lives, so a new
  tab, a restarted browser or an app that signs in again passes `/oauth/authorize` without the password. The cookie is
  signed with `APP_SECRET` and the user's password hash: a new password ends it everywhere. Unticked, the sign-in ends
  with the session.
- **Signing out.** `POST /logout` ends the session and clears the remember-me cookie, then sends the browser to
  `WEB_APP_URL`. It only counts when it comes from Tresso: with the CSRF token of the sign-out page (always enough,
  also behind a proxy that does not pass the scheme), or with an `Origin` of the sign-in host itself or of
  `WEB_APP_URL` (the web app signs out by submitting a form, `POST`, to `<AUTH_PUBLIC_URL>/logout`, the address it gets
  as `authUrl` from `/config.js`, after revoking its tokens). When the web app and the sign-in host are on different
  sites (not Tresso Cloud's or the default layout), the browser sends no `SameSite=Lax` cookie with that form, so the
  POST clears the remember-me cookie but cannot end the session, which then lasts until its two idle hours pass. Anything else gets the sign-out page with a 403 and changes nothing, so another site cannot
  sign people out (`App\Security\SignOutGuard`, before the firewall). `GET /logout` never signs out: it shows that page
  with a Sign out button, or goes straight back to `WEB_APP_URL` when the browser has no session and no remember-me
  cookie. The sign-in and sign-out pages, like the consent screen, cannot be framed and are not cached.
- **Asking for the password again (`prompt=login`).** Our apps are approved without a page while the browser is signed
  in, and the desktop and mobile apps cannot end the system browser's sign-in when the user signs out of them. So
  after a sign-out the user asked for, our apps (web, desktop and mobile) add `prompt=login` (parameter `prompt`,
  value `login`, as in OpenID Connect) to every authorization request until a sign-in completes; a sign-in that
  follows a failed refresh or an expired token, without a sign-out, does not send it. The web app also ends the
  browser's sign-in itself (`POST /logout`) and sends `prompt=login` as well, in case that form did not reach the
  server.
  The server then shows the sign-in form; signing in there replaces the browser's sign-in (a new session id, the old
  remember-me cookie cancelled), and whoever signs in, the same user or another (that is how someone switches
  account), gets the code for that request, which goes on once without asking again (`PromptLogin`: the form's
  sign-in marks that one request, by a hash of its query, in the session). A mark is never a parameter, so adding one
  skips nothing. Nothing ends before someone signs in on the form, so a link with `prompt=login` on another site signs
  nobody out. `prompt=login` is a request by the app, not a lock: only the authorization request that carries it waits
  for the password; the browser stays signed in for every other request (the web app's included) until someone
  answers such a request or signs out with `POST /logout`. It cannot stop a person at that browser from repeating
  the same request without `prompt=login`: the server cannot tell, so it is protection against an unintended
  silent sign-in, not against someone at the keyboard. The consent page's POST back to the same address is not
  asked again, since it comes after that sign-in. Any app may send it; the metadata lists
  `prompt_values_supported: ["login"]`. `prompt` may be a space separated list; other values are ignored.

### 3.3 Mail account credentials

- OAuth (Gmail, Microsoft 365) wherever possible; IMAP/SMTP passwords as fallback.
- Envelope encryption with XChaCha20-Poly1305 (libsodium), with the per-user keys of "3.16 Encryption at rest":
  - Credentials and provider tokens are sealed with the owner's field key as `f1.<key version>.<base64(nonce +
    ciphertext)>`, with the account (or grant) id as additional data, so a ciphertext copied to another user or
    account does not decrypt. `v1.<base64>` values from before user keys still open with key version 1.
  - Master keys come from the environment: `DATA_KEYS` (`id:base64`, comma separated) and `DATA_KEY_CURRENT`.
    Rotation of master keys and user keys is described in 3.16.
- The API never returns credentials. Sync workers fetch them over TLS from
  `GET /internal/sync/accounts/{id}/credentials?workerId=...` (scope `sync:credentials`), only for accounts they hold
  an unexpired lease on (anything else is a 404), with `Cache-Control: no-store`. Workers keep them in memory only.
- Mail servers are user input, so they are checked against server-side request forgery: the host must resolve only
  to public addresses (no private, loopback, link-local, carrier-grade NAT or IPv4-mapped ranges) and the connection
  must use TLS or STARTTLS. `MAIL_ALLOW_UNSAFE_SERVERS=1` lifts this for local test servers only. The sync workers
  repeat the address check when they connect, which also covers DNS changes after validation.
- `GET /api/v1/mail-server-settings?emailAddress=` suggests IMAP and SMTP settings the way Thunderbird finds them:
  the provider's own autoconfig (`autoconfig.<domain>`, then `<domain>/.well-known/autoconfig`), Mozilla's ISPDB
  by domain, then ISPDB by the parent domains of the preferred mail exchanger (which finds company domains hosted
  by a large provider). The first three are requested together. These requests go to domains users type in, so
  they run through a client that refuses private networks, with short timeouts and a 64 KB limit. Only encrypted
  servers are suggested. Answers are cached per domain in Redis: a day when found, an hour when not. Because the
  cache is per domain (key prefix `autoconfig2.`, so entries cached before this rule are not read), the address itself is never sent to the domain's autoconfig, and a suggested username that is
  some other address is replaced by the one asked for. The answer also names the large provider behind the address
  (`provider`: `google`, `outlook`, `m365`, `icloud`, `yahoo` or null), from the domain (gmail.com, outlook.com,
  icloud.com, yahoo.*, ...) or else from the preferred mail exchanger (`*.google.com`, `*.mail.protection.outlook.com`
  for Microsoft 365, `*.olc.protection.outlook.com` for Outlook.com, `*.yahoodns.net`, `*.icloud.com`), so the client
  offers the easiest way to connect: the provider's sign-in page or an app password.
- `POST /api/v1/mail-account-checks` (scope `settings:write`, our own apps only) checks an IMAP/SMTP account before it
  is created, with the body of a new account minus the name: it signs in to the IMAP server and lists the folders,
  then signs in to the SMTP server (EHLO, STARTTLS where asked for, AUTH PLAIN or LOGIN, nothing sent), each within
  15 seconds, and answers `{imap, smtp, folders, detail}` with `ok`, `auth_failed`, `unreachable`, `certificate`,
  `blocked`, `failed` or `not_checked` (SMTP when IMAP failed). It connects by the sync workers' rules: every address
  of the host must be public, the connection goes to one of the addresses that were checked, and TLS is verified for
  the host name. Nothing is stored; the web client creates the account only once a check passed, so a wrong password
  or server never leaves a broken account behind. At most 20 checks per user in 10 minutes (429) and one at a time (a
  PostgreSQL session advisory lock on the user, taken before a token is counted; a second check answers 409 and the
  client retries it, since a check the client gave up still runs to its deadline: PHP notices a client that left only
  when it writes output; a transaction pooler such as pgbouncer in transaction mode would break these locks), both servers together within 25 seconds; every wait is a `stream_select`
  against that deadline, so a server that answers a byte at a time cannot hold the request longer. A refused LOGIN
  is `auth_failed` only for `NO` without a response code or with AUTHENTICATIONFAILED, AUTHORIZATIONFAILED or
  EXPIRED (the workers' rule); UNAVAILABLE, PRIVACYREQUIRED, BAD and the like, and SMTP 454, are `failed`. An SMTP
  server that asks for no sign-in passes without the credentials being tried. What the answer tells (refused versus
  no answer, up to 200 characters of a server's reply) makes the endpoint a slow port and banner probe of public
  addresses from the API's own address; with public addresses only and the limits above that is accepted.
- Changing the password, username or a server of an account that a worker holds ends its lease and keeps it from
  every worker for one lease period (90 seconds); an account no worker holds (a refused login is not leased) stays
  free and is claimed at the next heartbeat. For a held account: the worker that held it no longer gets it back at its next heartbeat (every 30 seconds by
  default), stops that account's syncer, and its calls for the account answer 404 from then on. Once the hold ends the
  next heartbeat of any worker claims it and starts a fresh session with the new settings, its failure count and
  backoff from zero, so a problem that continues is reported again after three failed sessions. The new settings are
  tried within about two minutes instead of after a backoff of up to five. The hold is written with PHP's clock and
  compared with the database's, so it is only exact where both run in UTC (see MAIL-12). An account in `auth_failed` or `error` is
  set `active` at the same time, since the old failure says nothing about the new settings.

#### Provider sign-in (Gmail, Microsoft 365)

Gmail and Microsoft 365 accounts connect through the provider's OAuth 2.0 authorization code flow with PKCE (S256),
as a confidential client (the API holds the client secret). The layer is generic: one **provider grant** per
signed-in provider account, shared by every feature that uses it: mail, and the calendar (Google Calendar and
Microsoft Graph calendars, with Meet and Teams meetings), which adds its scopes to the same grant.

- **Start:** `POST /api/v1/provider-authorizations` (scope `settings:write`) with `{"provider": "google" | "microsoft",
  "features": ["mail", "calendar"], "mailAccountId": <optional, to sign in again or allow more>, "emailAddress":
  <optional, the address typed for a new account>, "returnTo": "web" | "native"}`. The address (or the account's,
  when signing in again) goes to the provider as `login_hint`, so its page starts with that account. `returnTo` (default `web`) says which app gets the provider's answer; the URL behind each is the server's
  own (`WEB_APP_URL`, `NATIVE_REDIRECT_URI`), so a client cannot send the answer anywhere else. The desktop app asks
  for `native`: it opens the provider in the system browser, as its own sign-in does, because sending its window there
  ended on the web app, another origin without the desktop app's tokens, and the user looked signed out. Calendars alone
  are only asked for an existing account (`mailAccountId`). The web client asks for calendars along with the mail by
  default ("Also sync my calendars" on the sign-in step, on unless the user turns it off; "Allow calendar access"
  later). Calendars left unticked never cost the mail (the account connects and its calendar status says
  `not_granted`); a Microsoft tenant that refuses the whole sign-in because of the calendars answers `denied` or
  `admin_approval_required` with `requested` naming the calendars, and the client then offers to connect mail only.
  Signing in again asks for mail and the API adds what the grant allows already. The API stores a pending request (the
  SHA-256 of a random 256-bit `state`, the PKCE verifier, the user, the requested scopes; 15 minutes, single use) and
  answers the provider's `authorizationUrl`. `GET /api/v1/oauth-providers` lists the providers this server has an
  OAuth app for.
- **Callback:** the provider redirects the browser to `<API_PUBLIC_URL>/connect/<provider>/callback`. That route is
  public and only passes the answer on: it redirects to the web app (`/settings/accounts/new`, or `/settings/accounts`
  when signing in again) with `provider`, `state` and the provider's `code` or `error` (with `error_description`,
  at most 500 characters, where Microsoft says why), or straight away with
  `connectError=expired` for a state that expired or that it does not know (an unknown one always to the web app).
  For `returnTo: native` the same query goes to `NATIVE_REDIRECT_URI` (`tresso://auth/callback`) with that page in
  `next`; the desktop app opens only those two pages from such a link. It does not depend on the API's browser session (the one used
  to sign in for `/oauth/authorize`): that session can end long before the web app's sign-in (two idle hours, a closed
  browser, a sign-out on the sign-in pages), and requiring it sent users from the provider to Tresso's sign-in page as
  if they had been signed out.
- **Finish:** the web app (or the desktop app, from the link) takes the answer out of its address bar and posts it to `POST /api/v1/provider-connections`
  (scope `settings:write`, our own apps only) with its access token. That token must belong to the user who started:
  a sign-in link someone else started cannot attach your provider account to their Tresso account. The state works
  once, whatever the outcome. The API redeems the code with the verifier, reads who
  signed in (Google: the ID token's `sub` and verified `email`; Microsoft: the ID token's `tid` and `oid`, and the
  mailbox address from Graph `/me`), checks that the mail scopes were granted (users can untick them; calendars left
  unticked are allowed later, and only the calendar status says so),
  creates or updates the grant and creates the mail account (or signs an existing one in again), and answers
  `{provider, connected: <account id>, grant: <grant id, when only calendars were allowed>, connectError: <code>,
  requested: <features asked for>, missing: <features asked for and not allowed>, existing: <a new sign-in found the
  account connected already>, approvalUrl}` (codes: `denied`, `admin_approval_required`, `expired`, `different_user`,
  `scopes_missing`, `wrong_account`, `already_connected`, `unverified_address`, `no_mailbox`, `failed`). Calendars
  asked for and left unticked set the account's calendar status to `not_granted` right away; calendars allowed put
  every calendar status except `active` back to `unknown` (a refused list, a refused token and a missing permission
  alike), so the worker looks at them again at its next heartbeat. Microsoft's
  `consent_required`, or an `error_description` with AADSTS90094, AADSTS65001 or AADSTS900941, means the user's
  organization only allows apps an administrator approved: the answer is `admin_approval_required` with
  `approvalUrl`, Microsoft's admin consent page for the organization of the typed address (or this installation's
  tenant). An administrator who approves comes back through the callback with `admin_consent=True`, which leads to
  `/settings/accounts/new?provider=microsoft&adminConsent=granted`. ID tokens come straight from the token endpoint
  over TLS, so their claims are used without a signature check (OpenID Connect Core 3.1.3.7); the audience is checked.
- **Grants** (`provider_grant`): owner, provider, the provider's stable account id, the scopes the provider confirmed
  (Microsoft's normalized to lowercase without the `https://graph.microsoft.com/` prefix) and the tokens, sealed with
  the owner's DEK like passwords (additional data: the grant id). Mail accounts link to their grant; removing the
  last account of a grant deletes it and revokes the refresh token at Google (Microsoft has no revocation endpoint for
  this).
- **Access tokens for workers:** the credentials endpoint answers `{"type": "oauth2", "accessToken", "expiresAt"}`
  for these accounts. The API refreshes the access token when it has less than 5 minutes left, under a row lock on the
  grant (Microsoft replaces the refresh token on every refresh; two concurrent refreshes would lose one). A worker
  whose token the provider refused asks again with `rejected=1` and gets a new one (unless it was issued in the last
  minute). Workers never see refresh tokens. `invalid_grant` marks the grant revoked and its accounts `auth_failed`
  ("Sign in with Google again") and answers 409; a provider outage answers 503 with `Retry-After`. The calendar
  syncer asks with `feature=calendar`: a grant without the calendar scopes answers 403 and sets the account's
  calendar status to `not_granted` (with how to allow it), and leaves mail alone.
- **Scopes now:** Google `openid email profile https://www.googleapis.com/auth/gmail.modify` with
  `access_type=offline`, `prompt=consent` and `include_granted_scopes=true`. Microsoft `openid email profile
  offline_access Mail.ReadWrite Mail.Send User.Read` (Graph). `gmail.modify` reads, labels, deletes and sends mail;
  it is a restricted scope, so a public Google app needs Google's verification and a security assessment.
- **Calendar scopes:** Google `https://www.googleapis.com/auth/calendar.events` (events, Meet meetings included) and
  `https://www.googleapis.com/auth/calendar.calendarlist.readonly` (the calendar list), nothing broader. Microsoft
  `Calendars.ReadWrite`; Teams meetings are made through an event's `isOnlineMeeting`, which needs no
  `OnlineMeetings` permission (and so also works where admins restrict that permission).
- **Incremental consent:** each feature is a `ProviderFeature` case with its scopes in `ProviderScopes`. A sign-in
  for an account that has a grant asks for the scopes of every feature the grant covers plus the new ones, Google
  keeps earlier scopes through `include_granted_scopes`, and the grant stores the union for Microsoft. Callers ask
  `ProviderAccessTokens::accessToken($grant, $feature)`. A grant without the mail scopes stops the mail accounts
  (409 for workers); one without the calendar scopes only refuses calendar tokens (`FeatureNotGranted`, 403). A
  Microsoft refresh that fails for every scope the grant covers is tried again for mail alone: a user or admin who
  withdrew only the calendar consent keeps the mail, and the grant loses the calendars (status `not_granted`). A
  sign-in that adds calendars wakes the worker holding the account, so calendars start syncing right away.

##### Connecting an account in the web and desktop app

"Add account" (Settings, Accounts, the sidebar and the empty inbox) opens one dialog over Settings, Accounts at
`/settings/accounts/new`, the page provider sign-ins return to. Step 1 asks for the address only (and says at once
when it is connected already); `GET /api/v1/mail-server-settings` then names the provider, and the dialog goes to
the easiest way to connect it: the provider's own sign-in page for Google, Outlook.com and Microsoft 365 (when this
server has the OAuth app), an app password with Apple's or Yahoo's steps for iCloud and Yahoo, the server form
prefilled with what was found (or `imap.<domain>` and `smtp.<domain>`) for any other address with known settings,
and a list of providers when nothing is known. A password account is checked with `POST
/api/v1/mail-account-checks` and created only when the check passed; a failed check stays on its form and says which
server failed and how. The account has one username and password for both servers, so the boards' "use the same
username and password for outgoing mail" switch is not offered. On the web the provider's page opens in a new tab;
that tab finishes the sign-in when the provider sends it back and hands the outcome to the tab that started it,
matched by the OAuth state: over a `BroadcastChannel`, and as a note in localStorage that the waiting tab reads when
it starts waiting or comes to the front, so neither order of events loses it. Once the waiting tab took it the new tab
closes; otherwise it shows the outcome itself. This needs the Tresso sign-in shared by the tabs of a browser (tokens in
localStorage): a new tab that comes back signed out cannot finish, and tells the waiting tab, which says so. A sign-in
that expires (15 minutes) without an answer ends the waiting with "Try again". The notes are kept per OAuth state, so
dialogs in several tabs each get their own. Cancelling, and a waiting tab that gave up (expired, or signed out), are
noted in localStorage too: the provider's tab then finishes nothing, also when it comes back to the page later (after
the user signed in to Tresso there), and asks the user to start again from the dialog. A check that answers 409 (the
user's previous check, given up, still runs on the server) is retried quietly for up to 30 seconds. Cancelling or closing while a checked account
is being created removes it again. The desktop app opens the provider in the system browser and gets the answer
through its link, as before. The last step shows the account as connected as soon as sign-in is
proven, with the name on sent mail, the first sync's progress and whether its calendars sync.

##### Registering the OAuth apps

Each installation registers its own apps and puts the values in `apps/api/.env.local` (never committed). A provider
without a client id is not offered. With the Docker stack, `API_PUBLIC_URL` is `http://localhost:8080`; in
production it is the public HTTPS address of the API.

Google (Google Cloud console):

1. Create a project, enable the **Gmail API** and the **Google Calendar API** (APIs and services, Library).
2. OAuth consent screen (Google Auth Platform, Branding and Audience): app name, support address, authorized domain
   of the API; user type External (or Internal for one Workspace organization). While the app is in testing, add the
   addresses that may sign in as test users. Data access: add `openid`, `.../auth/userinfo.email`,
   `.../auth/userinfo.profile`, `https://www.googleapis.com/auth/gmail.modify`,
   `https://www.googleapis.com/auth/calendar.events` and `https://www.googleapis.com/auth/calendar.calendarlist.readonly`.
3. Clients, Create client, type **Web application**, authorized redirect URI
   `<API_PUBLIC_URL>/connect/google/callback` (for the Docker stack `http://localhost:8080/connect/google/callback`).
4. Set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`.

Microsoft (Microsoft Entra admin center, App registrations):

1. New registration. Supported account types: "Accounts in any organizational directory and personal Microsoft
   accounts" for `MICROSOFT_OAUTH_TENANT=common` (or single tenant, then set the tenant id). Redirect URI: platform
   **Web**, `<API_PUBLIC_URL>/connect/microsoft/callback`.
2. Certificates and secrets: new client secret (note its expiry; renew it before then).
3. API permissions, Microsoft Graph, delegated: `openid`, `email`, `profile`, `offline_access`, `User.Read`,
   `Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite`. Organizations whose users may not consent themselves need an admin to grant consent.
4. Set `MICROSOFT_OAUTH_CLIENT_ID`, `MICROSOFT_OAUTH_CLIENT_SECRET` and `MICROSOFT_OAUTH_TENANT`.

### 3.4 Sync workers (`apps/sync`)

Goal: fast synchronisation that scales horizontally to billions of accounts' worth of messages.

- **Leasing:** workers call `POST /internal/sync/leases` to claim a batch of accounts. Leases expire and are
  renewed by heartbeat, so a crashed worker's accounts move to another worker automatically. The worker's `/healthz`
  answers 503 until the first heartbeat and whenever the last successful one is older than two heartbeat intervals
  (or the lease timeout, when longer), so an orchestrator replaces a worker that lost the API. The worker's API token
  request has a 15 second timeout of its own. Each leased account says whether it is `fresh`: this worker did not
  hold it before the heartbeat, also when the API ended the lease. A worker restarts a syncer it still runs for a
  fresh account, so ending the lease (after the user changed the sign-in) starts the account over with fresh
  counters at the next heartbeat (30 s at most). A lost lease stops the syncer at the next heartbeat too; the
  connection is closed at once, also during STARTTLS, the greeting or a backoff wait.
- **Change detection (IMAP):** `IDLE` on the inbox for instant new mail; other folders every 5 minutes. With
  `CONDSTORE`, flag changes since the last MODSEQ; without it (or in a mailbox that answers NOMODSEQ), a full flag
  check, after an IDLE update at most once a minute (a throttled update is postponed, never dropped). Changes that
  happen between a sync and the next IDLE are caught by comparing the inbox's EXISTS, UIDNEXT and MODSEQ at
  re-selection. With CONDSTORE an EXPUNGE notification, or fewer messages than the last sync left plus the UIDs
  added since, runs the folder's presence check at once instead of waiting for the 30 minute one. A server that
  leaves UIDNEXT out of SELECT gets it from the highest UID.
- **Folder roles (IMAP):** the special-use attributes first; a role no mailbox is marked with is guessed from the
  name of a top-level mailbox, a direct child of INBOX or a direct child of the personal namespace prefix ("Sent
  Items", "INBOX.Trash", "Mail/Sent", "Verzonden items"), never from a deeper one. Each role goes to one folder only.
- **Deletions without QRESYNC:** the worker reports presence ranges ("between UID a and b only these exist") in
  chunks of 5000; the API removes the rest. Every folder is checked at session start and every 30 minutes.
- **Gmail** (`internal/gmailsync`, Gmail API): labels are folders (remote name = label id; INBOX, SENT, DRAFT, TRASH
  and SPAM get their roles, user labels are custom), plus a virtual `tresso:all` folder (role `all`) for everything
  outside Trash and Spam, so archived mail keeps a location. Chats, UNREAD, STARRED, IMPORTANT and CATEGORY_* are not
  folders; seen = no UNREAD, flagged = STARRED, draft = DRAFT (Gmail has no "answered"). History is account-wide, so
  one cursor (`historyId`, backfill page token) lives on `tresso:all`; the history id is taken before the backfill
  starts, so nothing is missed. Backfill fetches `format=raw` newest first, once per message, and files it in every
  folder its labels map to. Changes come from `history.list` every 30 s; touched messages are re-read (`format=minimal`)
  and reported per folder. A message going into or out of Trash or Spam is removed only from the system folders
  and the folders of the labels it has or that history named, not from every label folder. When the history id has expired (404), the
  folders are listed in full and compared with
  the API's `GET /internal/sync/accounts/{id}/folders/remote-uids` to find what was deleted.
- **Microsoft 365 / Outlook.com** (`internal/graphsync`, Microsoft Graph): every request asks for immutable ids
  (`Prefer: IdType="ImmutableId"`), so a message keeps its id when it moves. Folders are the folder tree (remote name
  = folder id, display name = path), with roles from the well-known folders. Each folder has its own cursor: the
  delta link, taken before the backfill, and the backfill position (by received time, so deletions during the
  backfill do not shift pages). Folders are started (their delta walked to its end) one per step, the inbox first,
  so the inbox is ingested before the other folders are walked, also when a round sees a removal (a message moved
  into a folder not started yet is added there by the rescue below); the walk's position is stored every 10 pages,
  so an interrupted walk of a large folder continues where it stopped, and a stored position Graph refuses (any 4xx
  but 401, 403 and throttling) starts the walk over. A 403 for a folder's children, messages or delta
  (a folder the user lost access to) leaves that folder out until the folder tree is read again, and one for a
  message is handled like any message the provider will not hand over (see Isolation); only a refused top of the
  folder tree means the mailbox may not be read (`auth_failed`). The inbox delta is polled every 30 s, other
  folders every 5 minutes; a round with
  removals re-reads the folder tree first and applies every folder's additions before any removal, so a move links
  the message to its new folder instead of deleting it. An expired delta link (410, `syncStateNotFound`) restarts the
  folder's delta and compares with the API's remote uids. "Answered" is not available through delta.
- **Both providers:** flag changes go first (`changes`), and only the uids the API answers as `unknownUids` are
  downloaded (Gmail raw, Graph `$value`) and ingested; a message entering another folder is downloaded once more and
  linked to the stored one by Message-ID. Requests are rate limited per account (Gmail 200 quota units/s, Graph
  15/s), 429 and 5xx are retried with Retry-After (5xx only for GET, PUT and DELETE), a broken connection or a timed-out
  attempt too for GET, PUT and DELETE (a POST may have taken effect), and a refused access token is renewed once through
  `credentials?rejected=1` (a second refusal, or missing scopes, reports `auth_failed`). Change notifications (Gmail
  Pub/Sub, Graph webhooks) need a public endpoint and are not used yet; polling covers both.
- **Connections** go through a guarded dialer that resolves the host and refuses private, loopback, link-local,
  CGNAT, NAT64, 6to4 and documentation ranges at connect time (the API checks at save time, the worker again on every
  connection, so DNS changes cannot redirect it). TLS 1.2+ with certificate verification, or STARTTLS.
- **Failures:** sessions reconnect with exponential backoff (2 s to 5 min). A refused login reports `auth_failed` and
  stops until the user changes the credentials: an IMAP LOGIN answered with AUTHENTICATIONFAILED, AUTHORIZATIONFAILED
  or EXPIRED at once; any other NO (without a code, with ALERT, which servers use for "use an app password", or with
  a code Tresso does not know) once five logins were refused over at least ten minutes without a login that went
  through in between (other failures in between do not start the count over), sessions being at least a minute apart
  while refusals are counted: servers also refuse a correct password for a while (NO [ALERT] "Too many simultaneous
  connections"). The text of an ALERT is shown to the user in the status detail.
  NO [UNAVAILABLE], [INUSE], [LIMIT], [SERVERBUG] and [CONTACTADMIN] are ordinary session failures, and LOGINDISABLED
  or PRIVACYREQUIRED asks the user to choose TLS or STARTTLS. Three failed sessions in a row report `error` with a
  user-safe detail, repeated until the API took it.
- **Isolation:** one message must not stop its folder (`internal/isolate`). Every value sent to the ingest API is cut
  to the API's limits and cleaned of NUL and other control characters (`internal/ingestmsg`). When the API still
  refuses a batch for its content (400, 413, 422), the batch is sent again one message at a time and a message
  refused on its own is replaced by a placeholder ("Message could not be imported (ref ...)", sender
  `unknown@unknown.invalid`, a short notice of its own as the raw MIME, so the API never takes it for the real
  message by its raw content), logged with folder, uid and Message-ID; then the cursor moves on.
  Failures that may pass are only counted next to messages of the same request that went through, so an outage of
  the API or the provider never counts: a 500 for one message, and a message the provider will not hand over (an IMAP
  FETCH answered NO or without a body, a Gmail or Graph 4xx or 5xx other than 401, 404, 429 and the 403s of
  throttling and quotas, a Gmail raw that cannot be decoded). Such a message is replaced only after it failed three
  times over at least an hour, by a placeholder whose raw MIME is a short notice, dated and flagged (and for Gmail
  filed by its labels) as the provider still says. A message failing alone in its request is never replaced; the
  next mail in the folder joins it. A placeholder is not final: its uid is kept in the folder's cursor (`pending`,
  at most 50, for Gmail on `tresso:all`), stored in the cursor before the placeholder is sent, and the real message
  is tried again an hour later, then every 2, 4, ... up to 24 hours (for Graph in the folder the message is in now).
  The ingest API keeps one message per uid and folder and only refreshes the flags of a uid the folder has, so the
  real message cannot go in next to the placeholder: it is sent once while the placeholder holds the uid (that only
  refreshes flags, but a message validation refuses, 400, 413 or 422, fails there and the placeholder stays), then
  the placeholder's uid is removed and the message sent. When the API refuses it then (a 500 while storing it), the
  placeholder is put back at once and the next try comes later. A replacement is stored in the cursor at once, so it
  is never done again on the real message. Known limits: a todo or hand-over made from a placeholder loses its mail
  when the real message replaces it (a new message; keeping it needs the API to update a placeholder in place); a
  placeholder the user moved in Tresso on an IMAP account is not tried again (the move gives it a new uid); and
  without the API change of #93 (an orphaned message is linked back when it appears again) a crash between a
  replacement and its cursor store recreates the message.
- **Folders the server will not open:** a mailbox whose STATUS is refused with NONEXISTENT or NOPERM is left out of
  the folder list (the API deletes it); one whose STATUS is refused otherwise stays listed without a UIDVALIDITY (the
  API keeps what it has) and is skipped, like one whose SELECT is refused, until the next folder list (every 5
  minutes); the other folders go on. When the inbox, or every folder, cannot be opened the session fails, so the
  account reports `error` instead of being in sync.
- **Ingest:** raw MIME goes directly to object storage, encrypted with the account owner's blob key
  (`raw/<owner id>/<fp[0:2]>/<fp>`, named by the owner's content fingerprint, so duplicates within one user are
  stored once); attachments too (`attachments/<owner id>/<fp[0:2]>/<fp>`). The worker fetches the keys from
  `GET /internal/sync/accounts/{id}/storage-keys` (see "3.16 Encryption at rest"), and each message names the key
  version it was encrypted with (`keyVersion`); attachments are reported by `fingerprint`. Parsed metadata goes to the
  ingest protocol (scope `sync:ingest`, only for the leasing worker, every call safe to repeat):

  | Call | Purpose |
  |---|---|
  | `POST /internal/sync/accounts/{id}/folders` | The complete folder list. Answers each folder's stored cursor; a changed UIDVALIDITY resets the folder. Folders missing from the list are deleted. |
  | `POST /internal/sync/accounts/{id}/messages` | Up to 200 new messages for one folder plus the folder's cursor after the batch. A known (folder, uid) only refreshes flags; a message already stored (same raw content, or same Message-ID with the same sender, Date and subject) only gains a location. A different mail that reuses a Message-ID is stored on its own. |
  | `POST /internal/sync/accounts/{id}/changes` | Flag changes and vanished uids for one folder. A message that is in no folder anymore is deleted after a grace period (below). |
  | `POST /internal/sync/accounts/{id}/status` | `active`, `auth_failed` or `error` with a short detail the user sees. A paused account keeps its pause (pausing also ends the lease), and `active` or `error` do not undo an `auth_failed` (only the user signing in again does); the answer is the status that holds. |

  The cursor is opaque to the API: the worker decides what it holds (UIDNEXT, HIGHESTMODSEQ, backfill position).

  A message that lost its last folder (vanished, outside a presence range, its folder reset or deleted, a move from
  Tresso undone without its source) is not deleted at once: a move made in another mail app reaches the API as the copy
  leaving one folder and, up to a folder poll later, showing up in another, where the ingest links it by Message-ID.
  So it is marked orphaned (`message.orphaned_at`): clients see it in no folder, search leaves it out, and a copy that
  shows up anywhere clears the mark, so the message keeps its id, todo, hand-over and placement. A sweep every five
  minutes deletes messages that stayed in no folder for 15 minutes (longer than the 5 minute poll), with their
  tombstones. Only placeholders of moves that never landed within the hour are deleted at once. The grace covers a
  move, not a long download: when a folder whose UIDVALIDITY changed takes longer than that to download again, the
  messages not reached by then are deleted and stored again as new, as before the grace existed.
- **Threading** (API side, at ingest): first by headers in both directions (messages this one refers to through
  In-Reply-To/References, and stored messages that refer to this one), merging threads that turn out to be one
  conversation (the oldest survives and takes over a placement the user gave another one, the newest such placement
  when there are several); without any references, the newest thread from the last 14 days with the same normalized subject in which the
  people who matter took part. Mail counts as the user's own when it is from one of their account addresses or filed in
  a Sent folder (so mail sent from an alias in another app counts too). Someone else's mail joins a thread with
  someone else's mail from one of its people (its sender, or a recipient: a colleague's reply-all), or with the user's
  own mail that went to its sender (an answer). The user's own mail joins a thread with someone else's mail from one of
  its To recipients, or with the user's own mail that went to every one of its To recipients (writing again to the
  same people); its Cc says nothing, not even when that colleague wrote in the other conversation. The user's addresses never count, nor does a recipient that is merely shared (billing@ two strangers wrote
  to, a colleague the user copies on everything). The price: a reply without References from a new address that only
  copies the original recipient (Bob answers for Anna, Cc Anna) starts its own thread. The condition is part of the
  candidate query, so an older conversation is found behind any number of newer ones with that subject.
  Otherwise a new thread.
- **Backfill:** newest first, in budgeted steps per folder, so the inbox is usable within seconds while history fills
  in behind and new mail is never stuck behind it. Fetches are grouped by count (50) and size (20 MB).
- **Cursor:** per folder, opaque to the API: UIDVALIDITY, UIDNEXT, backfill position and HIGHESTMODSEQ. It only
  advances after the API accepted the work it covers, so a crash never skips mail.
- **Sending:** `POST /api/v1/outgoing-messages` (scope `mail:send`) queues mail from one of the user's accounts, now or
  at a `sendAt` (send later, or a few seconds for undo; cancellable until a worker takes it). A client may choose the
  message's id (`outgoingId`, a UUIDv7 made when the user hits send and reused by every retry of that attempt): a
  request with the id of a message the user has queued already returns that message, whatever its `sendAt` or the age
  of the id say by then, so an answer that got lost never sends the mail twice nor refuses a late retry. The checks on
  the send time, and that the id is no more than five minutes ahead of the server (workers look for earlier attempts
  from the id's time less five minutes), only apply to a message not queued yet. An old id has no limit: it only makes
  that look reach further back. The API builds the
  MIME message (In-Reply-To and References for replies, Bcc only on the envelope) and stores it in object storage.
  Once the transaction commits it tells the workers on the Mercure topic `urn:tresso:sync:outbox`; scheduled mail is
  released by a delayed Messenger message, and every heartbeat both releases due mail and lists the leased accounts
  with mail to send, so a lost notification only delays sending. The leasing worker claims due messages (5 minute
  claim), sends over SMTP (whole message refused when one recipient is refused), or for Gmail and Microsoft 365
  through their APIs (Gmail `users.messages.send`; Microsoft through a draft, see below; the envelope-only Bcc
  recipients are added as a Bcc header, which both providers strip; Gmail replies carry the thread id of the message
  they answer), files a copy in Sent (except at providers that do that themselves, Gmail and Microsoft included) and
  reports sent, retry (4xx, connection problems, a wrong password: up to 6 attempts over about 4.5 hours) or failed
  (5xx). The outcome report is sent up to three times when the API cannot be reached or answers 5xx. A message
  claimed again after an unreported attempt is first looked up, so it is never sent twice; when the lookup cannot be
  made (Sent cannot be opened or searched) nothing is sent and the message is retried, and only an IMAP account
  without any Sent folder sends without looking; the
  outcome and its text reach the user in the delta as `outgoingMessages` (`lastError`).
  - IMAP accounts: the Sent folder by Message-ID.
  - Gmail may replace the Message-ID, so its sends carry `X-Tresso-Outgoing-Id` (a SHA-256 of the outbox id and the
    Message-ID, nothing internal). The lookup tries the Message-ID, then searches `from:me` (Trash and Spam included,
    which `in:sent` would miss) since the outbox entry was written (its id is a UUIDv7), narrowed to the first
    recipient and the subject, and reads that header on every match, however many. Gmail search cannot match custom
    headers, so the recipient and the subject are the narrowing; each match read costs 5 quota units.
  - Microsoft may keep neither the Message-ID nor X- headers on the Sent Items copy, so mail goes out through a
    draft: created from the MIME (`POST /me/messages`), marked with a named string extended property of Tresso's own
    property set (`TressoOutgoing`, the same SHA-256 value), and sent (`POST /me/messages/{id}/send`). Custom extended
    properties stay on the item, so the lookup is one filtered request over the whole mailbox,
    `singleValueExtendedProperties/Any(ep: ep/id eq '...' and ep/value eq '...')`. Copies sent before this (with
    `sendMail`), or whose draft Exchange would not mark (a 4xx on the PATCH: the draft is then sent unmarked, logged
    once per account), are found by Message-ID and by `X-Tresso-Outgoing-Id` on the Sent Items since the entry was
    written, sent to the first recipient (all of them when Graph refuses that filter), a thousand a page. Drafts and
    the Outbox never count as sent. A draft an earlier attempt left (marked, or with our Message-ID) counts as stopped
    only when it is in Drafts and unchanged for 15 minutes: Exchange accepts a send (202) and sends a little later,
    and until then the item is still a draft, in Drafts or the Outbox. A stopped one is deleted and the message sent
    anew; a younger one, or one in the Outbox, leaves the question open. A draft whose send was refused (4xx) is
    deleted at once. Graph takes at most 4 MB per request,
    so a message of about 3 MB (base64 included) is the limit, as with `sendMail`. Docs: [extended properties
    overview](https://learn.microsoft.com/en-us/graph/api/resources/extended-properties-overview), [create
    (PATCH)](https://learn.microsoft.com/en-us/graph/api/singlevaluelegacyextendedproperty-post-singlevalueextendedproperties),
    [filter](https://learn.microsoft.com/en-us/graph/api/singlevaluelegacyextendedproperty-get), [send a
    draft](https://learn.microsoft.com/en-us/graph/api/message-send), [MIME
    messages](https://learn.microsoft.com/en-us/graph/outlook-send-mime-message).
  - When the lookup cannot decide, nothing is sent. Only a refusal (a 4xx other than 429) fails the message at once,
    with "Tresso could not check whether an earlier attempt already sent this message; it was not sent again. Check
    Sent and send it again if needed." Anything else (429 or 5xx after the retries, no answer, "not decided yet": a
    copy that may still be sending, a leftover that could not be deleted) is a retry, so the next attempt looks again.
    A retry's text shows in the outbox while the message waits, so it stays neutral ("Tresso is checking whether an
    earlier attempt already went out and will try again shortly."), or users would send the message again while the
    original is still going to be sent. The claimed message says whether the attempt is the API's last
    (`lastAttempt`); its retry ends the message, so it carries the final text: the one above, or, when the earlier
    copy may still go out, "An earlier attempt may still be waiting in the Outbox and could still be delivered; it
    was not sent again. Check the Outbox and Sent before you send it again." Lost access only waits: the check runs
    again once the user signed in.
  - Gmail narrows by subject only when it has a letter or digit; Gmail matches subjects by word, so a subject of
    punctuation alone would match nothing.
- **Drafts:** `/api/v1/drafts` (scopes `mail:read`, `mail:write`) stores the message being written with a `version`
  per save; an update names the version it builds on (`expectedVersion`) and is refused with 409 when another
  device saved in between, so nothing is overwritten silently. Clients choose the draft's id (`draftId` on create),
  so a draft has it before it reached the server. Drafts are in the delta. Once a draft rested 20 seconds after the
  last edit, the leasing worker appends a copy (`\Draft`, Bcc kept, `X-Tresso-Draft` header) to the account's
  Drafts folder, creating the folder when there is none, and only then removes the copy it replaces, so a failure
  leaves an extra copy rather than none. Copies of drafts that were sent (`draftId` on the outgoing message),
  deleted or moved to another account are queued for removal. The work comes with the outbox run: the same
  realtime notification and heartbeat hint, the same claim and report cycle. Gmail accounts file copies with
  `users.drafts.create` and remove them by Message-ID (`rfc822msgid:`), or, should Gmail have replaced it, by the
  `X-Tresso-Draft-Copy` header (a SHA-256 of the Message-ID). Gmail cannot search custom headers and batching does not
  lower quota, so that header is read only on drafts since the draft was started and at most a week back; a copy not
  found counts as removed (a copy older than a week whose Message-ID Gmail replaced stays as an extra draft). Microsoft
  365 accounts create copies from the MIME message (`POST /me/messages`), mark them with the `TressoDraftCopy` extended
  property and remove them from Drafts permanently, found by that property in one request (older copies by
  Message-ID or the header).
- **Message actions:** `POST /api/v1/message-actions` (scope `mail:write`) marks up to 500 messages read or unread,
  flags or unflags them, archives them (out of the inbox into Archive, or All Mail where there is no Archive folder,
  as on Gmail), trashes them or moves them to a folder of their account (every copy, or with `fromFolderId` only the
  copies in that folder). The change shows in Tresso at once and is
  queued per account as a `mailbox_change`; the outbox run claims an account's changes in the order they were made
  (`/internal/sync/accounts/{id}/mailbox-changes/claim`) and reports each (`.../{change}/report`: done, retry,
  failed, or gone for a move whose copy is no longer in its folder). A flag change goes on every copy of the message;
  a move takes one copy out of its folder at once and leaves a placeholder copy (remote uid `pending:<change id>`) in
  the target, which becomes the real copy under the uid the worker reports (from UIDPLUS, or found by Message-ID) or
  the folder sync finds. While a flag change is unconfirmed the folder sync leaves \Seen and \Flagged as the user set
  them. A message's changes are made in order: once one is not done, the worker leaves the message's later changes for
  the next run, and changes to a copy that is still on its way wait until it landed, without holding up other
  messages. A change the server refuses, or that still fails after six attempts with backoff, is undone, so Tresso
  shows the message as the server has it; a move that finds its copy gone (an earlier unreported attempt, Gmail taking
  every label away with the first copy moved to Trash, another app) puts nothing back. Placeholders survive a reset of
  their folder; when the folder is deleted, its moves are undone; a placeholder whose move is done but that never
  lands within an hour is dropped. The worker moves with MOVE, or COPY and then \Deleted where the server has no MOVE
  (never copying twice on a retry); it expunges only that copy (UIDPLUS) and never the whole folder, which would also
  erase messages another app merely marked deleted. Gmail accounts change labels instead: read and flag through
  UNREAD and STARRED, archive removes INBOX (the copy in the virtual All Mail folder takes the placeholder's place),
  trash and untrash through `messages.trash`/`untrash`, and a move adds the target label and removes the source one.
  Microsoft 365 accounts PATCH `isRead` and `flag` and move with `/move`; immutable ids keep the message's id, so the
  worker always reports the uid in the target.
- **Bulk actions on a scope:** `POST /api/v1/bulk-actions` (scope `mail:write`) marks read, archives, trashes or
  moves every conversation of a scope, however many: what a smart inbox lists (`in: smartInbox`), what the inboxes
  list, or the whole mailbox outside Trash, Spam and Drafts, narrowed to one account (required for a move, which stays
  within one account), one sender, conversations whose newest message is older than `olderThanDays`, or ones with a
  message of at least `largerThan` bytes. The lists match the clients' `inList`: mail held for its batch (batched
  delivery, `held_until`) is in no list, so no bulk action, count, sender list or suggestion takes it. It answers 202 at once and works
  through the conversations on the Messenger transport `bulk`, which has its own consumer (`bulk` in Compose), so
  it never holds up sending: at most ten batches or about ten seconds per handled message, the rest queued again.
  Each batch is its own short transaction: it looks at a window of at most 1000 conversations in id order, through
  `thread (category_id, id)` for a smart inbox or `thread (mail_account_id, id)` for the owner's accounts one after
  the other, tests the scope on those only, and acts on at most 200 conversations and about 500 messages
  (`thread.message_count` keeps a long conversation from making one batch huge), through the same `MessageActions`
  a single action uses, so the delta and the mail servers follow batch by batch. The cursor (account and last
  conversation looked at) is stored with the action, so each conversation is read once per run and a repeated or
  late message picks up where the last commit left off. Sender and size filters are matched through
  `message (mail_account_id, from_address, received_at)` and `message (mail_account_id, size)`. Only mail that
  reached Tresso before the action started is taken: ids are UUIDv7, so messages and threads whose id sorts below
  the action's own id are older. Every account in scope must have the folder an archive or trash needs before
  anything starts, and a user has one bulk action (or undo) under way at a time (409 otherwise, checked under a
  per-user advisory lock). Each moved or flagged message is one change the worker makes on the mail server, oldest
  first, so while an account the next batch touches has 1000 or more changes the worker has yet to make, the run
  waits (queued again 30 seconds later, `waitingSince` set) instead of holding up what the user does to single
  conversations; a backlog on an account outside the batch holds nothing up. A run that has waited an hour (an
  account with expired credentials, or one no worker leases) stops and says which mail server is behind, so the user
  can undo what was done or start again. `POST /api/v1/bulk-actions/{id}/cancel` stops an action or its undo at
  once. `GET /api/v1/bulk-actions/{id}` reports the progress (`running`, `done`, `failed`); a smart inbox or target
  folder deleted meanwhile stops the run and keeps what it did, as does a run that still fails after its retries
  (marked with plain SQL, since the failed batch closed the entity manager; the listener never throws, so the
  consumer keeps running). A stopped action can still be undone. A run only goes on through its next queue message, so
  a sweep every five minutes queues a new run for an action under way that no run handled for ten minutes (its
  message was lost, say because the queue was unreachable right after the action was saved); a second runner is
  harmless, as each batch takes the action's row lock.
  `GET /api/v1/bulk-selection` counts a scope (conversations, messages, accounts) before the user confirms.
- **Their undo** works like a single action's (`undoPlan` in `packages/core`): each batch records, per message it
  moved, where it went and the one folder it came from (`bulk_action_move`); messages that came from several folders,
  or were archived into Gmail's All Mail, are only counted (`unrestorable`). `POST /api/v1/bulk-actions/{id}/undo`
  moves them back in batches, only the copies still where the action put them and one copy per message (on Gmail a
  trashed message briefly has a copy per label in Trash; the worker finds the second gone). A move into a folder
  the message was in already is counted as `unrestorable`: moving its copies back would take the old one along.
  Marking read has no undo, as in the clients. A finished action, and its undo, is forgotten a day later (when the user starts the next one).
- **Senders and cleanup suggestions:** `GET /api/v1/smart-inboxes/{id}/senders` lists who sends what a smart inbox
  lists, by conversations, with messages, unread and the newest, without the user's own addresses (at most 100).
  `GET /api/v1/cleanup-suggestions` applies fixed rules, nothing guessed, each with its numbers and the bulk action
  (`action` and `scope`) that cleans it up: a sender of mailing-list mail (List-Unsubscribe or List-Id) with at
  least 3 unread messages in the inboxes who sent mail in the last 90 days (`windowReceived`) of which the user
  opened none (archive), any other sender likewise with at least 10 (archive), 10 or more conversations in the
  Notifications or Advertising smart inbox older than 30 days (archive), and 3 or more conversations with a message
  of 5 MB or more and no new mail for a year (Trash). The sender rules start from the unread messages in the
  owner's inbox folders and apply their thresholds in SQL before the limit of 20; each suggestion's count is what
  its action takes. Every query starts from the owner's accounts.

- **One-click unsubscribe:** the outbox run also makes the user's RFC 8058 unsubscribe requests for the accounts it
  leases (`/internal/sync/accounts/{id}/unsubscribes/claim` and `.../{request}/report`, a 5 minute claim, announced
  and hinted like the outbox, ten at a time). The worker POSTs `List-Unsubscribe=One-Click`
  (`application/x-www-form-urlencoded`) to the message's `https` address on port 443 only, through a guarded dialer of
  its own that never allows private addresses, whatever `MAIL_ALLOW_UNSAFE_SERVERS` says (private, loopback and other
  non-public addresses are refused at connect time, also after DNS changes), with TLS 1.2+ verified, no proxy, no
  cookies, no credentials (an address with a user name is refused), no keep-alive and no redirect followed, within 5
  seconds, reading at most 64 KB of the answer. 2xx and 3xx count as done, 429, 5xx and no answer as retry (six
  attempts, one minute to three hours apart), other 4xx and refused addresses as failed. The requests run in a lane of
  their own per account, next to the mail users wait for (sending, drafts, changes to messages), so a slow sender's
  server never holds up mail queued meanwhile, and they also run when the account cannot send; each lane never runs
  twice at once for an account. The lane starts no request later than four minutes after its claim, so every report
  reaches the API within the five-minute claim.

### 3.5 Client sync protocol

- Synced entities (mail accounts, folders, threads, messages; todos and settings follow the same pattern) carry a
  `change_seq`. Every insert or client-visible update gets the owner's next number; updates that only touch internal
  fields (sync cursors, leases, encrypted credentials) do not. A message also changes when it gains or loses a
  folder. Deletes leave a tombstone.
- Numbers come from `UPDATE app_user SET change_seq = change_seq + 1 RETURNING`, which locks the user's row until
  the transaction commits. Writes for one user therefore become visible in number order, so a client that has seen
  N never later meets an uncommitted smaller number. Every write path runs in an explicit transaction; the
  allocator refuses to run outside one. Different users never wait on each other.
- `GET /api/v1/sync/changes?since=N&limit=500` (scope `mail:read`) returns mail accounts, folders (with role),
  threads (with their smart inbox, verdict and classification reason), messages (metadata, flags, folder ids, smart
  inbox and verdict, never bodies), smart inboxes, todos, hand-overs, daily briefs and `deleted` entries above N, plus the new `cursor` and
  `hasMore`, and `latest`: the newest change number of the user (one primary-key read of `app_user.change_seq`, taken
  after the page's boundary, so never below `cursor`). From `since`, `cursor` and `latest` a client tells how far
  behind it is and shows a real fraction; `latest` can stay above the last cursor a pull reaches (a number whose rows
  changed again, or that only rows the token cannot read carry), so a pull ends at `hasMore: false`. Servers from
  before 0.9 send no `latest`; clients then show a pull without a fraction. Every list needs the scope its own endpoints need, so a personal access token or an app that is not
  ours gets only what the user allowed it: mail accounts, folders, threads, messages, outgoing messages, drafts,
  unsubscriptions, mail notifications, hand-overs and daily briefs with `mail:read`; calendars, calendar events,
  notifications and event notes with `calendar:read`; todos with `todos:read`; signatures with `signatures:read`;
  smart inboxes with `settings:read`. Chat accounts, chats, chat messages and chat replies (`chatAccounts`, `chats`,
  `chatMessages`, `chatOutgoing`) follow `ChatAccessVoter`: our own apps, or a token with `chat:read`; the endpoint
  itself still needs `mail:read`, so a token with `chat:read` alone gets 403 here and reads its chat accounts at
  `/api/v1/chat-accounts`. A list the token may not read comes empty, and so do its `deleted` entries.
  The cursor and the paging count every change, so the cursor is the same for every token of a user. Only our own
  apps make the user's Tresso calendar or the older built-in smart inboxes on a pull; for any other token the delta
  writes nothing. Threads and messages also carry `heldUntil` and `batchedAt` (batched delivery, 3.7), messages the
  `unsubscribe` method they offer (`oneClick`, `mailto` or null) and the `unsubscribeMailto` address, smart inboxes
  `batchDelivery`, and the page the user's `unsubscriptions` (one per account and sender). A page never splits one
  change number; changes made in bulk (a folder reset or deleted, messages deleted after their grace period) take a
  change number per 1000 messages, so they page like any other change. A deleted mail account implies its folders,
  threads and messages are gone.
- Clients store data in a local cache (desktop via Rust/Tauri SQLite, mobile via expo-sqlite, web via IndexedDB),
  start with `since=0`, keep the cursor, and fetch message bodies lazily.
- Realtime: the Mercure hub built into FrankenPHP tells clients "your changes reached N"; the client then pulls the
  delta. The notification carries no data, so a missed one only delays the client until the next one or its next
  reconnect, when it pulls the delta anyway.
  - `GET /api/v1/realtime/token` (scope `mail:read`) returns `hubUrl`, the user's private `topic`, a subscriber
    `token` and its `expiresAt`. Clients subscribe with `GET {hubUrl}?match={topic}` and the token in the
    `Authorization: Bearer` header, and fetch a new token before it expires. Browsers read the event stream through
    `fetch()`, because `EventSource` cannot send headers; the hub accepts no token in the URL (RFC 9700), and its
    cookie alternative does not fit clients on another origin than the hub.
  - Every update is private, of type `changes`, with data `{"cursor": N}`.
  - The hub runs in issuer mode: it trusts tokens from issuer `tresso-api` with the hub's public URL as audience.
    Tokens are JWT access tokens (`typ: at+jwt`) whose grants are RFC 9396 `authorization_details`, limited to exact
    topics. Subscriber and publisher tokens use different keys, so a subscriber key can never publish.
  - Change numbers are published only after the transaction that allocated them committed (a DBAL driver
    middleware reports commits and rollbacks), and only after the response went out (`kernel.terminate`; console
    commands and Messenger messages publish when they finish). A rolled-back write publishes nothing. A failed
    publish is logged, never raised.
- Message content: the delta never carries bodies. `GET /api/v1/messages/{id}/body` (scope `mail:read`) reads the
  raw message from object storage, picks the HTML and text parts, and returns HTML that is safe to render:
  - An allowlist sanitizer (symfony/html-sanitizer) removes scripts, event handlers, forms, frames and embedded
    objects; links get `target="_blank"` and `rel="noopener noreferrer"`. Layout attributes, classes and inline
    styles stay, because mail layouts depend on them. Style elements are kept as sanitized CSS in front of the body.
  - Every URL that loads media (image sources, backgrounds, CSS `url()`) passes one policy: `cid:` references
    become signed attachment URLs, `data:` is allowed for plain image types only, and anything from the internet
    is removed unless the request says `remoteContent=allow`. Remote loads tell the sender that, when and where a
    message was read, so they are blocked by default; `hasRemoteContent` lets the client offer to load them. CSS
    escapes are resolved before checking, so escaped names cannot slip past.
  - Clients render the HTML in a sandboxed frame without scripts and with a Content-Security-Policy that allows
    images only from the API (and from the internet once allowed): a second, independent layer.
  - Attachments are listed with a signed URL (`/content/attachments/{id}`, valid for an hour, no access token,
    because images inside rendered mail cannot send one). Only plain image types are served inline; everything else
    downloads as `application/octet-stream`. Every response carries `nosniff` and `Content-Security-Policy:
    default-src 'none'; sandbox`. Attachments that are still being scanned or are quarantined have no URL and are
    never served (see 3.8). A web client that has shown a body for 50 minutes or longer fetches it again on a
    download, so the file opens through a fresh link rather than an expired one.
  - A part counts as inline when the HTML references its Content-ID; the worker decides this, because mail clients
    disagree on the disposition of embedded images. The Content-ID is kept for every part.

### 3.6 Processing pipeline (per new message)

```
ingest -> thread assignment -> virus scan (attachments) -> classification -> verdict actions
       -> search index -> push notification (only do / delegate)
```

Planned features hook into these steps: AI classification, assignments to teammates and webhooks (3.9).

### 3.7 Classification

- A smart inbox (the `category` table) = name + instructions + include list + exclude list (addresses or `@domain`,
  which covers subdomains) + verdict + flags (auto-create todo, see 3.14; batch delivery and notify are used by later
  steps). Every
  user has five built-in ones (`todo`, `informational`, `notification`, `advertise`, `spam`), created with the user;
  they can be changed but not deleted. Mail lands in exactly one smart inbox.
- `/api/v1/smart-inboxes` (scopes `settings:read`, `settings:write`) lists, creates, updates (JSON merge patch) and
  deletes them. Names are unique per user (case-insensitive), at most 50 of the user's own, a sender cannot be on both
  lists. Smart inboxes are in the delta (`smartInboxes`, tombstone type `smartInbox`). Deleting one takes its
  conversations and messages out of it in the same transaction (so clients see them change) and lets classification
  place them again.
- Classification sits behind `App\Classification\Classifier`. The built-in `RuleBasedClassifier` decides, in
  this order: spam that no From-based rule may overrule, because a From address is easy to forge (DMARC failing a
  reject or quarantine policy, which not even the Spam exclude list overrules, and the server's spam verdict on mail
  whose sender did not pass DMARC); a sender rule (a
  correction the user made earlier, by address, then domain and parent domains); the include lists (the user's own
  smart inboxes first); then signals in the message, each pointing at a built-in smart inbox: the server's spam
  verdict (junk folder, `$Junk` keyword, `X-Spam-Flag`, `X-Spam-Status`) (spam), `Auto-Submitted` or `Precedence:
  auto_reply` (notification), marketing senders (`newsletter@`, `promo.` and similar, never for a reply) and bulk
  headers (`Precedence: bulk`, `List-Unsubscribe` with `Feedback-ID`) (advertise), addresses that take no replies
  (`noreply@`, `notifications@`, `alerts.`) (notification), a mailing list (`List-Id`; checked before the unsubscribe
  link, which discussion lists carry too) (informational), an unsubscribe link (advertise), and finally mail from a
  person: something to do (todo) unless the user is only in Cc (informational); Bcc and addresses of the user Tresso
  does not know count as direct. A smart inbox whose exclude list covers the sender is skipped at every step. The
  verdict is the smart inbox's unless a sender rule sets one. The `instructions` field is for an AI classifier, which
  decorates the `Classifier` service and should keep sender rules and lists in charge.
- The sync worker sends the headers the rules read (`headers`) and the junk keyword (`junk`) with each message; the
  API keeps them in `message_signals`, apart from the message row and only for messages that have any. Anyone can
  write an Authentication-Results header, so a DMARC pass counts only when the receiving server surely wrote it: at
  Gmail and Microsoft 365 the topmost header is always theirs, and Gmail's must also name Gmail (`mx.google.com`) as
  the host that wrote it; Microsoft's names none. The header is read as RFC 8601 results (`SenderAuthentication`):
  comments and quoted strings are dropped (they repeat what the sender chose, such as the envelope sender or the
  claims of an ARC set), and only a result entry `dmarc=pass` counts. The worker sends the topmost one whole, up to 8000
  characters (other headers up to 1000); a longer one is cut at its last `;` before the limit that is outside
  comments and quoted strings, so the cut never leaves part of a comment or quoted string. Deploy the API before
  the worker: an API older than this answers 422 to such a header, which makes that message a placeholder until
  the next try an hour later. For Microsoft 365 accounts (Graph) it also sends `x-ms-exchange-organization-authas` as
  written (`Internal` for mail sent inside the tenant, up to 1000 characters): Exchange Online strips the
  X-MS-Exchange-Organization-* headers from mail arriving from outside (its header firewall), so there it can only be
  Exchange's own. A sender can write it into any other mail, so it is never sent for Gmail or IMAP accounts. Known
  limit: this rests on Exchange's documented behaviour and was not checked against a live tenant. A generic IMAP server may add none, and then the
  sender's own header could name any server, the recipient's too, so on IMAP accounts a pass never overrules the
  server's spam verdict (`ReceivingServers`). A pass counts only when trusted; a failure always counts, because a
  forged failure can only send the forger's own mail to Spam. A junk keyword
  set or cleared after ingest is not read again (flag changes carry only seen, flagged, answered and draft).
- Classification runs after the ingest commits, on its own Messenger transport (`classify`) with its own consumer
  (`classifier` in Compose), so a first sync never holds up sending. It goes in batches of 200 per transaction, ten
  per job; a longer run queues the rest as a new job. Runs for one user take turns on an advisory lock. Each incoming
  message gets a smart inbox and verdict (clients notify on `do` and `delegate`); its conversation takes those of its
  newest incoming message. An unchanged outcome is not written, so classifying again resends nothing that did not
  move. The user's own mail is never classified: mail from their accounts' addresses, and mail filed in Sent or Drafts
  and otherwise only in folders that hold everything (All Mail, an All or Archive folder), which covers an alias. A message waits with `classified_at` empty, so a lost run is caught up by the next one.
- Corrections: `PUT /api/v1/threads/{id}/classification` (scopes `mail:write` and `settings:write`, because it
  remembers a rule) with a smart inbox and optionally a verdict takes the user's smart inbox lock and then their
  classification lock (the order every path keeps), reads the conversation and the smart inbox again, puts the
  conversation and its newest incoming message there for good (reason `user`; automatic classification leaves it
  alone from then on), remembers the choice for the sender as a sender rule (one per sender), takes the sender's
  address off that smart inbox's exclude list, and classifies again the last 30 days of mail from that sender. When a
  domain entry on that exclude list covers the sender the correction is refused (422): the rule would never apply.
  When new mail like this keeps going to Spam whatever the rule says, the correction is made and remembered, and the
  answer says why (`senderRule.spamOverrules`): `authentication_failed` (it fails DMARC with a reject or quarantine
  policy, so its From address could be anyone's) or `server_spam` (the mail server marks it as spam and its sender is
  not authenticated in a header Tresso can trust, which on a generic IMAP account is never). The web client tells the
  user in an app-wide notice, which stays when the conversation leaves the list it was moved from.
  With `remember: false` only the conversation moves: no sender rule, no change to an exclude list, nothing classified
  again (triage decides one email at a time). Every placement by the user gets a new `placementId` (in the answer,
  stored on the conversation), also one identical to the last. `DELETE
  /api/v1/threads/{id}/classification?placementId=` (scope `mail:write`) takes that placement back under the same
  locks: the conversation and its newest incoming message go where the rules put that message now (sender rules
  stay), a conversation of only the user's own mail leaves its smart inbox, and one the user did not place is left
  alone. When the conversation was placed again since (another device, even to the same place) the answer is 409 and
  that choice stays. Triage's undo uses it.
  `GET /api/v1/sender-rules` and `DELETE /api/v1/sender-rules/{id}` (scopes `settings:read`, `settings:write`) list
  and forget them; forgetting one takes the classification lock first, so it waits for a correction of the same user,
  and classifies that sender's recent mail again.
- Every change to the smart inboxes classifies the last 30 days again after the commit; writes to one user's smart
  inboxes take turns, so the name and count checks hold. `app:classification:rerun --user=<email>` or `--all`, with
  `--days` (0 for all mail), does it by hand. Smart inboxes created before they synced get a change number on a sync
  from the start.
- Each conversation carries why it is where it is (`classificationReason`: `user`, `sender_rule`, `include_list`,
  `server_spam`, `authentication_failed`, `automated`, `marketing_sender`, `bulk`, `notification_sender`,
  `unsubscribe_link`, `mailing_list`, `direct`, `copied`, or a reason of another classifier), which clients explain.

#### Batched delivery

- A smart inbox can deliver in batches (`batchDelivery`, on for the built-in `notification` and `advertise`): its new
  mail waits for the user's next batch time instead of arriving as it comes. The times are the user's
  (`/api/v1/batch-delivery`, scopes `settings:read` and `settings:write`: one to eight `HH:MM` times and an IANA time
  zone, 09:00 and 16:00 UTC until the user chooses, `configured` false until then, `nextBatchAt` with every answer).
  They are wall clock times in that zone, so a batch at 09:00 stays at 09:00 across daylight saving changes
  (`App\Batch\BatchTimes`).
- When classification looks at a message for the first time and puts it in such a smart inbox, the message is held
  (`held_until` = the next batch time) when it is unread and was received after the last batch went out; older mail
  belongs to a batch that is gone and arrives as it comes, and so does an older message synced late into a
  conversation that is already in sight. A conversation the user placed themselves is never held.
  The conversation is delivered the way its newest incoming message is: held, from a batch (`batched_at`), or as it
  came. Held mail stays where the server has it; only Tresso's clients wait.
- Release: a delayed Messenger message (`ReleaseBatch`, transport `async`) for the batch time, dispatched after the
  commit, sets `batched_at` to the batch time and clears `held_until` on the user's due messages and conversations
  (500 of each per transaction, under the user's classification lock, so a run never holds what a release
  delivers). A Symfony Scheduler sweep every minute (`scheduler_batches`) releases what is due for every user, whether
  or not a worker leases their accounts, so a lost message only delays a batch.
- Delivered at once instead: a correction by the user (every held message of the conversation, so none arrives later
  with its batch), a smart inbox whose batch delivery is switched off (its held mail), a smart inbox that is deleted,
  and a reclassification that moves a held message to a smart inbox without batches. A new schedule moves all held
  mail to its next batch. Time zones are IANA names, the backward-compatible aliases browsers still report
  (`Asia/Calcutta`) included.
- Clients keep a held conversation out of every list and unread count (`summarizeConversation`: `inbox` and `active`
  are false while held). Held mail is not pushed: `MailNotifier`'s rule that a message needs the user now excludes
  it, so classification plans nothing for it and a push planned before it was held is dropped at delivery. When its
  batch comes, the release plans one push (`MailNotifier::released()`, through the same planning, previews setting
  and dispatcher as new mail) for released `do` and `delegate` mail that is still unread and in an inbox, however
  long ago it arrived; a batch that delivers more than three such messages notifies once with how many ("5 new messages
  to do", the senders when previews are on) and folds the others into it (`mail_notification.summary`,
  `summarized_by_id`), so none notifies later. At delivery the summary counts again the messages it stands for that
  still need the user, and goes out with that count unless none is left (with one left, it says what that message says
  and opens its conversation); a tap on it opens the batches (`/batches`
  on the web and on the phone, `summary` in the delta for the desktop app). Mail the user's own doing delivers early (a correction, a changed rule or smart inbox, batches
  switched off) is not pushed, as classification that runs again never is. The batches are a list of their own
  (`ListScope` `batch`): conversations a batch delivered that are still in an inbox, newest batch first.

#### One-click unsubscribe

- `POST /api/v1/unsubscriptions` with a `messageId` (scope `mail:send`) unsubscribes the account that received the
  message from its sender (the lower-cased From address). `App\Unsubscribe\UnsubscribeLink` reads the message's
  `List-Unsubscribe` and `List-Unsubscribe-Post` headers from `message_signals`, and only for an authenticated
  sender: the receiving server must vouch that DMARC passed (`SenderAuthentication`, the trust model above: a pass
  counts only in an Authentication-Results header the receiving server surely wrote, so never on a generic IMAP
  account). Anyone can write these headers; without that, a forged message could make the worker POST anywhere,
  have the user's account mail anyone, or mark the real sender as unsubscribed. An `https` address on port 443
  together with `List-Unsubscribe=One-Click` is a one-click request (RFC 8058), made by the worker (3.4); otherwise
  a `mailto:` address with exactly one recipient in the sender's own domain (the From domain, or a parent or
  subdomain of it) gets one fixed mail through the outbox, from the account, with "unsubscribe" as subject and text
  whatever the header asks for, and is done once that mail is sent, failed when it fails or is cancelled. Clients
  show that recipient and ask before it is sent (`unsubscribeMailto` in the delta). Since an IMAP account's
  authentication results are never trusted, its mail offers no button; the web client says so on the account in
  Settings > Accounts and in Settings > Batched delivery (`oneClickUnsubscribeAvailable` in `packages/core`) instead
  of leaving the button out unexplained. Other links are never followed:
  opening one is a GET of a page that may ask for more or track the reader. Mail in Spam is refused (422), since
  answering spam confirms the address is read; a message without either way, or from a sender DMARC did not confirm,
  is refused too and offers no button.
- Each request is an `unsubscription` (one per account and sender, `pending`, `done` or `failed` with a user-safe
  `error`), synced in the delta. Asking again while one is pending or done answers that one; after a failure it tries
  again, with the address of the newer message. Since only authenticated mail is answered, a forged message never
  creates the record that would hide the button for the real sender. Clients show the button on the conversation and in the batches
  (`unsubscribeOffer` in `packages/core`) and drop it while a request is pending or once it is done; the answer to
  the request is stored in the local copy at once (`noteUnsubscription`), unless the delta already brought that
  request.

#### Daily brief

Mail judged `know` asks nothing of the user, so it does not interrupt: once a day it comes together in a brief.

- **Settings** (`daily_brief_settings`, one row per user, made with the user; users from before briefs existed get
  theirs from an hourly backfill or when they first read them): on or off and a delivery time (HH:MM), read in the
  user's notification time zone (`notification_preferences.time_zone`, which devices keep current). Where the brief
  goes besides the app, which always shows it, is the notification preferences' channels for kind `daily_brief`
  (`phone`, `desktop`, `email`; none by default). `GET` and `PUT /api/v1/daily-brief-settings` (scopes
  `settings:read`, `settings:write`) read and replace the time, on or off, and those channels; the answer adds the
  zone, the digest address (the notification address) and `nextBriefAt`. `PATCH /api/v1/notification-settings` with
  `channelsByKind.daily_brief` changes the same channels, and a changed zone moves the next brief. New users get it
  on, at 08:00, in the app only.
- **Making it:** Symfony Scheduler sends `SweepDailyBriefs` every minute (transport `scheduler_daily_brief`, consumed
  by the messenger worker). The sweep claims users whose `next_run_at` passed (`FOR UPDATE SKIP LOCKED`, so sweeps
  side by side never make the same brief), at most 100 per minute, each in its own transaction. A brief holds the
  user's conversations whose verdict is `know`, with a message judged `know` in the period, received in the last 7
  days, and still in an inbox; at most 200, newest first. The period runs from the previous brief's end (the first
  covers a day, a long pause at most 7 days) to the second before the sweep: the sweep takes the user's
  classification lock first, so every classification stamped earlier has committed, and times are stored in whole
  seconds. An empty period makes no brief but still counts as covered. The next run is the next delivery time in the
  user's zone (a time the clock skips moves on as PHP moves it), and always on a later day than the one the last brief
  was due on (`last_due_day`; the day it was due, not the day it was made, so a 23:59 brief made after midnight leaves
  the new day its own): a
  time or zone changed after today's brief, a late sweep in the hour the clock repeats in autumn, or a second sweep
  that claimed the row as it was committed, makes no second brief that day. A user whose brief fails is logged and
  put off for 15 minutes, so the sweep goes on with the others; the moment it was due is kept apart (`due_at`), so a
  retry after midnight is still the brief of the day it was due on and the next day keeps its own. The hourly backfill goes on in batches of 500 users for
  at most 30 seconds.
- **Storage and sync:** `daily_brief` (owner, period, thread ids, made at) is a synced entity: the delta carries
  `dailyBriefs` and tombstones of type `dailyBrief`. Each user keeps the newest 14. Clients show a brief from their
  own copy (subject, newest sender and snippet, smart inbox, account), so it needs no endpoint of its own; a
  conversation of the brief is noted once the inboxes no longer list it, and moved once its verdict is no longer `know`
  (after "Needs me", a correction or a sender rule): a moved one counts neither as noted nor as left to note.
- **Noted:** one click marks a conversation read and archives it through the message actions (`POST
  /api/v1/message-actions`, `markRead` then `archive`); "Mark all noted" (Shift K on the web) does the whole brief.
  It never notes a moved conversation. The undo moves the messages back and marks unread what was unread. "Needs me" corrects the conversation to the To
  do smart inbox with verdict `do`, which is remembered for the sender.
- **Delivery:** a brief made for a user with channels queues `DeliverDailyBrief` after the commit (transport `push`),
  which reads the channels again when it runs. Phones and desktops get a push through the `NotificationDispatcher`
  (delivery key `daily_brief:{id}`, so a retry never notifies a device twice; Android channel `mail`; silent during
  quiet hours; it opens `/brief`). Email gets a digest instead of the generic notification email: the conversations
  per smart inbox with sender, snippet and a link, from the system sender (`NOTIFICATIONS_FROM`) with
  `Auto-Submitted: auto-generated`, to the notification address (the sign-in address, a provider-confirmed account address or an
  address the user confirmed by link; the sign-in address when the chosen one no longer counts). It goes out at most once: `emailed_at`
  is set under a row lock and committed before the mail is sent, outside any transaction; a refusal by the mail server
  clears it again for Messenger's retry, and a crash in between loses that digest rather than sending it twice.
- The brief shows each conversation's subject and snippet; AI summaries are planned (3.9).

### 3.8 Virus scanning

ClamAV's daemon (`clamd`) scans every attachment before it can be downloaded, forwarded or sent: received files and
files attached to drafts (uploads, and files a forward or reply takes along).

- **Queueing.** Every new `Attachment` and `DraftAttachment` queues a `ScanAttachment` job (naming which kind) once its
  transaction commits. Scans have their own Messenger transport (`scan`), and in the dev stack their own worker
  (`scanner`), so a backlog never delays outgoing mail or search. A dispatch can still get lost (the queue down at the
  wrong moment), and attachments stored before scanning existed have none: a sweeper (`SweepPendingScans`, every 5
  minutes on the `scheduler_default` transport, which the `maintenance` worker in Compose consumes alone, so a sweep
  never holds up outgoing mail) claims attachments never queued, then those still pending 15 minutes
  after their scan was queued, and queues one scan per distinct content. Claims are batches of `UPDATE ... SKIP
  LOCKED` along the `(scan_status, scan_requested_at)` index, repeated for up to 20 seconds per run, so several workers
  never queue the same ones and a backlog moves on every run.
- **Scanning.** `ClamdScanner` streams the content from object storage straight to clamd with `INSTREAM` over TCP
  (`CLAMAV_HOST`, `CLAMAV_PORT`), with a connect timeout (`CLAMAV_CONNECT_TIMEOUT`) and a read/write timeout
  (`CLAMAV_TIMEOUT`). Nothing touches the API's disk. Every scan first asks clamd for `VERSION`; a clamd that reports
  no signature database counts as unavailable, so a scanner without signatures never hands out a clean verdict.
- **States.** An attachment starts `pending` and ends `clean`, `infected` (with the matching signature) or `failed`
  (with a reason: `too_large`, `unscannable`, `unavailable`, `disabled`).
- **clamd configuration.** `docker/clamav/clamd.conf` sets `StreamMaxLength 25M`, equal to `CLAMAV_MAX_SIZE`, and turns
  on `AlertEncrypted` and `AlertExceedsMax`: clamd otherwise answers OK for encrypted archives and for content past its
  scan limits. Those alerts (`Heuristics.Encrypted.*`, `Heuristics.Limits.Exceeded.*`) are recorded as `failed`
  (`unscannable`), not as malware and never as clean. The dev stack and CI run clamd with this file, and CI tests both
  alerts against it.
- **Failures and retries.** An unreachable clamd, a timeout, an error reply such as out of memory, or content that is
  not in object storage makes the job fail and Messenger retry it (five times, from 5 seconds up to about 7 minutes
  apart). Once it gives up, the attachment is `failed`: `unscannable` when clamd kept answering with an error,
  `unavailable` otherwise. Only clamd's own size limit is final at once (`too_large`), as is content larger than
  `CLAMAV_MAX_SIZE`, which is not sent. `messenger:failed:retry` scans a failed attachment again. An empty
  `CLAMAV_HOST` turns scanning off: attachments become `failed` (`disabled`).
- **Recording a verdict.** A verdict applies to every attachment with that content (by the owner's content
  fingerprint, see 3.16, so per user), received or in a draft. It is written in bulk SQL under a lock per content, and
  only to rows it changes: a first scan or a cached verdict only settles attachments still `pending` or `failed`, a rescan changes only rows whose verdict
  differs, and a failure never replaces `clean` or `infected`. Only messages and drafts with a changed file become a
  change in the delta sync (and ping their owner's realtime channel); messages also get their summary updated. Locks
  are taken in the order every other writer uses: the drafts and messages (by id), then their attachment rows, then
  each owner's change counter (owners by id, drafts before messages), so verdicts and edits cannot deadlock in a
  circle. Only the attachments of the drafts and messages locked that way are written: the same file stored in the
  meantime stays pending for its own scan job, which records it and updates its message. A deadlock or other database error makes Messenger retry the job; a rescan that gives up stays in the
  `failed` transport for `messenger:failed:retry` rather than being dropped.
- **Cache.** Clean and infected verdicts are stored in `scan_result`, shared by all users but keyed with an HMAC of the
  content's SHA-256 so it links no users (see "Virus scanning" in 3.16), with the clamd engine and signature
  version (`ClamAV 1.5.4/28158/...`). A cached verdict is only reused while clamd reports that same version, so new
  signatures scan content again the first time it shows up, and mailing a file early cannot keep it clean later.
- **Quarantine.** The verdict is committed first; moving content follows in its own job (`PlaceContent`), which retries
  on storage errors while downloads already follow the committed verdict. It holds the same lock per content as
  recording a verdict while it decides and moves, so a quarantine and a release of the same file never interleave. Infected content moves from every live key
  (`attachments/<owner>/<ab>/<fp>`, `uploads/<owner>/<ab>/<fp>`) to `quarantine/<owner>/<ab>/<fp>` in the same bucket, still
  encrypted (the format binds the content, not the place): out of
  reach but kept, so it can be reviewed or released. When a rescan clears it, it is copied back to every key an
  attachment still refers to. The upload collector only ever removes `uploads/` keys. The raw MIME stays under `raw/`
  because the body needs it, but it is only ever parsed, never served.
- **The message flag.** Each message carries `attachmentScan`, the state of all its attachments together (inline
  images included): `infected` as soon as one is, then `pending`, then `failed`, else `clean`; null without
  attachments. Search results carry each attachment's `scanStatus` too.
- **Downloads.** Each attachment carries `access`: `allowed`, `scanning`, `confirm` or `blocked`. `clean` attachments
  are served, with `Cache-Control: no-store` so a later verdict takes effect on the next request. `pending` ones get no
  link, and an older signed link answers 409 with `Retry-After` until the scan is done: content is never served
  unscanned, also not right after deploying this (the sweeper scans what is stored; run `app:attachments:rescan --all
  --status=pending` to get through a large backlog faster). `infected` ones never: no link, 403.
- **Files that could not be scanned.** Password-protected PDFs and ZIPs, files over 25 MiB and archives past clamd's
  limits cannot be checked, but people still need them. They are neither silently served nor silently blocked:
  `access` is `confirm`, the listing has no link, and the clients show a warning with "Download anyway". Only that
  confirmed request (`POST /api/v1/attachments/{id}/unscanned-link` or `/api/v1/draft-attachments/{id}/unscanned-link`
  with `{"confirmed": true}`) issues a signed link, which carries the confirmation (`unscanned=1`, covered by the
  signature); the plain link answers 403. `ATTACHMENTS_REQUIRE_SCAN` decides whether this override exists at all: 0,
  the default, allows it; 1 makes such files `blocked` everywhere, for deployments that accept no unchecked file.
- **Fail fast.** `/health` reports `scanner`, from a clamd `PING` that waits a second at most so the unauthenticated
  check never ties up a worker: `ok`, `off` (no `CLAMAV_HOST`), `unreachable`, or `unconfigured`:
  `ATTACHMENTS_REQUIRE_SCAN=1` without a scanner, where no attachment could ever be opened. That last one answers 503,
  so a misconfigured deployment fails its health check instead of quietly marking every file as not scanned.
- **Drafts and sending.** A forward may take along a file that is still being scanned (the copy takes the verdict when
  it comes) or one that could not be scanned; an infected one is not forwarded, and neither is an unscanned one while
  scans are required. Sending waits until every file is clean: a pending one answers "still being scanned", an
  infected one is refused, and one that could not be scanned goes only with `acceptUnscanned: true`, which clients send
  after the user confirmed a warning (the refusal names the field, so clients know to ask). When the worker claims the
  message, the files are checked again: one found infected since (a rescan) fails the message and brings the draft
  back.
- **Rescans.** `bin/console app:attachments:rescan --all` (or `--user=<email>`, repeatable, optionally `--status=...`)
  queues one rescan per distinct content that skips the cache, in batches in content-hash order on a lower priority
  transport (`scan_rescan`), and prints how far it got; `--after=<hash>` continues an interrupted run. Current
  verdicts stay in force until the new one is in.

### 3.9 Planned features

Not built yet, and coming to this repository like everything else: AI classification and summaries (with your own
key or endpoint), teams on top of organizations (invites, assignments to teammates, internal comments, delegation
rules), webhooks, MCP tools for mail, todos and events (the endpoint, its settings tools and its WhatsApp tools are built, 3.2),
developer tools, statistics and Year in mail.

### 3.10 Clients

| Client | Stack | Local store | Push |
|---|---|---|---|
| Web (`apps/web`) | Vue 3, Vite, TypeScript, Pinia | IndexedDB | Web Push |
| Desktop (`apps/desktop`) | Tauri 2 (Rust) wrapping `apps/web` | SQLite via Rust | Native notifications |
| Mobile (`apps/mobile`) | Expo (React Native), TypeScript | expo-sqlite | APNs / FCM via Expo |

When the web client starts signed in, it asks the server who the user is (`/api/v1/me`) and then opens that user's
mail copy. The id the server last confirmed is kept in the same stored entry as the tokens (`userId` next to them, in
localStorage on the web and in the keychain value on the desktop), written only by the auth store and gone with them;
a refresh carries it over, a new sign-in starts without it. The copy of that user opens before the server answers, so
the mail is there when the app starts offline (the banner says the mail shown is kept on this device while Tresso
connects), but only to be read until the server confirms the same user: no pull, no realtime stream, and no request
that writes (a draft upload or delete, a message sent) goes out; drafts are still kept in the copy and go up once
confirmed. A sign-out meanwhile removes the copy, as its id came with the tokens signed out. When the server names
another user, the draft on screen, a hand-over and a followed bulk action are let go, that copy is closed and the
user's own opens; only then are copies other users left here removed (also copies of 0.7 and earlier that the list
of copies does not know, found through `indexedDB.databases()` and, on the desktop, the shell's `sql_list`, which returns only the names of the
mail copy files in its data folder). An answer to `/me` about a token set that was
replaced while it was asked is not taken; the server is asked again.
A start that fails (offline, the server down, the copy refused) says so with a Retry button and tries again by
itself: after 5 seconds, doubling up to 5 minutes, and at once when the device comes back online.

A signed-out visitor who follows a link into the app (a push notification opened in a new tab, a bookmark) sees the
sign-in screen; where they were going is kept in the tab (sessionStorage) across the trip to the authorization page,
and the app opens there once signed in. Only paths inside the app are kept.

The macOS app has a full menu bar (`apps/desktop/src-tauri/src/menu.rs`, described as data and tested for its order,
ids and shortcuts): Tresso (About Tresso, Check for Updates…, Settings… ⌘,, Services, Hide Tresso ⌘H, Hide Others
⌥⌘H, Show All, Quit Tresso ⌘Q), File (New Message ⌘N, New Event, New To-do, Close Window ⌘W), Edit (Undo, Redo, Cut,
Copy, Paste, Paste and Match Style ⌥⇧⌘V, Delete, Select All, Find… ⌘F), View (Inbox, Triage, To-dos, Calendar,
Search, Hide Sidebar or Show Sidebar ⌃⌘S, Reload, Enter Full Screen ⌃⌘F), Mailbox (Get New Mail ⇧⌘N; Daily Brief,
Waiting On, Drafts, Clean Up, Outbox, Batches), Message (Reply ⌘R, Reply All ⇧⌘R, Forward ⇧⌘F; Archive ⌃⌘A, Move to
Trash ⌘⌫, Move to…; Mark as Unread or Mark as Read ⇧⌘U, Flag or Unflag ⇧⌘L; Do, Hand Over…, Noted, Make To-do), Window (Minimize ⌘M, Zoom, Bring All to Front,
Tresso ⌘0) and Help (Tresso Help, the README; Release Notes, the releases page). The standard items are AppKit's own,
so they act on the focused web content; Paste and Match Style and Delete, which Tauri has no item for, are added
natively. Items that act in the web client reach it as the `menu` event with the action's name, handled in one place
(`apps/web/src/platform/menu.ts`), and are enabled through the one command `menu_state` while someone is signed in
(the state lib.rs manages once, which the bar's setup fills); the same command names the sidebar item after what it
would do (Hide Sidebar while the sidebar shows).

Get New Mail pulls now (the mail store's `syncNow`). Mailbox's places are the sidebar's fixed places that View does not
list already; Outbox is enabled only while the sidebar lists it (while mail waits in it); smart inboxes and accounts are
the user's own and get no items. The Message menu acts on the conversation open in the reading pane: the pane offers its
own actions while it is mounted (`mail/openConversation.ts`), so an item does exactly what the pane's button or key does,
undo notice and instant change included. Reply, Reply All and Forward take the newest message, as its own buttons do;
Move to… opens the pane's folder menu; Mark as Unread is U (back to the list), Mark as Read reads what is unread, and
which of the two is decided once the read on opening is done; Flag and Unflag are S; Do, Hand Over…, Noted and Make
To-do are D, H, K and T (Make To-do is disabled once the conversation has a to-do). The items and the pane's keys share
one check of the user's attention (ReadingPane's `attentive`): the conversation is loaded, nothing is being written in
the compose window (open and not minimized), no modal dialog (a modal `<dialog>`, an alert dialog, a modal element with
the dialog role, none of them inside the compose window, whose own questions stay in the page while it is minimized;
the page is read again whenever one comes or goes, also without a focus move) and not the folder menu is open, no conversations are selected in the list, and no hand-over is being
written. So the whole Message menu is disabled while composing. It is also disabled while the window is closed (hidden)
or minimized (the page is not visible), and a Message item chosen then only brings the window back (`delivery` in
menu.rs): the conversation the window held is never acted on unseen. `menu_state` names Mark as Read or Unread and Flag or
Unflag after the conversation.

Two Message shortcuts are also text keys: ⌘⌫ deletes to the start of the line, and ⇧⌘U underlines in the composer.
Which sees a key first, the menu or the page, is not relied on. AppKit asks the menu for key equivalents, but wry hands
`performKeyEquivalent:` to WKWebView, and WebKit may give the key to the page first and send only what the page left
alone back to the menu. When the menu comes first, the two items are disabled while a text field or the compose window
has the focus (`platform/editing.ts` follows the focus, and reads it again after every navigation and once the compose
window is gone), so the key goes on to the text. When the page comes first, the text field takes the key, and should it
still reach the menu, the web client reads the focus again when the action arrives and does nothing while it is in
text. A menu test keeps every other shortcut off the text keys. The web client sends `menu_state` once per change of
what it says, never per key or per scroll: changes in one tick go together, a change that ends where it began (the focus
moving between fields, a sync reloading the open conversation) sends nothing, and a state counts as sent once the shell
took it (a refusal is tried again at once, then once more after a few seconds, so the last state of a quiet moment is not
lost). The shell changes all items in one task on the main thread, goes on past an item it cannot change, and refuses a
state it could not follow in full, so the web client sends it again. Not in the menus,
because the web client has no such action: Snooze, Mark All as Read, Next and Previous Message, and Sent, Archive and
Trash as places. Reload acts signed out too, and only after the draft is
saved and nothing is on its way, as before a restart for an update (one at a time: a second Reload while one waits is
the same one, and "Later" ends it); it has no ⌘R, which other mail apps use for Reply.
Closing the window hides it and the app stays in the Dock; the Dock icon and Window > Tresso bring it back, and so do
a click on a notification (`show_main_window_command`), a `tresso://` link (the sign-in coming back), a second launch
and Sparkle's question before a relaunch, each through the shell. The view
switches have no shortcuts, because the web client has none for them. Windows and Linux keep no menu bar, as before.

#### The desktop window frame

The desktop app (every system) draws its window frame after a window spec shared by the owner's Mac apps (measured on
macOS 26 in light mode). Every number of it is a token in one file, `apps/web/src/assets/frame.css`, which also says
which values are chosen where the spec has none; `apps/web/src/platform/frame.ts` reads the sidebar's widths from it.
The web client knows it runs in the desktop app through Tauri (`platform/desktop.ts`, `isDesktop`) and on macOS through
the user agent (`platform/vibrancy.ts`, `vibrant`); `main.ts` sets `html.frame` (desktop) and `html.vibrant` (macOS),
and AppShell sets `.frame-shell` on its layout and `html.frame-shell` while the signed-in shell shows. The browser build
sets none of them, so its layout, markup and classes stay as they were (a snapshot test keeps the browser's shell and
sidebar markup).

- **Sidebar.** A column 190 to 300 wide (220 at first): the card 8 from the window's left, top and bottom edge, radius
  18, a 1 pt lighter edge and a soft shadow, 10 to the content. Rows are 32 high from y 52, the selection fill 10 inside
  the card with radius 8, the icon at x 30 and the label at x 54, the count inside the fill; a group label sits in a 24
  strip, an unlabelled group is set off by 13. The profile, the Compose button and the account rows (two lines) keep
  their own heights. Only the rows scroll (`FrameScroll`, rendered in the desktop shell only): the band of the traffic
  lights and the toggle stays above them and the sync status at the card's foot. The selected row takes the system's selection colour with white text while the sidebar is used
  (the last click or focus went into it and the window is in front), and a grey fill while the content is or the window
  is in the back.
- **Width and collapse.** The card's right edge is a drag handle and a focusable separator (arrows by 10, Home and End
  to the limits); the toggle (the `sidebar` icon, after the system's sidebar.left, named "Sidebar" with
  `aria-expanded`) sits on the traffic lights' line 13 from the card's edge and hides the sidebar, taking the focus when
  it was in the sidebar or on its edge, as does View > Hide Sidebar (⌃⌘S). Width and state are kept per device in
  localStorage (`tresso.sidebar`, `stores/frame.ts`). Hiding slides the card out in 220 ms (none with reduced motion);
  the toggle then sits right of the traffic lights (macOS, x 105) or at the window's left (x 26), and the title moves
  right of it.
- **Title strip.** 52 high over the screens, without a line: a screen's title (`FrameTitle`, its h1 in 15 px
  semibold, an optional 11 px subtitle) from 10 right of the content's edge, and its toolbar (`FrameTools`) at the
  right, actions grouped in 36 high capsules (`FrameCapsule`) ending 8 from the window's edge. Outside the desktop shell
  these components render the h1 and the actions in place, unchanged. Search and Triage have a title in the strip only
  (`framedOnly`): Search's field stays above its results, and Triage keeps the subject as its heading. The strip moves the window on macOS
  (`data-tauri-drag-region="deep"`, which also zooms on a double click), except over its controls. When the actions do
  not fit, they wrap under the title and the strip grows. The content starts below the strip rather than scrolling
  under it, as the page has no scroll edge effect to keep the title readable over moving content.
- **Selection colour.** The shell reads AppKit's `selectedContentBackgroundColor` (the accent colour the user picked,
  made deep enough for white text: #0064e1 for blue) in the light and the dark appearance (`selection_accent`,
  `accessibility.rs`); the web client sets them as `--frame-accent-light` and `--frame-accent-dark` at launch and when
  the window comes back, as it does for "Reduce transparency". Windows, Linux and a failed read use #0064e1.
- **Window.** 1240 x 780 at every launch: the app keeps no window state, so a size the user set lasts until it quits.
  The traffic lights' inset (17.5, 27.5, a token in frame.css next to the others) is the one a test app measured on
  macOS 26.7 for centres at x 25.5, y 25.5; the corner radius is the system's.
- **Material.** Before macOS 26 the window is see-through with the system's sidebar material behind the page (the card
  over it, a little translucent); "Reduce transparency" turns the card solid. Dark mode keeps Tresso's own colours:
  only sizes, radii and positions change there. Windows and Linux use the same sizes without the traffic lights, on a
  solid window colour.

##### Liquid Glass behind the sidebar card (macOS 26 and later)

On macOS 26 and later the shell puts one system `NSGlassEffectView` under the web view, exactly where the card is
(`apps/desktop/src-tauri/src/glass.rs`): the window paints an opaque background instead of the whole-window material
(the spec's #f3f3f3 in the light appearance, AppKit's `windowBackgroundColor` in the dark one), the page leaves the card see-through (`html.liquid-glass`), and the content paints its own
opaque background. The card stays solid until the shell has answered that the glass is behind it (at launch, after a
sign-in, when the sidebar is shown again), so the bare window never shows through. The page reports the card's place with `set_glass` (`apps/web/src/platform/glass.ts`): once it shows,
when the window or the card changes size, and every frame only while the card slides or its edge is dragged; a hidden
card, the sign-in screen and "Reduce transparency" send an empty list, which removes the glass (the card is then drawn
solid). The shell checks every shape (finite numbers, sizes from 0 to 100 000 points, at most four, ids of a to z, 0 to
9 and hyphens), keeps one view per id on the main thread, turns page coordinates into AppKit's (scaled by the content
view's width over the page's, so a zoomed web view still fits, and counted from the bottom) and removes views no longer
listed, and all of them when a new page loads (a reload). Hidden windows keep their views; full screen and resizes
report again. The class is looked up at run time, and it must answer every message sent to its views, so macOS before
26 (or a changed class) answers `supported: false` and keeps the look above unchanged; so do Windows and Linux. Whether
the glass is on is decided once at launch and kept until the app quits. In dark mode the card is the system's glass
over the dark window colour, not Tresso's dark card colour.

Known risk: tauri-apps/tauri#14454 reports AppKit aborting on macOS 27 in packaged apps that combine WKWebView with
`NSGlassEffectView` during a native resize (not reproduced on macOS 26.7). The glass can be turned off without a new
release: `defaults write app.tresso.desktop DisableLiquidGlass -bool YES` (undo with `defaults delete
app.tresso.desktop DisableLiquidGlass`), or start the app with `TRESSO_DISABLE_GLASS=1`; both are read once at launch
(a reload does not change it), and the window then keeps the whole-window material.

The desktop app runs the web client unchanged; only signing in and keeping the tokens go through the shell
(`apps/web/src/platform/desktop.ts`). It is its own OAuth client (`desktop`) with the redirect URI
`tresso://auth/callback`: sign-in opens the authorization page in the system browser, where the user's password
manager and existing sessions work, and the operating system hands the `tresso://` link back to the running app
(single instance on Windows and Linux), which exchanges the code with its PKCE verifier. "Open the browser again"
opens the same authorization page, so whichever browser tab the user finishes in completes the sign-in, and a link
whose state is not the pending sign-in's leaves that sign-in pending. The window handles each link once: the link
that started the app is not handled again after the window reloads (the handled links are kept in sessionStorage),
and an answer to signing in to Tresso while no sign-in is under way (one finished already, or a stray link) is
ignored. Tokens are kept in the OS keychain (Keychain, Credential Manager, Secret Service) by Rust commands
(`apps/desktop/src-tauri/src/tokens.rs`), never in web storage, and read back before the first screen. The Credential
Manager holds at most 2560 bytes per entry, less than the token set, so on Windows the value is split over several
entries behind a header entry; a save writes a second set of entries and switches the header last, so a save that is
cut off leaves the previous sign-in whole, and sign-in values kept as one entry by earlier versions still load. The
keychain commands run off the main thread (the window keeps drawing while the OS asks the user to unlock the
keychain), one at a time and in the order the client asked for them; a keychain that was not ready at the first call
(the Secret Service right after login) is tried again on the next one; and quitting waits up to five seconds for a
save that is running, so a token set the server just rotated is not lost. When the keychain refuses, the app says
that the sign-in will not last instead of failing quietly. The API and the Mercure hub accept the app's origins
(`tauri://localhost`, and `http://tauri.localhost` on Windows), and the main window may only open http(s) pages in the
browser and read the link it was opened with. The shell's own commands (keychain, mail copies, menu, updates,
WhatsApp) are listed in an app manifest (`apps/desktop/src-tauri/build.rs`), so Tauri checks each one against the
capability files: only the main window may call them, a remote page never, and the WhatsApp commands only on macOS. A
page in the window that asks for a new window (a link in a mail body,
whose frame sends every link to a new window, or `window.open`) gets none: http, https and mailto links open in the
user's browser and mail app, anything else is refused. Opening an attachment and joining a meeting call the browser
directly, since the app has no tabs and must not leave its own page. The window's Content-Security-Policy lets the
local servers the sign-in screen accepts (`http://localhost`, `http://127.0.0.1`) serve images as well.

The web client keeps its tokens in `localStorage` (`apps/web/src/platform/tokenStorage.ts`): one sign-in serves every
tab of the origin and outlasts closing the browser, until the user signs out (one user per browser profile). A tab
from before this kept them in `sessionStorage`; they move over at the next page load. A token refresh runs under a Web
Locks lock that all tabs share (`tresso.auth.refresh`), and inside it the tab reads the stored set again first: when
another tab refreshed meanwhile it takes that set instead of refreshing with a rotated token. A `storage` listener
brings a sign-in, refresh or sign-out of one tab to the others; a tab whose user changed under it reloads. A browser
without Web Locks refreshes without the lock, as a single tab does. A refresh waits up to 60 seconds for the lock (a
healthy holder needs at most 42); after that, or when the browser refuses the lock, it goes on without it. That keeps
the app usable when a tab the browser suspended in the middle of its refresh holds the lock, at a price: when the
holder's timers stood still, two tabs can refresh with the same token at once, and the one the server refuses ends the
session as expired in every tab. The mail copy and its drafts stay, and signing in again is one click (the sign-in
pages still remember the browser).

A sign-out removes the tokens from the device first, so it holds at once in every tab (the storage event), and only
then tells the server, within 6 seconds in all and with the tokens taken before they went, so nothing the sign-out
does can refresh: first it stops this browser's pushes (up to 2.5 seconds), then it revokes the refresh token, which
also ends the access token the push calls need. A refresh anywhere
that finishes after the tokens are gone, also one this tab started before the sign-out, drops its answer and revokes
it. While a sign-out runs its button says so; drafts on the device that never reached the server are asked about first (try to save them, sign out anyway, or cancel), also when the copy is not open (it is opened to look), and when they cannot be checked the question says so and offers only signing out anyway or cancel; a failure is shown, and a mail copy that could not be removed is named on the sign-in screen, marked in `tresso.mail.copies` and removed at the next start. Signing out also ends the browser session of the
sign-in pages, remember-me cookie included, by submitting a top-level form (POST) to `/logout` on the sign-in address;
the server accepts it for the app's origin and sends the browser back to the app. The form is sent only when the
sign-in pages answer, as it would otherwise leave the user on the browser's error page: on the API's origin the
revocation's outcome tells, on the app's own origin (Tresso Cloud, where a proxy serves them) a GET of `/logout`
tells, and another address cannot be asked (the CSP allows no connection to it), so the form goes there. When they did
not answer, the browser is still signed in there: the device remembers it, the sign-in screen says so with a link to
the sign-out page, and the next start of the signed-out app sends the form once they answer (not while a sign-in is
being completed, and not when one completed meanwhile: that fresh session replaces the old one). Until then the next
sign-in asks for the password (`prompt=login`); a browser that refuses storage loses both marks, and someone at that
browser who removes `prompt=login` from the authorization address gets in without the password.
The desktop app does not open the system browser to sign out: the sign-in pages may still remember that browser, which is why its next sign-in asks for the password (`prompt=login`, above). The
sign-in pages may live on another address than the API (`TRESSO_AUTH_URL`, `VITE_AUTH_URL`); `/oauth/authorize`
and `/logout` go there, the token and revocation endpoints stay on the API address. Because a script injected into
the page could read the tokens, the web image sends a Content-Security-Policy (`docker/web/Caddyfile`). When keeping
the tokens fails (the keychain refused, the browser's storage is full or blocked), the signed-in app says so in a
notice; the sign-in screen says so for a failed read at launch.

The desktop app keeps the mail copy in SQLite instead of the web view's IndexedDB (`apps/web/src/mail/store.ts`
picks the store). Rust commands (`apps/desktop/src-tauri/src/sql.rs`, rusqlite with SQLite bundled) open one database
per user in the app's data folder with two connections: one writes, one reads, in WAL mode, so the lists read the last
committed state while a page of the delta is stored. The commands run off the main thread, so the window stays
responsive while SQLite works or waits. The client queues its writes, so the writer never meets another one; a
transaction a failed write left open is rolled back before the next one begins. A web view that reloads leaves handles
behind; opening the same copy from the new page load drops them, rolling back what they left open, while overlapping
opens of one page load keep their handles. Sign-out closes the copy and then deletes its files, refused while any
connection (a read still running) uses them; a delete and an open of the same file never interleave. A sign-out while
the copy is still opening waits for it to be closed again before deleting it. The first time the desktop app opens a user's copy,
drafts that exist only in the old IndexedDB copy (unsaved edits, messages whose outcome is pending) are carried over,
each removed from the old copy once moved, and then that copy is removed.

The desktop app notifies natively about mail that needs the user. Which mail that is, and when, the server decides
(see "New mail" under Reminders and notifications): the app shows the mail notifications the delta brings
(`mailNotifications`) that were delivered to the desktop channel, so it follows the user's channels, holds and quiet
hours, and the phone and the desktop never disagree about a message. `apps/web/src/mail/mailNotifications.ts` picks and
words them. Nothing pops up for what the first pull after start brings, while the app has focus, or for notifications
delivered more than 15 minutes before notifications were switched on (a copy rebuilt, a device that was offline); each
is shown once, and more than three at once become one summary. A click brings the window to the front and opens the
conversation (`/thread/{id}`), through the notification plugin's action listener, which the main window may register,
unminimize and focus for; the window mounts without waiting for that listener, and one that cannot be registered is
reported. The app plays a system sound only for notifications that did not come silently (quiet hours, busy). Hand-overs
past their due date (3.15) come the same way: the app shows those the server delivered to the desktop channel. It
never subscribes to Web Push itself, but a browser on the same computer can: the settings page says to leave browser
notifications off there, or each one comes twice.

Browsers get Web Push from the server. Settings > Notifications turns it on per browser: the browser asks the user,
subscribes with the server's VAPID key and registers as a `web_push` device (and turning it off removes the device and
the subscription). Signing out removes the device and drops the subscription (the server also removes a device
when its next push to a dropped subscription fails as gone). An expired session keeps them, as a closed tab does: the
user did not sign out, and signing in again finds notifications on. Another user signing in drops a subscription
someone else turned on. The service worker also keeps who turned notifications on (Cache Storage, shared with the
page) and shows a push only when its `userId` is that user; any other, or one without a `userId`, shows nothing of it
and unsubscribes. A service worker (`apps/web/public/push-worker.js`) shows the pushes, also while no Tresso tab is
open, and a click opens what it is about in an open tab (which routes there itself) or in a new one. The same page
chooses where new mail notifies (phone, desktop and browsers, email: `channelsByKind.mail`) and whether meetings hold
it (`holdMailInMeetings`). `/thread/{id}`, where every mail notification leads, opens the conversation in the Unified
Inbox.

The mobile app (Expo Router, screens in `apps/mobile/src/app`) is the `mobile` OAuth client with the same redirect
URI. expo-auth-session opens the authorization page in the system's authentication browser
(ASWebAuthenticationSession on iOS, Custom Tabs on Android) with PKCE and checks the state; the code is exchanged
through `packages/core`. The page it opens is the `authorization_endpoint` the server names in its authorization
server metadata (`/.well-known/oauth-authorization-server` on the API), so a server with a separate sign-in address
(`AUTH_PUBLIC_URL`) is followed; when the metadata cannot be read, the app opens the API's `/oauth/authorize`, which
sends the browser on. The token and revocation endpoints stay on the API. `Session` (`apps/mobile/src/auth/session.ts`, plain TypeScript, unit tested) keeps the tokens
in expo-secure-store (Keychain on iOS, Keystore-encrypted on Android) as three entries, because some iOS releases
refuse values above about 2 KB, refreshes them before they expire with one shared request (refresh tokens rotate),
and never lets a refresh that finishes after sign-out sign the user back in. A save writes the refresh token first and
the expiry last, so one cut off at any step still loads with the newest refresh token. As of this release it renews
by the same rules as the web client and the desktop app (section 3.2): only an `invalid_grant`,
`invalid_request`, `invalid_client` or `unauthorized_client` answer of `/oauth/token` ends the sign-in (the rule
of `refreshRefusalEndsSession` in `packages/core`, shared by all three clients); offline, a
timeout (20 seconds for the whole answer) or a server error keeps the tokens and the next request tries again, and a
lost answer is asked for once more after 2 seconds. A 401 from the API renews the token once and asks once more before the
sign-in ends. A sign-in that ends this way has expired: the tokens go, but who was signed in and their mail on the
phone stay, so unsent drafts are still there when they sign in again. Only a sign-out the user asks for revokes the
refresh token at the server (`/oauth/revoke`, best effort, waiting a few seconds at most) and removes the mail on the
phone. It also leaves a flag in the secure store (it survives a restart and is cleared once a sign-in completes): the
next authorization request carries `prompt=login`, so the user types the password again whatever session the browser
holds (the server remembers sign-ins and approves its own apps without a page, so otherwise "Sign in" would go
straight back in as the same user). A sign-in after an expired one does not ask, and when the store cannot say, the app
asks. A sign-out takes effect at once, before the revocation: a request made meanwhile finds no tokens and starts no
refresh. The flag is written first, so a sign-out cut off after that (the app killed) is finished at the next launch:
the tokens are removed and the sign-in ends as signed out, which removes the mail too. The store's writes run one
after another, so a removal never lands between the steps of an earlier save. Tokens of a sign-in made here are kept
only once the previous user is forgotten and the flag cleared; while that fails, every refresh tries again before it
saves, and an expiry clears the flag. Accepted: when the flag can be cleared neither then nor at the expiry, the store
never held that sign-in, and the next launch takes the flag for the sign-out before it, so the mail of that sign-in
goes with it. A sign-in that completes while a sign-out is still finishing wins: the sign-out removes nothing once new
tokens are there. A launch that finds the flag also removes what a sign-out cut off inside the removal left behind (a
refresh token, revoked first as far as the server can be told, or the last user), even when no complete set loads. Asking for the server's metadata gives up after
5 seconds and signs in at the API address. A store that cannot be read at launch removes nothing either: the app says so, offers Try again, and reads it
again whenever it comes to the front.

Mail on the phone: the mobile app keeps a SQLite copy (expo-sqlite, one database per user) of
the mail accounts, folders, threads and messages from the delta, with a summary per thread as the web client does
(`summarizeConversation` in `packages/core`), each page applied in one exclusive transaction. The same `SyncEngine`
pulls it and the same `RealtimeClient` triggers pulls while the app is in the foreground; in the background the
connection rests and the copy catches up when the app comes back. `MailSession` runs this lifecycle one switch at a
time, awaiting every step: a copy is deleted only after it is closed (on sign-out, or when another user signs in),
and a small index database lists every copy on the device, so one that could not be deleted is removed the next
time. When nobody is signed in because the sign-in expired or could not be read, the copy is closed and kept; only
copies marked for removal by a sign-out or a switch are removed then. The last signed-in user is remembered, so after
a launch their copy opens before the server confirms who is signed in, also offline; a new sign-in forgets them first
and opens a copy only once the server said who it is. The copy is the same `SqliteMailStore` the desktop app uses (see below). Message bodies show in a web view with the same Content-Security-Policy as
the web client's frame; only links the reader taps open, in the browser, and remote images load only when the
reader asks. The view's script reports a tap on a link instead of following it, and the app opens only web, mail and
phone links (`apps/mobile/src/components/frameLinks.ts`); a link to a place in the same mail scrolls the screen there.
The app refuses every navigation away from the document, which also covers Android, where a navigation cannot tell a
tap from a redirect. On Android react-native-webview allows a navigation when the app's answer takes longer than
250 ms, so a page could load in place of the mail anyway. Two things keep such a page from reporting: every report
carries a random token the app puts into the script it injects, a new one for every document the view is given (the
mail cannot run script, so it cannot read or send it), and the view drops every report with a document's token once it
starts loading anything other than that document. The sender the
platform names is not used: Android names an origin, and a sandboxed page has the same opaque origin as the mail. The web views' `originWhitelist` passes
everything, because react-native-webview opens a URL that misses it outside the app before the app is asked. Opening a conversation on the phone reads it, and its action bar archives, trashes, marks unread and
flags it, with the same exact undo as the web client: the way an action changes messages (`actionResult`) and how to
undo it (`undoPlan`) live in `packages/core`, and `MailSession.act` applies it to the copy first and puts back what
the server did not take.

Writing mail on the phone works as on the web, through the same code in `packages/core`: `Composer` (autosave and
upload, sending after a few seconds so "Undo" can stop it or at a chosen time, conflicts with another device, and what
became of a sent message, announced once), `DraftSync` (one upload per draft at a time; another device's newer version
is never overwritten) and the helpers for replies, forwards, send-later times and the send request. The web client's
Pinia store and the phone's `ComposerProvider` only wrap it. The compose screen (`apps/mobile/src/app/compose.tsx`)
has the sending account, recipients as chips with suggestions from the people in synced mail, Cc and Bcc, the subject,
the signature (changeable, following the account) and the quoted original kept apart from the text. The text is
written in tiptap, as on the web, running in a web view: `apps/mobile/editor/editor.ts` is bundled by
`npm run build:editor` into a generated module (CI checks it is current) and talks to the screen through JSON messages
(`editorProtocol.ts`); its page has a Content-Security-Policy that allows no connection, and links may only be web
and mail addresses. Leaving the screen keeps the draft; Cancel asks whether to keep or delete one with content.

WhatsApp on the phone (`apps/mobile/src/chat`, the chat screen `apps/mobile/src/app/chats/[id].tsx`): the phone shows
only the chats the server holds, so only while the user's WhatsApp is set to "All my devices" and a Mac relays it
(3.17); without a WhatsApp chat account in the copy (none, or "Only this Mac") it shows nothing of WhatsApp. The chats
come with the delta into the same copy. Chats of the Unified Inbox (core's `inInbox`) are rows among the mail by the
time of their last message (`mergeInbox`), with a WhatsApp badge and the unread dot. A chat is read in windows of 50
messages (`MailStore.chatPage`): the newest first, older ones as the list reaches its top, and the window again from
its first message when the copy changes. Bubbles follow core's `timeline` (a reply the bridge stored too shows once),
with day rows, group senders in their colour, and files as their kind and size only: the phone downloads nothing and
says to open the file on the Mac. A reply is queued with `POST /api/v1/chats/{id}/outgoing` under a UUIDv7 the phone
made by the server's clock (`Session.serverNow`, so a phone whose clock is off is not refused); it shows as waiting at
once (held in memory, not in the copy, so a closed app leaves no reply the server never got), the server's answer is
stored, and a refusal takes it back and puts the text back in the box. A request without an answer, a 408 or a 5xx may
have been queued: the box says so, and the same text sent again in that chat within 9 minutes goes under the same id,
which the server answers with the reply it has. That id is kept in the copy's chat values with a hash of the text (not
the text), so it is reused after the app was closed too, and forgotten once the delta brings that reply. A long press cancels a waiting reply or deletes one that was not sent (after a
question); a tap on one that was not sent tries it again; one the Mac could not confirm (`unconfirmed`) is sent again
only by its own Try again. Nothing resends by itself. Opening a chat while the app is in front reads it in Tresso
through its last message (in the copy first, then `PATCH /api/v1/chats/{id}`; the copy goes back when the server does
not take it, and that read is not asked again for the same last message until the chat is looked at again, and never
before the server's `Retry-After`). A banner says when the relaying Mac is offline (`relayOnline`), WhatsApp is not linked or the bridge
does not run, from the chat account's row. Drafts of replies stay in memory per chat while the app runs. Nothing of a
chat is logged.

Push on the phone (`apps/mobile/src/notifications`): at every launch the app creates the Android channels the API's
pushes name (`reminders`, `mail`, `whatsapp` and their `_silent` twins). Once signed in, it asks the user for permission and
registers its Expo push token as an `expo` device, again when the token changes; the token needs the EAS project id
in the build (`extra.eas.projectId`, which `eas init` writes to `app.json`), and without it the app says that this
phone cannot get notifications. A sign-out removes the device first, so the user's notifications stop coming; when the
server cannot be told, the app signs out anyway and says so (the next sign-in on the phone takes the device over). A
tapped notification opens the screen its path names when the phone has it (`tappedRoute`: a conversation
`/thread/{id}`, a WhatsApp chat `/chats/{id}`, the daily brief `/brief`, the todos `/todos`); other paths (a calendar event) open the app as it is. While the app is open, mail and WhatsApp messages go to the list without
a banner or sound (the user is in the app already), and reminders show as a banner unless they came silently. A
conversation opened from a notification before the delta brought it shows as loading, pulls once, and says it is
gone only after a pull that completed; when that pull fails (offline) it says it could not be loaded, with Try again
(the web client does the same).

Shared TypeScript lives in `packages/core`: domain types, the OAuth flow, and the client side of the sync
protocol, so every client syncs the same way:

- `SyncEngine` pulls the delta into a `SyncStore` (each page and its cursor in one transaction). Pulls never overlap;
  a request during a pull makes it go round once more. A pull that failed is tried again by the engine itself after
  2 s, 5 s, 15 s and then every minute until one works (not after a 401, 402 or 403, nor while the copy closes), so
  "Sync stopped" does not stay on a quiet mailbox until the next realtime notification. Each delay is spread by a
  fifth either way, so clients that failed together come back apart, and never shorter than a `Retry-After` the server
  sent (`retryAfterMs` on the clients' API errors; the API exposes the header to browsers). The clients run the retry
  through their own pull, which shows it like any other, and stop the engine with the copy. A `Retry-After` is honoured
  for at most an hour. `wake()` runs a waiting retry at once unless the server asked to wait: the web client calls it
  when the browser goes online and when the tab becomes visible, the phone pulls whenever the app comes to the front,
  and the web banner has Try again, which pulls whatever the server asked.
- `RealtimeClient` reads the hub through `fetch()` with the token as bearer, reconnects with backoff, renews the token
  before it expires, and asks for a pull on every (re)connect, because missed notifications are not replayed. The
  token's `expiresAt` is the server's time, read against the server's clock as the client knows it (`ServerClock`),
  and a token is used at least 30 s before it is renewed whatever the clocks say (otherwise a clock that runs ahead
  makes every token look expired and the client asks for tokens in a loop); a renewal before the hub even answered
  waits a moment before the next try. A stream that stays silent for two and a half of the hub's heartbeats is taken
  for dead and opened again, since a connection lost without being closed (a laptop that slept, a proxy that dropped
  it) never ends a read. The token answer says the heartbeat (`heartbeat`, seconds, from `MERCURE_HEARTBEAT_SECONDS`,
  which the Caddyfile gives the hub too; 40 by default); without it the client takes 100 s, and with a heartbeat of 0
  only the token renewal ends a dead stream. It says when a connection is being made (`onConnecting`), but not when it
  only renews its token, which reopens the stream at once.
- Every client opens the stream together with the first pull of a copy, not after it. The stream only carries cursors,
  which make the engine pull again; pulls never overlap and a notification during one makes it go round once more, so
  nothing is lost or stored twice, and the copy is live the moment the pull is done.
- One sync status for every client (`packages/core/src/sync/status.ts`): `SyncStatusMachine` keeps what a client
  knows (the copy opening or open, the sign-in confirmed, the engine's `PullProgress`, the stream, the network, the
  last completed pull, an error) and `describeSync` says it in words, with a fraction when the server gives one:
  "Opening your mail…", "Showing mail kept on this device" (before the sign-in is confirmed), "Getting your mail, 62%"
  (a copy that never synced), "Updating your mail on this device after the update, 25%", "Catching up: 12,400 changes
  to go" (a pull that began more than `BEHIND_CHANGES`, 1,000, change numbers behind, or of more than one page after
  `STALE_AFTER_MS`, 30 minutes, away), "Checking for new mail…" (a pull whose first page has not answered yet, for
  a copy not known to be current: never synced, or not for longer than `STALE_AFTER_MS`, as after a laptop woke up;
  not announced; a copy synced a moment ago stays "Up to date" through the short pulls of notifications and writes), "Up to date" (a live stream, also when the device says it is offline), "Connecting…" (one text, said
  once, until the stream is live for the first time), "Reconnecting… Last synced 14:02", "Offline. Last synced 14:02"
  and "Sync stopped. Last synced 14:02". The banner ("Sync stopped: " and the reason) reads the same status
  (`problem`), so the two never disagree; a copy that could not be opened says so there too. The failure stands until a
  retry stores a page or a pull completes, so a dismissed banner stays dismissed across retries that fail again; a
  failure after that is news and shows again. A copy that finished a
  pull before is never a new device again, also at cursor 0, and the fraction of one sync never steps back. A
  notification at or below the stored cursor pulls nothing and proves nothing (`notify` resolves false): it neither
  clears a failure nor notes the copy as synced; after a failure every notification pulls. From a server that sends no `latest` the status counts
  the items stored so far ("Syncing… 1,240 items so far"). While a sync is under way, or a copy that cannot sync has
  not synced for 30 minutes, the mail lists show a quiet notice that what they show may be out of date. The web and
  desktop clients show the status at the foot of the sidebar, with a thin progress line when the fraction is known and
  a polite live region that speaks per quarter; the phone shows it under the inbox's title. The phone has no network listener, so it never says "Offline"; a lost
  connection shows there as "Reconnecting…". The engine notes every
  completed pull in the copy (`markSynced`), so "Last synced" holds after a restart.
- `mailFrameDocument` wraps a sanitized body in the document for the sandboxed frame, with its Content-Security-Policy.

Every client keeps a copy of the user's mail behind one interface, `MailStore` in `packages/core`: the browser in
IndexedDB (`apps/web/src/mail/db.ts`), the desktop app and the phone in SQLite (`SqliteMailStore` in
`packages/core/src/store/sqlite.ts`, behind a small `Sql` interface each client implements). One database per user,
deleted after it is closed when the user signs out. A session that expired, or that ended in another tab, only closes
the copy: it may hold drafts that never reached the server, and they upload when the same user signs in again. The
web and desktop clients list the copies they keep (`apps/web/src/mail/copies.ts`); when another user signs in, the
copies of the previous ones are deleted. The browser's copy closes when another connection needs it gone or upgraded
(a sign-out or a newer version in another tab), so a delete or upgrade never waits on it. The tab then never fails
quietly: after an upgrade elsewhere it stops and says to reload (its code cannot open the newer copy), and after a
delete elsewhere or the browser closing the copy (site data cleared) while it is still signed in it opens a fresh copy
and syncs it again. Calls
on a copy closed like this say the copy is closing instead of failing on a dead connection. Next to the synced records each stores a summary per thread (senders,
snippet, unread count, whether it is in an inbox), recomputed whenever one of its messages changes, so the inbox lists
read a few dozen rows through an index however much mail is stored, plus the people the user exchanged mail with and
the drafts. How contacts and drafts follow the delta is shared (`packages/core/src/store/rules.ts`), and
both stores run the same tests (`describeMailStore`, exported as `@tresso/core/testing`; the SQLite store on sql.js).

The SQLite store writes one change at a time (a device may give each exclusive transaction its own connection without
a busy timeout), refuses writes once closing and waits for the ones under way, and stores each page with its cursor
in one transaction. A copy of an older schema version is brought up to date in place when `MIGRATIONS` has a step for
every version on the way (`MIGRATIONS[n]` brings version n to n + 1, all steps in one transaction); a step that adds
data the old copy never stored asks for a sync from the start, which keeps the rows on screen and overwrites them page
by page. A step that fails rolls back, and the copy is rebuilt instead, so it always opens. A copy of a newer version,
or one a step is missing for, is dropped and rebuilt, keeping the drafts that exist
only on the device. Either way the store says so (`afterUpdate`), and the status says "Updating your mail on this
device after the update" until that pull is done. The browser's store upgrades in place per IndexedDB version and syncs
again from the start, which it says the same way. A resync (after a change the server refused could not be put back) makes the next pull start from the
beginning, and holds across a restart and against a pull that was already running.

Both stores keep WhatsApp chats next to the mail (`chatAccounts`, `chats`, `chatMessages`, `chatOutgoing`, in the
shape of the delta's chat lists, `packages/core/src/chat/types.ts`): a list of chats newest first with each chat's
newest message and unread count (incoming messages after `readThrough`), the Unified Inbox's part of it (not archived,
not left out), one chat with its messages and replies, the replies waiting to be sent, and a few values the relay keeps
(`chatMeta`, in `meta` under `chat:`), and an account's chats left out (`leftOutChats`, for taking one back in). The list is one query and the unread badge one statement, through an index on
chat, sender side and time. A page's chat rows each stand on their own, so a message that arrives before its chat is
kept and shows once the chat does, and a page given twice stores nothing twice; a removed chat account takes its chats,
messages and replies (also a message whose chat never arrived, or that came in the same page as the removal), a removed
chat its messages and replies. An account has one chat per JID: a chat made again under a new id replaces the old one
with what it held. A delta row is stored as far as it can be read (`chatFromDelta` and the like): a time that is
missing or no time sorts last, an unknown value of a newer server becomes a safe known one, a row without an id is left
out, so one odd row never stops the sync, and nothing of it is logged. Rows this device writes itself are checked
strictly instead. In the "Only this Mac" mode the desktop app writes its chats into the copy under a chat account whose
id starts with `wa:` (`chatOnlyHere`): a rebuilt copy keeps those rows and the chat values, like drafts that exist only
here, since no pull brings them back. Sign-out deletes them with the copy. Chats moved the SQLite copy to schema 10
(`MIGRATIONS[9]` adds the chat tables in place) and the IndexedDB copy to version 12, both keeping their rows and their
cursor. A copy of the version before may have received chat lists and dropped them, so the update marks it
(`chat:backfill`), and at the next session start the web and phone apps ask the server for chat accounts once
(`backfillChats`), beside the first pull so a slow answer never holds back the mail: only when there is one does the
copy sync again from the start (a resync asked while a pull runs makes the next pull begin from 0). A token without chat
access counts as none; a failed request asks again at the next start. An account made after the check has change
numbers above the cursor, so the normal pull brings it.

The desktop app brings WhatsApp in with `ChatRelay` (`packages/core/src/chat/relay.ts`), one per account, through the
shell's bridge commands (`ChatBridge`) and a backend (`ChatBackend`): `LocalChatBackend` for "Only this Mac", which
writes the `wa:` rows above and sends nothing to the server, and `ServerChatBackend` for "All my devices" (below). Its rounds never overlap:
the next is planned when one ends, 3 seconds later, at once after a full page of 500 rows, 15 seconds after an error,
or as long as the backend asks (1 second to 10 minutes; a round in which it asked claims no reply). A round reads the
bridge's store by rowid from the cursor, leaves out what Tresso does not take before anything is stored (anything but
direct chats and groups, groups when they are not brought in, chats the user left out, messages before the import date,
without a time or with one before 2009 or more than a day ahead, without a WhatsApp id the server takes, or without
anything to show: what the server would refuse or leave out), and counts what it left out by why (numbers only, for
the connect dialog). It keeps each JID in the one form the server stores (`canonicalChatJid`, tested on both sides
with `packages/core/src/chat/importable-jids.json`) and a group sender as the user part of its JID: the bridge stores
the user part for live messages and the whole JID (with a device suffix, or `@lid`) for history it syncs, and what the
JID says (a LID or a phone number) beats the shell's guess. Names are looked up once per session when found, and again
after 5 minutes when not (contacts often arrive after the first messages); messages stored before keep what was known
then, since the copy has no cheap way to find them by sender. It stores, and only then moves the cursor, so a crash in
between reads the rows again, which changes nothing: messages are stored by chat and WhatsApp id. The backend answers
what it did (`stored`, `known`, `leftOut`, `refused`, as the server's per-row results; the copy cannot tell a message
stored again from a new one and counts both as stored). A row the bridge stores again gets a higher rowid and is read
again the same way. The cursor names the store it belongs to (`storeId`); when that changes, or the store's highest
rowid falls below the cursor, the store was replaced or renumbered and is read again from 0. That includes a history
sync that stores the store's first row again (`storeId` holds that row): harmless in the copy, but against the server
it sends every row again, which the server answers with `known` (see `ServerChatBackend` below for why that is accepted).

The first import runs from the first read until the store had no new rows for 60 seconds, since after linking the
bridge's history sync streams in over minutes, and ends at the latest once the relay ran 30 minutes during it; a
message that arrives within it lands as read. Both times count only the time the relay ran: each round adds the time
since this session's previous round, at most 30 seconds (ten poll intervals), so time the app was quit or the Mac
slept counts as no more than that and a clock that went back counts as nothing. The cursor keeps the store's highest
rowid seen, the running time and the quiet time, so a restart takes the import up again, also a day later: the quiet
time is then measured anew (the bridge may just be catching up) and the running time goes on from where it was. Each batch of it goes to the backend as `firstImport` and no batch goes as
live before it ended (the server honours `firstImport` until the first batch without it). It marks a chat that had
nothing unread read through its newest message, as the server does; later rows are live and arrive unread.

After the import the round sends the waiting replies one at a time, oldest first: claim (one write marks the reply
`sending` with its claim time, which is also the claim's token), send, report. Nothing is claimed while a reply of the
account is `sending`. A send is never repeated by the relay: a result that could not be recorded is kept and recorded
first in the next round, and every reply found `sending` at the next start (`sendingOutgoingHere`, in both stores, which
lists only rows of accounts on this device) becomes `failed` with `unconfirmed`, sent again only by the user's Try
again; a `sent` of the same claim still wins over that, as on the server. A waiting reply whose chat cannot be named is
failed as `refused`. Replies are trimmed and checked by `replyText`, the server's `QueueReply` rule. Writes to local chat
rows, the relay's and the user's (queue, cancel, try again, read, archive, leave out), go through one queue per copy, so
a reply cancelled while the relay claims it is either cancelled or sent. Leaving a chat out removes its messages and
replies and keeps the chat marked, so nothing of it is stored again. Neither the relay nor its errors carry message
text, names or JIDs.

What the desktop wiring (the WhatsApp settings and connect package) and the server backend must respect:

- One relay per copy and account. `await relay.stop()` before starting another or before `removeLocalChats`; stop
  waits for a send under way. Sign-out must not wait on it: the closing copy refuses writes and the relay stops itself
  (`CopyClosingError`).
- Disconnecting will stop the relay, then call `removeLocalChats`; a backend made before refuses to write afterwards,
  so nothing comes back.
- `ChatBridge.read` maps the shell's `busy` rejection to `null`. `ChatBridge.send` rejects only when nothing went out
  and has no timeout of its own that rejects (a rejection counts as `refused` and is never sent again).
- Run the relay only while the bridge is linked.
- Save the config, then call `LocalChatBackend.configure`, then `setLocalChatState`: the relay leaves out what the
  config says; the left-out mark in the copy is a second guard.
- `onError` logs the step and the error's name only.
- Downloads look up a message by the chat JID the bridge stored, which may differ in case or device suffix from the
  stored one.
- The same contact under `@lid` and `@s.whatsapp.net` gives two chats (hand-check).

The desktop wiring for "Only this Mac" is `apps/web/src/stores/whatsappRelay.ts`, started once by `App.vue` in the
desktop app. WhatsApp is off until it is turned on for a Mac, while it waits for a hand-check with a real phone:
`defaults write app.tresso.desktop EnableWhatsApp -bool YES` (or `TRESSO_ENABLE_WHATSAPP=1`; `defaults delete
app.tresso.desktop EnableWhatsApp` turns it off again). The shell reads the switch once at launch, and while it is off
every WhatsApp command answers `unsupported` (`whatsapp_available` false), so nothing in the window can load a config,
start a bridge, read or send; a bridge an earlier run left behind is still stopped at launch. Until then nothing of
WhatsApp shows on that Mac (the browser shows the chats the server holds, see below): no card in the provider list or on
Settings, Accounts, and every WhatsApp address (`/settings/whatsapp`, `/settings/whatsapp/connect`, and `/whatsapp`,
`/whatsapp/:chatId` and `/chats/:chatId` for the chat screens) leads back to Accounts or the Unified Inbox; no bridge
starts, also not for a WhatsApp connected before. Once the server confirmed who is signed in (where other users' mail
copies are removed), every other user's WhatsApp config on the Mac goes, with the folders only they named
(`whatsapp_config_keep_only`). The shell keeps the tokens but has no user id it could check them against, so a config
is loaded and saved only for the confirmed user by this store, not by the shell. Once on, the store loads the
signed-in user's config
(`whatsapp-<userId>.json`, `apps/desktop/src-tauri/src/whatsapp.rs`) and starts the bridge from its folder; the relay
runs while the bridge is linked and the copy has caught up (`mail.synced`), one at a time, each new one only after the
previous one's `stop()` resolved; one that stopped by itself starts again at the next change. A page reloaded during a
connect stops the bridge it had started, and connecting starts again from the risk. Connecting (`/settings/whatsapp/connect`, a modal dialog over Settings, WhatsApp)
goes folder, risk, bridge, link: nothing starts the bridge before the user confirmed the risk (WhatsApp's unofficial
web protocol, a possible limit or ban, messages stored on the Mac in the bridge's folder), the QR code is drawn from
the shell's rows as an SVG that stays dark on white in both themes, and Connect saves the config with a new device id
and `importSince` (the connect moment less 30 days), which nothing changes afterwards. The dialog then shows the first
import in counts (messages and chats so far, chats when done, a stuck import with what could not be stored); Done leads
to the WhatsApp list. Closing it while the bridge starts waits
for the start and then stops the bridge. Where the chats live is chosen there too: "Only this Mac" first and chosen,
"All my devices" only after the user confirmed that the chats are copied to the Tresso server (described below).
Notify me is off by default; WhatsApp gets no classification, no
search index and no smart inbox. Settings, WhatsApp shows the relaying Mac, the
folder (Change folder: picked and checked first, the chats stay, a new store is read from the start), the bridge (each
failure in plain words with what to do: not built, quit three times, port in use, not protected, not safe to start),
the link (how long ago Tresso saw it link, no countdown) with the code when it needs one, which chats come in (groups
off removes the copied group chats, refused while the copy is not open; on again reads the store from the start as a
first import), and Disconnect, which says it is waiting while a reply being sent finishes: the relay stops and is waited for, the bridge stops, `removeLocalChats` removes the copied chats and the
cursor, and the config goes; Tresso deletes nothing in the user's whatsapp-mcp folder, so the bridge's own store stays
and the phone keeps the Mac under Linked devices until the user removes it there. A sign-out stops the relay without
waiting for it and removes the config (an expired session keeps it); the shell stops the bridge. The store keeps the
bridge's state and Notify me on the `wa:account` row (`setLocalChatAccount`), and offers the chat screens `pollNow`,
`leaveOut`, `takeBackIn` (Settings lists the chats left out: the config first, then with the relay stopped the row is
marked in again and the cursor reset with the moment of the reset (`resetLocalCursor(store, liveFrom)`, kept as the
chat value `history-through` until the re-read ends): rows sent before it come back read, rows after it arrive unread
and notify as live ones; turning groups on again does the same. This re-read is local mode only: against the server a
first-import batch may never follow a live one, so there a chat taken back in must be read with live batches and its
history marked read by a chat state change. A `revision` is raised whenever the relay stored something, reported a
reply's result, or the chats changed through it (the chats are read again at most once a second while the store is
read in), and `senderNames`: the names its lookups found by
sender id, in memory only, with `lookUpNames` for the senders of messages stored before their name was known (they show
the name once it is; the stored rows are not rewritten).

The chat screens (`apps/web/src/stores/chats.ts`, `apps/web/src/components/chat/`) show the chats of the "Only this
Mac" account, or in "All my devices" those of the server's account (read again on every delta page with chat rows),
where WhatsApp is on and connected on the desktop; on a desktop with the switch off nothing of them renders. The browser
is described at the end of this section.
The sidebar has a WhatsApp row (unread chats in the Unified Inbox, which its count includes) and says `N mail accounts,
WhatsApp`; the Unified Inbox places chats among the mail by time (`mergeInbox`, no checkbox, never in a bulk selection,
and while older mail is still to be shown only chats newer than the last conversation on screen) with `Channels` tabs
(All, Mail, WhatsApp); `/whatsapp` lists every chat that is not left out, archived ones too. A chat is read in windows
(`MailStore.chatPage`: the newest 50 messages, older ones on scrolling up with the scroll position kept, never the whole
chat), with all its replies; replies older than the window's first message wait until it is shown. Opening a chat
sets `readThrough`; Noted sets both times, Archive `archivedThrough`; none of it reaches WhatsApp. Do opens a small
todo field titled `Reply to <chat>` that the user confirms or changes; nothing else of the chat goes into the todo.
Replies go through `queueLocalReply` and a relay round (`pollNow`); a waiting reply or a failed one can be cancelled,
one being sent cannot, and one whose sending is unconfirmed says it may have gone out and goes again only through Try
again. Files: Download asks the shell for Tresso's own checked copy (a mismatch, a missing hash, an untrusted name or a
file too large are said and nothing opens), Open opens only that copy, Attach takes a file from the native picker and
sends it at once; only a file that went out is recorded (`recordLocalAttachment`, a sent reply `File: <name>`), so Try
again never sends a file as text. Desktop notifications (`apps/web/src/mail/chatNotifications.ts`) come only with
Notify me on: one per chat per read, the chat's name and the start of its newest message (D5: local only), never for
history being read in, never for the chat open in a focused window; a click opens `/chats/<id>`. Replies on this Mac say
`waiting for the bridge` and `Not sent, click to retry` (core's labels keep the board's words for other devices). What
was typed into a chat is kept per chat in memory until it is sent, the chat goes or the session ends. A file the
desktop sent is marked on its reply (`file`: name and size in bytes, which the shell's picker gives) and matches the
bridge's later copy of it (a history sync stores the own message with no text, a made-up name, the kind the bridge sent
it as and its length) only by kind and equal size, so a photo sent from the phone a minute later never hides it; with a
size unknown on either side both show. The bridge stores nothing when it sends. Attach refuses a file over 100 MB in
the shell for now, before the bridge reads it whole into memory (to be raised once the bridge was measured). The
re-read after a chat was taken back in counts from the start of the last read the relay stored, and writes its mark
before it clears the cursor. An open, focused chat says incoming messages in a polite live region (one: the sender and
the start of the text; several: how many). History the relay reads in is not news there, by the rule notifications
follow: nothing while the first import runs, and while a re-read runs only what was sent after it began. The region is
emptied before each text, so a text equal to the one before is said again.

`ServerChatBackend` (`packages/core/src/chat/serverBackend.ts`) is the backend for "All my devices", over `ChatApi`
(`packages/core/src/chat/api.ts`: the request and answer types of the chat endpoints of 3.17, one method per endpoint;
the web client implements it). Every relay call names the desktop's device id. It writes nothing to the copy but two
chat values: what the server stored comes back through the delta, a chat's messages possibly a page before the chat.

- **Cursor.** Under `server-cursor:<account id>` (`serverCursorKey`), apart from the local backend's and per account,
  so a switch between the modes, or an account made again, starts from 0 with a first import. A value it cannot read
  starts a first import too: the server honours `firstImport` only until the relay's first batch without it, so after
  the history was imported the flag marks nothing read, and before, it keeps the history from arriving unread.
- **Settings.** `includeGroups` from the server's account in the copy (it rejects until the delta brought it),
  `importSince` from the desktop's config (the server's account does not keep it), and every chat of a batch is looked
  up in the copy (`chatByJid`): nothing of a chat held as left out leaves the device, and the chats it found left out
  are the relay's `leftOut`.
- **Batches.** At most 200 messages and 200 chats, each with the chats of its messages, and at most 8 MB of the request
  as JSON in UTF-8. A 413 makes the rest of the call, and later calls, half the size that got it (at least 64 KB). A 422
  that names rows (`messages[i]...`) refuses those rows and sends the rest again; one that names a chat entry
  (`chats[i]...`) sends that chat without its entry (the server may know it); one whose row paths name nothing in the
  batch halves it towards the row. A 422 without paths, or with a path that is about the request (`deviceId`), is no
  bad row and rejects as it came. A chat entry named for its name alone goes again without a name; a message the server
  then refuses only because its chat's entry was left out rejects with `ChatRelayImportStuck` instead of being passed
  over. Texts and names are cut to 65,536 code points first, on a code point boundary (the shell cuts before decoding,
  and bytes that are not UTF-8 decode to more characters). At most 3 messages are refused that way per call
  (`RELAY_MAX_REFUSED`), also single messages answered 413, and told (`row_refused`) only once the call resolves; one
  more rejects with `ChatRelayImportStuck`, so the cursor holds and the relay tries again: a cause that
  affects every row (a proxy, a newer server, a broken client) costs a few calls and drops nothing. Messages the server
  itself answers `refused` are counted as such without limit. The per-row results are summed into the relay's counts;
  an answer whose counts do not add up is an error, so the rows go again. Messages a call stored before a later call
  of the same page failed are counted as stored, not known, when the page goes again.
- **Errors.** 409 `not_the_relay` and 404 stop the relay, 429 pauses it for `Retry-After`, 403 for the longest pause
  (10 minutes); anything else (network, 5xx, 400, 401) is an error after which the relay sends the same rows again.
- **Replies.** Claimed one at a time; the claim (id and token, no text) is kept as a chat value (`server-claim:<account
  id>`) until its result is reported, and the result is kept with it before the report. `prepare`, and a claim asked
  for while one is kept, report a kept claim first: its kept result, or `unconfirmed` when none was kept (it may have
  gone out; a `sent: true` of the same claim still wins on the server). A crash between the server's claim and keeping
  it leaves a reply the sweep fails as `unconfirmed`. A result answered 404, 409 `result_final` or 422 is final (the
  relay moves on and never sends again; a 422 is counted and told through `onProblem`); a former relay may still report
  `sent: true` for its own claim, and any other result of it stops the relay.
- **A store read again from 0** sends every row again, which the server answers with `known` (no write, no change in
  the delta). That is accepted rather than avoided with a high-water mark: `ingest` gets no rowids and the relay
  learns of a new `storeId` only after it stored the rows, and a history sync stores the rows it brings again under new
  rowids, which are read again in any mode. At about 300 bytes of JSON a message, 100,000 messages are 500 calls and
  30 MB once, within the import limit's burst; a million are 5,000 calls, which the limit spreads over about 30
  minutes. The better fix is in the relay or the shell (a first row stored again is no new store).
- `reportStatus` sends the heartbeat with the same errors.

What the wiring (the WhatsApp UI package) must respect:

- Implement `ChatApi` by sending exactly `JSON.stringify(request)` (a PATCH as `application/merge-patch+json`) and
  rejecting with `status`, the problem's `code`, `retryAfterMs` and the violation paths (`ChatApiError`, or the web
  client's `ApiError` once it reads `code`). Never retry `claimReply` by itself: a claim sent again takes the next
  reply, and the first stays `sending` until the sweep fails it.
- The device id is an RFC 4122 v4 UUID made once per desktop, the same one `connect` sent; the constructor refuses
  anything the server's `Assert\Uuid` would.
- Keep `importSince` in the desktop's config, set once at connect, and pass it unchanged on every start and switch
  (0 uploads the whole history).
- Start the relay once the copy has caught up with the delta after the account arrived, not as soon as the account is
  there: a chat left out on another device is known as left out only from its row in the copy, and until then its
  messages would be uploaded (the server drops them, but they left the device).
- Stop the relay when the account's `relayDeviceId` in the delta names another device (after this device's own
  takeover, only once the delta shows it) or the account is removed, then call `removeServerChatState`. That also
  drops a kept claim, and with it a `sent` result `relay.stop()` could not report (the reply went out, and the sweep
  then fails it as `unconfirmed`, inviting a second send). On a takeover or a mode switch, let that report succeed
  first (a former relay may still report `sent: true` for its own claim: run `prepare` of a backend for the old
  account until it resolves), or keep the claim value and clear only the cursor; when the account is gone (404) the
  claim means nothing and goes with it.
- An `ingest` that rejects with `ChatRelayImportStuck` is not transient: show the import as stuck (counts only) rather
  than as a passing error; the relay keeps trying.
- Taking a chat in again or turning groups on needs a cursor reset (with the relay stopped, clear the chat value
  `serverCursorKey(accountId)`; keep the claim): rows the relay skipped before are behind the cursor and are read again
  only from 0, as `known` for what the server has.
- Words for `unconfirmed` must say that the reply may have been sent.
- Send the heartbeat (`reportStatus`) on connect, on every bridge change and every 60 seconds.

The desktop wiring of "All my devices" is in the same store (`apps/web/src/stores/whatsappRelay.ts`, mode `all` in the
config), with the web client's `ChatApi` (`apps/web/src/api/chats.ts`: the auth store's requests, each body exactly
`JSON.stringify(request)`; failures as `ChatApiError` with the status, the problem's `code` (which `ApiError` now
reads), `Retry-After` and the violation paths only; the claim is sent with the client's retry after a refused token
off, so it never goes twice). It keeps every point above:

- **Who relays.** The server's chat account comes to the copy through the delta; the mail store raises `chatChanges`
  for every page with chat rows or chat tombstones, and the store reads the account again on it. The relay
  (`ServerChatBackend`) starts only while the bridge is linked, the account names this desktop's device id (the RFC 4122
  v4 UUID of the config, the one `PUT chat-accounts/whatsapp` sent), and a pull ended after the account arrived. When the
  account names another device, the relay and the heartbeat stop, a claim this Mac kept is reported first (`prepare` of a
  backend for the account: a former relay may still report `sent`), and only then the cursor and the claim go. A relay
  call answered 409 `not_the_relay` (or 404) stops the relay and pulls at once; it stays off until the copy names a
  relay again. After this Mac's own `PUT` the device is not compared until the pull after it ended.
- **Consent and the number.** The store refuses "All my devices" without the user's yes to copying (`{ copy: true }`),
  unless the server's account is in the copy already (a takeover); the connect dialog treats `?mode=all` as that yes
  only while another Mac relays, checked again at Connect. Before every `PUT` (connect, switch, takeover, Change folder)
  and before the relay starts, the number the bridge is linked to is compared with the account's: another number is
  refused (`This Mac is linked to another WhatsApp number...`), an unknown one is asked about first (`{ number: true }`).
  The server refuses it too: a `PUT` with another number for an account that holds chats is 409 `other_number`, and a
  `PUT` without a number keeps the stored one. The heartbeat names the linked number once it is known; another than the
  account's is 409 `other_number` there too (an account without one learns it), and the relay stops. Without the yes to
  copying, a takeover relies on the account the copy holds: when the `PUT` answers with another (that one went
  meanwhile), the new empty account is removed again and the user is asked to choose "All my devices" with Copy.
- **Chats left out before the server knew them.** The switch to "All my devices" hands them over right after its `PUT`
  (the relay guard asks for this device only, not a running bridge), before the switch is done, so a Mac that takes
  over before this one ever relayed knows them; and at each relay start the relay hands every JID the config leaves
  out and the copy holds no server chat for to the server as a left-out chat (`RelayChat.leftOut` on
  `relay/messages`: the JID sealed, no name, no messages; a chat the server holds is left as it is), and the config's
  entry goes once that row is in the copy; until then the relay's fence keeps it out, so there is never a moment where
  neither does. From then on every Mac that relays, also after a sign-out and a new connect, leaves it out. The Copy
  confirmation and the left-out list say so ("Chats you left out stay out on every device: Tresso keeps only their
  WhatsApp address on your server, sealed, to recognise them."). A takeover that would remove the account's group
  chats (this Mac leaves groups out) says so first and offers to keep groups on instead.
- **What this Mac holds back.** Before the relay starts after a connect, switch or takeover, the stricter of this Mac's
  config and the account (groups off, notify off) is PATCHed to the server and saved in the config (`server-adopted`);
  from then on the account is the one source and the config follows it, and Settings shows the account's values. The
  relay's settings add the chats left out in the config that the server has no taken-in row for, and leave groups out
  while the config does, so nothing left out on this Mac is uploaded, also in the first import after a switch. The relay
  and the heartbeat start only after a pull of this copy worked in this session.
- **Heartbeat** at once, on every change of the bridge (process, link, port exposure) and every 60 seconds while this
  Mac relays, also while the bridge is stopped or unlinked (that is what it reports).
- **Use this Mac instead.** On a Mac in "All my devices" that does not relay: `PUT` with this device, the cursor from 0
  (the server honours a first import again for a relay that takes over), a kept claim stays to be reported. On a Mac in
  "Only this Mac" it is the switch below; on one without WhatsApp it opens the connect dialog with "All my devices"
  chosen. The Mac that relayed stops at its next call or pull.
- **Switching.** Each switch is marked in the copy (`mode-switch`) from its first step to its last, so a crash, a quit
  or a sign-out between two steps leaves a state the next start takes up, each step safe to repeat (the store's comment
  lists the steps and what each crash point leaves; `whatsappRelayServer.spec.ts` starts from each). To "All my
  devices": mark, note the replies waiting in the local rows (`carried-replies`, noted again whole while the rows
  exist), `PUT`, save the config, remove the `wa:` rows (only now), clear the server cursor (a first import from 0 with
  the same `importSince`), unmark. The noted replies are queued on the server once their chat came through the delta,
  each with a new UUIDv7 (on the server's clock) kept before it is sent: a repeat of a queued id gets the same reply
  back, and one the user cancelled meanwhile is 409 `cancelled` whatever its age (the server looks the id up before it
  checks the id's age). A 422 on `id` is never answered with a new id (the reply may have been queued and cancelled
  before); it is counted apart, as are cancelled ones and those whose chat never comes (given up after the first import
  and a pull after it). The counts stay in the copy until the user dismisses them; waiting ones can be cancelled, and the
  replies that were not sent here are not carried (the confirmation says how many). To "Only this Mac": mark, stop, report a kept claim,
  `DELETE` the account (noted outside the copy too, per user, while the request runs: a sign-out during it is finished
  at the next sign-in of the same user, any other failure drops the note, so a removal that failed and was said is
  never done later unasked; another user's sign-in drops the note without touching that account), save the config (the chats
  left out on the server join the config's), remove what was kept for the account, then wait until the copy applied the
  account's tombstone before the local relay reads the bridge's store from 0. A switch the server refused before it took
  anything is undone and said; after a crash it is tried again every 30 seconds. Disconnect reports a kept claim and
  deletes the account first; an account found gone from the copy is checked with the server, and gone there too,
  WhatsApp is disconnected on this Mac as well and Settings says so.
- **Re-reads.** Taking a chat back in, or turning groups on, against the server never sends a first-import batch after a
  live one: with the relay stopped the cursor goes back to rowid 0 keeping its store and its first import, a mark
  (`server-history:<account id>`) notes the moment and the chats it is about (and the rowid it began from), and the
  history is marked read through that moment by a chat state change: in the same `PATCH` as `leftOut: false` for a chat
  taken back in (the cursor is reset before that request, so a failed one leaves the chat left out), and for group chats
  as they come in through the delta. The mark goes once the relay read past where it began and a pull after that found
  nothing more to mark. Both are refused by the store on a Mac that does not relay, which cannot read the bridge again.
- **Chat actions.** The chat screens write through `ChatActions` (`apps/web/src/stores/chatActions.ts`): the local ones
  in "Only this Mac", the server ones in "All my devices" (queue a reply with a UUIDv7, cancel, try again, read through,
  archive, leave out, take back in). Each shows at once in the copy and is put back when the server refuses or cannot be
  reached, field by field to what the server last confirmed (so a later refused change never restores an earlier one),
  unless the delta changed that field meanwhile; errors are said in plain words. A reply whose outcome is not known (no
  answer, 408, 5xx) keeps its id per chat in the copy (`unsure-replies`): sending the same text again reuses it, so the
  server queues it once, also after the server's id window (a queued id comes back, a cancelled one is 409, one never
  queued is 422 and ends as "may already be queued"). When the delta brings that id the reply counts as sent: the
  draft that still holds its text goes, and the pane takes back its error, so pressing Send again cannot make a second.
  It is also let go when the server refused it. The server actions need only a
  `ChatApi` and a copy, not the relay, so the browser can use them as they are. On the relaying Mac a waiting reply says
  `waiting for the bridge`; on another Mac `waiting for your Mac` (or `sending` while the relaying Mac is online), and the
  composer names the Mac that sends. Attach stays "Only this Mac" until files go through the server (shown, disabled,
  with why). A read of a chat the server refused or did not answer is put back and held, as on the phone: not asked
  again for the same last message until the chat is looked at again (opened, or its window got the focus), and never
  before the server's `Retry-After` (on the server's clock), also not for a newer message, so a refusal cannot loop
  through the copy. Writes to the server's chats (replies, chat state, leaving out, the account's settings) and the
  automatic read wait until the server confirmed the copy's user in this page load (`mail.confirmed`, as mail's
  `confirmedOnly`): until then they say `Tresso is still checking who is signed in.` and the reply box is off; reading
  works. Leaving a chat out says there that its messages go from the server and from every device. Every crash point of
  both switches, a sign-out during one, a second user and the carried replies' crash points have a test in
  `apps/web/src/stores/__tests__/whatsappRelayServer.spec.ts`.

WhatsApp in the browser (app.gettresso.com) has no bridge and runs nothing of the relay: `whatsappRelay.ts` never
starts there (`whatsapp_available` is never asked), and `chatsFromServer` (`apps/web/src/platform/whatsapp.ts`, true
outside the desktop app) makes the chat screens show the chats the server holds, exactly while the copy holds the
server's WhatsApp chat account (the user chose "All my devices" on a Mac), with no switch. `chats.enabled` is the one
flag every chat screen reads: on the desktop as above, in the browser the account in the copy (read when the copy
opens and on every delta page with chat rows, so its tombstone turns it off). A copy without the account says "none"
only once it holds what the server has (a pull ended in this session, or it synced before and has no chat backfill to
do), so a link opened while signing in on a new browser waits for the first pull instead of leaving. Without it
nothing of WhatsApp shows and every WhatsApp address leads to Accounts or the Unified Inbox; an address opened before
the copy is open waits for it (at most 10 seconds, then opens, and the screen leaves once the copy says there is no
account), and a screen open when the account goes leaves too. `/settings/whatsapp/connect` never opens: only Tresso
for Mac connects WhatsApp. With it:

- The sidebar's WhatsApp row (`+31612345678, via Kim's MacBook Pro`, the unread chats in the Unified Inbox), the Unified
  Inbox's chat rows and `Channels` tabs, `/whatsapp`, and the chat pane, all from the IndexedDB copy fed by the delta;
  nothing calls the chat read endpoints (those are for MCP clients).
- Every write goes through `serverChatActions` as on a Mac that does not relay: read through, Noted, Archive, Leave
  this chat out (a `PATCH` with `leftOut: true`; the server removes the chat's messages and replies and stores nothing
  more of it, and the relaying Mac finds the chat left out in its copy and sends nothing of it), and replies queued with
  a UUIDv7 on the server's clock, with the same states, words, Cancel (only while a reply waits), Try again, unsure rule,
  drafts and guards. Taking a chat back in stays on the relaying Mac, which alone reads its bridge again.
- A notice above the chat and above the WhatsApp list when the relaying Mac is offline (`Your Mac is offline since
  08:40.`, from `relayOfflineSince`), its link went or its bridge stopped, from the chat account's row; the composer
  says `Sent on WhatsApp by <Mac>. No signature, no subject.`; Attach is shown disabled (`Files are sent from the
  relaying Mac for now.`), and a file row shows its kind, name and size with `Open this file on the relaying Mac.` and
  nothing to download, until files go through the server.
- Settings, WhatsApp (`SettingsWhatsAppBrowserView.vue`) shows the account read only: the relaying Mac and whether it is
  online, the bridge and the link as it last reported them, which chats come in, and the chats left out (with why they
  are taken back in on the Mac). Notify me, a setting the server keeps, is the one setting (`PATCH` of the account).
  `Remove WhatsApp from your Tresso server` (confirmed first) deletes the account (`DELETE`, a 404 counts as done) with
  every chat, message and reply, waiting replies unsent, for every device, also when the relaying Mac is lost (once the
  server confirmed it, the account also goes from this copy at once, so the page leaves even when the pull after it
  fails; the reply box says why it is off while Tresso still checks who is signed in): that Mac
  disconnects WhatsApp in Tresso at its next call or pull, and WhatsApp and the bridge's store stay. No connect, relay,
  mode, folder or link control. A Mac in "All my devices" that does not relay has the same through Disconnect, which
  deletes the server's account first.
- No notifications of WhatsApp in the browser: the server pushes new WhatsApp messages to the phone only, and the web
  client shows no in-tab notifications of its own.

Both stores keep the smart inboxes and list a smart inbox across all accounts through an index on smart inbox,
whether the conversation is in an inbox or junk folder, and date (`ListScope`: an inbox or a smart inbox).
Conversations in the Spam smart inbox stay out of the inboxes, also when the server left them there
(`summarizeConversation`). A correction shows at once (`classifyThread`) and is put back when the server refuses
(`restoreThread`), unless the delta changed the conversation since. A conversation corrected twice before either
request was answered goes back only once both were refused, to how it was before the first (`OpenClassifications`).
In the web client the sidebar lists the smart
inboxes with unread counts, the list and the reading pane show the verdict and change it or move the conversation,
and Settings > Smart inboxes edits them and lists the remembered senders. The IndexedDB copy moved to version 5 and the
SQLite copy to schema 3; both sync again from the start. Todos (3.14) moved them to version 6 and schema 4, batched
delivery to version 7 and schema 5, hand-overs (3.15) to version 8 and schema 6.

Both stores keep held conversations out of the lists and counts, list the delivered batches through an index on
inbox, batch time and date, and keep the unsubscribe requests (dropped with their account). The web client has a
Batches view (with the next batch time, asked for again a few seconds after each batch; a request that fails is
tried again after 30 seconds, doubling up to 10 minutes, and on the next screen change), an Unsubscribe button on the conversation and on each conversation in the
batches, a "Deliver in batches" choice per smart inbox and Settings > Batched delivery for the times and the zone;
the phone's `MailSession` unsubscribes and says what a conversation offers. The IndexedDB copy moved to version 7
and the SQLite copy to schema 5; both sync again from the start.

Drafts in the web client are saved on the device first and uploaded right after (one upload at a time per
draft). Edits made here are never overwritten by the delta: when another device saved a newer version, the compose
window asks whether to keep this version or take the other one. Drafts written before they were synced are
uploaded after the update. The composer remembers the text and version each open draft was opened on: while nothing
typed waits to be saved, another device's version that the delta brings replaces the form (with a notice), and a
draft sent or deleted there closes it; edits typed on the older text are not laid over the newer version but noted as
a conflict (also when sending), and closing a draft without edits writes nothing (the lists are told all the same,
since autosaves do not tell them). Only a version past the one the form builds on replaces it, and the copy never
takes a draft from a page that is older than the one it has (a page the server read before this device's last upload
that arrives after its answer). Texts are compared with the recipients as the server keeps them (trimmed, an empty name
none), so the device's own save does not come back looking like another's. When the other version is gone by
the time the user chooses (sent or deleted on another device, which also clears the version noted on the edits), the
edits here become a new draft; a choice that fails (offline) says so and can be made again. A create the server
already has (its answer was lost, or a rebuilt copy reset the draft to version 0) is recognised by its text rather
than retried for ever. A cancelled message (Undo, or Cancel in the Outbox, on any device) becomes a draft again in
the copy at once, so it shows in Drafts whatever the user does next. A forward whose original cannot be loaded is not
opened (a hand-over then sends nothing); a reply opens quoting the snippet and says the quote is incomplete. The few
seconds of the undo window are a send time on the server's clock (`ComposerDeps.now`, `ServerClock` from the `Date`
header of answers, set against the middle of the request's round trip, ignoring answers that took over two seconds,
and taken for the device's own while the two agree within two seconds, so a right clock never shortens the window)
while the notice counts them on the device's. A message the server took counts as sent also when
noting it on the device fails. Every send carries an `outgoingId`: a UUIDv7 on the server's clock, chosen when the
user first presses Send and kept with the draft in the copy (`sendAttemptId`) before the request leaves, so pressing
Send again after a lost answer, also after a restart, sends the same id and the server returns the message it queued
instead of sending it twice. The id is dropped once the server confirmed the message, when the send is cancelled or
undone, and when the draft's text changes (an edited message is a new one). A server that refuses the id itself (a
device clock far ahead) gets a new one on the next try, and so does any send the server answered with a refusal other
than 408 or 409 (it queued nothing). Queueing hides the draft on the server, which the delta reports as a deletion; a
draft with a send under way survives that deletion, so its id does too, marked as hidden on the server. When the
message with the send's id is in the copy (its answer was lost), the draft is taken as on its way after all: Send
pressed again sends nothing, and the follow-up run after every failed send closes the form. When it is not (the draft
was sent or deleted on another device, or the server does not take the id), the follow-up removes the hidden draft
only when the server had its exact text; text written here that the server never had (edits waiting to go up, or
typed in its form) is kept as a new draft (a new id, since the old one is taken on the server, and without its files,
which stay with the server's copy), whether its form is open or not, and the user is told. Sync never deletes text the
user typed. A hidden draft is not uploaded until it is settled, and the mark goes when the server brings the draft
back. A send dropped because the text was edited after it failed is
remembered (`unsureSendId`): when its message shows up after all, the user is told the earlier text went out and the
edited text is kept as a new draft. A draft moved into a copy that was opened again for the same user (`rebind`) takes
where its send stands along (its id, an earlier send that may have gone out, whether the server hid it). A server that
does not know the field ignores it.

Message actions in the web client: opening a conversation reads it; the conversation's buttons archive, trash, mark
unread, flag and move it (shortcuts E, #, U and S, not while typing or writing), and archiving, trashing or moving
goes back to the list with an undo. The reading pane opens with the triage verdicts, each showing its key: Do (D)
places the conversation with the do verdict (this conversation only) and makes its todo, Hand over (H) opens the
hand-over dialog, and Noted (K) marks it read, archives it and goes back to the list. K means Noted everywhere: in
triage, in the reading pane and in the bulk bar. The undo moves back only what the action moved, each message from where it went
into the one folder it came from (`fromFolderId` on the move); for a message that was in several folders (Gmail's
All Mail aside) no exact undo exists, so none is offered. Each action changes the local copy first
(`applyAction` of the mail store), so lists update at once; when the server does not take it (for a large selection, the
batches it did not take), it is put back part by part (read, flagged, folders; `OpenActions`): a part goes back once
no other action of this device on it is open any more, to how it was before the first of them, and only while it
shows the newest one's result; once the delta brought the message, the server's version stays. A batch the server
took ends its entries too (`acceptAction`), since an action that changed nothing there brings no delta. Entries go by
the action's own number (`AppliedAction.id`), so a late answer to one action never ends a newer one's.

Bulk actions in the web client: conversations are selected with their checkboxes (shift selects a range), by age
from the list's Select menu, or as everything from the senders of the selected ones; the last two search the whole
mailbox on screen in the local copy, not only the part of the list that is loaded. A bar above the list then marks
read or unread, notes (read and archived), archives, moves (within one account) or trashes every message of the
selected conversations, with the same exact undo as a single conversation (`apps/web/src/mail/useMessageActions.ts`);
K (Noted), E, # and Escape work while a
selection exists (not in menus or fields), and the conversation's own shortcuts wait. Conversations that leave the
mailbox meanwhile (sync from another device) drop out of the selection, and the undo puts back what it exactly can,
saying how many messages that were in several folders it leaves.

Bulk management in the web client: a smart inbox's list links to its senders (`SmartInboxManage`), with how many
conversations each has, how much is read and when they last wrote. Its toolbar marks read, archives, moves (to a
folder of one account, taking that account's conversations) or deletes everything in the smart inbox, or only what is
older than a week, a month, three months or a year, after asking with the count from the server; each sender's row
does the same for that sender at once. Clean up in the sidebar shows the cleanup suggestions, each with what its rule
found and one button. The server works through the action; the web client asks how it is doing (soon at first, then
every four seconds), shows the progress, pulls the delta when it is done and says how it went with the undo
(`apps/web/src/stores/bulk.ts`), with a Stop button while it runs. A poll that fails (offline, a deploy) is asked
again after a growing wait (1 second, doubling up to 30); after ten failures in a row the client says it lost track of
the action and pulls. The action under way is kept in the tab (sessionStorage) with the server and the user it belongs
to, so after a reload it is followed again to its result and undo, once the server confirmed the same user; one the
server no longer knows is let go. A sign-out stops the follow at once, without a notice, and forgets the action.
One bulk action runs at a time: the buttons are disabled from the first click.

Triage (`packages/core/src/triage.ts` for the state, `triageSession.ts` for the round; the web client and the phone
run the same code): a round over the conversations in the inboxes that wait for a decision (`needsTriage`: in an
inbox, not placed by the user), newest first, one at a time, at most 100 a round ("Start the next round" takes the
rest). A placed conversation stays out of triage for good, also when a reply arrives in it: replies do not reopen a
user's decision. The round starts once the first pull after opening the copy is over (`synced`) and the smart inboxes
are there, so a new browser or a phone that was offline starts from what the server has, and spam is known.

Do (D) and hand over (H) place the conversation with that verdict, for this conversation only (`remember: false`): it
keeps its smart inbox, or goes to Todo when it has none. Know (K) archives it. Each marks the conversation read. Skip
(J) leaves it as it is. Decisions and undos run one after another in the order the keys were pressed; none is dropped,
one that fails is reported and the next still runs, and the screen moves on at once. A decision acts on the
conversation as it was on screen: only the messages shown are archived and read (a reply that arrives meanwhile waits
for the next round), and deciding keys wait while the next email still loads. Hooks plug in other features and return how to take back what they did: `afterDo`
(by default `todoOnDo`: do makes the conversation's todo from its newest email someone else sent, with
`perConversation`, so a conversation that has an open todo gets none) and `handOver` (by default the hand-over dialog
on the web and the hand-over screen on the phone, opened for triage with `handOverAndWait`, which settles when it
closes; inside triage the dialog leaves the notice and its undo to triage).
Hand over runs its hook outside that order, so the round goes on while a dialog is open, and places the conversation
only once the hook says it was handed over; cancelled, nothing is placed and the conversation waits again.

Undo (Z, or the notice's button) takes back one decision, by its id, once that decision is done, and exactly. Do and
hand over first mark unread what the decision read and take back what the hook did (the todo, only when do made it;
the hand-over through `HandOverFlow.takeBack`: the forward too while it has not left, only the hand-over once the copy
says the forward was sent, and the user is told the delegate has it; when the cancel fails and the forward may still go
out, the hand-over stays). When that fails, the placement stays too, the mail is read again, and the undo can be tried
again;
then `DELETE /threads/{id}/classification?placementId=`: the rules place the conversation again and, as classification
does for new mail, a smart inbox that asks for todos gives it its automatic todo (unread, recent, `do`, no open todo in
the conversation, and not one the user deleted before). A choice made again elsewhere since stays, and the user is told; a step that failed is tried again
from there on the next undo. Know goes back by the archive's undo plan (messages that were in several folders cannot be
put back, and the notice says how many; what failed to go back is tried again on the next undo), and what it marked
read is unread again. An undone conversation shows again; when the copy has not synced the undo
yet, it joins the end of the round once it has.

The round follows the copy with two small reads per change (the round's own conversations, and the 50 newest of the
inboxes): conversations decided or archived elsewhere are passed over, mail that arrives during the round joins it at
the end. The web client opens triage at `/triage` (a link in the sidebar); its keys work as the other shortcuts do (not
while typing, writing, in a menu or dialog, or with a modifier), Escape leaves, and focus moves to the next email's
subject after a decision (and to the summary at the end) when it was in triage. The phone has the same round with
buttons (`apps/mobile/src/app/triage.tsx`), showing earlier messages of the conversation folded.

Writing mail in the web client: reply and reply all pick recipients from Reply-To, To and Cc without the user's own
addresses, and quote the original (helpers in `packages/core/src/compose.ts`, shared with mobile). Every message is
sent with a `sendAt` a few seconds ahead, so "Undo" can cancel it; "Send later" picks a time. The draft is saved in
the local copy while typing and kept until the message is confirmed sent, so a failed message can be edited and sent
again; the outcome of each sent message is announced once. When the session ends, the draft on screen goes with it,
so whoever signs in next never sees it; a session that expired or ended in another tab first saves the typing since
the last autosave into the copy it keeps, for at most 3 seconds (the close of the copy is bounded the same way), and
lets go of the draft on screen when that is done or the time is up; when the copy is opened again for the same user (another tab signed out and
removed it), the draft on screen moves to the new copy and is saved and uploaded there. Drafts whose upload failed
(offline) go up at the next start, when the realtime connection is made again, and after the first pull that works
after a failed one. Recipient suggestions come from the people in synced
mail, stored locally per user.

Attachments: files are attached to the server's copy of a draft (`POST /api/v1/drafts/{id}/attachments`, multipart,
field `file`), so the draft goes up first; a forward takes the original's files along
(`/forwarded-attachments`, without storing them again; inline images stay part of the text, malware is refused).
Files live in object storage under their SHA-256 (uploads under `uploads/`), so the same file is stored once; they go
out with the message and into the Drafts folder copy, within `MAIL_MAX_ATTACHMENT_BYTES` together (18 MB by default,
about 25 MB once encoded). A file with malware is not sent. Drafts in the delta carry their files without links,
which expire; `GET /api/v1/drafts/{id}` has fresh signed ones, and the content is served like a received
attachment's. An upload no draft refers to any more is removed ten minutes later, under a lock on its key that
uploading takes too. Sending keeps the draft on the server, out of the clients' sight, until its message went out:
an undo or a failure brings it back as it was, version and files included, so the device can go on writing it; once
the message is sent the draft goes. The web client attaches by button or by dropping files on the form; the phone
picks files (device or cloud drive) and photos (HEIC as JPEG), and shows the files of received messages.

### 3.11 Signatures

- `/api/v1/signatures` (scopes `signatures:read` and `signatures:write`) lists, creates, updates (JSON merge patch)
  and deletes the user's HTML signatures. Each mail account points at at most one default signature
  (`mail_account.default_signature_id`), so one signature can be the default of several accounts. A signature's
  `defaultFor` is the complete list of accounts that use it; writing it moves those accounts' default and clears it on
  accounts left out. Accounts must belong to the same user. Deleting a signature clears the defaults in the same
  transaction, so the accounts reach clients as changed.
- The HTML is sanitized on save with symfony/html-sanitizer, so every client and the API hand out the same markup:
  inline styles and layout attributes stay; scripts, event handlers, forms, frames, style elements and linked
  stylesheets go. Images (sources, backgrounds, CSS `url()`) load only from `https:`, `data:` (plain image types)
  or `cid:` references to parts sent with the message.
- Signatures are part of the delta (`signatures`, tombstone type `signature`), and mail accounts carry
  `defaultSignatureId`. The web client previews unsaved HTML in a sandboxed frame without scripts
  (`signatureFrameDocument`), on a light and a dark background.

### 3.12 Search

- One Meilisearch index holds every user's messages (`MEILISEARCH_INDEX`), one document per message: subject,
  sender, recipients, snippet, body text and attachment names to search, plus owner, account, folder ids, address
  tokens, attachment flag and received time to filter on. The worker sends the body text with each message
  (`bodyText`, quoted replies dropped, at most 32768 characters); the API keeps it sealed in `message_text` (see
  3.16), so the index can be rebuilt without reading object storage.
- Indexing follows the client sync change numbers. `ChangeSequencer` queues an index run for the user after commit
  (`AfterCommitDispatcher`, Messenger transport `search`); the run sends the messages changed since the user's search
  cursor (`search_cursor`) and deletes tombstoned messages and removed accounts. Runs for one user take turns on the
  locked cursor row, so a late, repeated or lost run is caught up by the next one. `app:search:reindex --user=<email>`
  or `--all` rebuilds from the database and applies the index settings.
- `GET /api/v1/search` (scope `mail:read`) takes words, "phrases", -exclusions and the filters `from:`, `to:`,
  `has:attachment`, `in:` (folder role, account or folder name), `after:` and `before:` (days in `timeZone`), newest
  first and paged. Clients never talk to Meilisearch: the API always filters on the owner and the owner's current
  accounts, and resolves `in:` to the owner's own folder and account ids. Highlights come back as text segments, never
  as markup. The web client searches from the conversation list (shortcut `/`) and opens a result's thread.

### 3.13 Calendar

The calendar lives next to mail, because so much of it arrives by mail: invitations, reschedules, "can we meet
Thursday", deadlines. It follows the same rules as mail: the server holds the truth, clients keep a local copy
through the delta, providers are synced by the Go workers, and Tresso is complete on its own while AI features
attach through interfaces.

#### Data model

- **Calendar** (`calendar`, synced): belongs to a user (`owner_id`) and either to a mail account (a provider
  calendar) or to no account (the user's local **Tresso** calendar, created with the user, always writable, never
  synced to a provider). Fields: `source` (`local`, `caldav`, `google`, `microsoft`), `remote_id` (CalDAV collection
  URL, Google calendar id, Graph calendar id), name, color, default time zone, `writable` (from the provider's
  privileges), `is_default` (one per account: where new events and accepted invitations go), and the user's own
  `visible` and color override, which never go back to the provider. The provider sync cursor (sync-token, ctag,
  Google `nextSyncToken`, Graph delta link) is internal and not a client change.
- **Calendar object** (`calendar_object`, internal): one iCalendar object as a provider stores it in one resource,
  every `VEVENT` with one `UID` (a series with its overrides, or a single event). Its complete iCalendar text is the
  truth: Tresso edits the parsed object and serializes it again, so properties it does not model (`X-` properties,
  `VTIMEZONE`s, `ATTACH`, `VALARM`s of other clients) survive an edit. Provider state: `remote_id` (CalDAV href,
  Google or Graph event id) and `etag`.
- **Event** (`calendar_event`, synced) is the projection of one `VEVENT` of an object: a single event, the master of
  a recurring series, or an override of one occurrence. Rows are only written by projecting their object, so they
  always agree with its text. Unique on `(calendar_id, uid, recurrence_key)`. Fields:
  - `uid`, `sequence`, `recurrence_key` (the original start of the overridden occurrence as a UTC instant
    `YYYYMMDDTHHMMSSZ`, or the date `YYYYMMDD` for all-day series; empty on masters and single events; clients see it
    as `recurrenceId`), `status` (`confirmed`, `tentative`, `cancelled`).
  - `summary`, `description`, `location`, `url`, `transparency` (`busy`/`free`), `visibility`
    (`public`/`private`/`confidential`).
  - Time: `start` and `end` as wall-clock values with their IANA time zone (`start_tz`, `end_tz`; null means floating),
    or dates when `all_day` is set (`DTEND` exclusive, as in RFC 5545). `DURATION` is converted to an end on ingest.
    Windows time zone names from Exchange and Outlook are mapped to IANA names on ingest; unknown `VTIMEZONE`
    definitions are matched by their rules, and the original definition stays in the stored iCalendar.
  - Recurrence: `rrule` (the `RRULE` value as text), `rdates` and `exdates` (lists of recurrence keys, so they
    compare with overrides as plain strings).
  - Two UTC columns only for range queries: `starts_at` and `ends_at` of the first occurrence, and `series_ends_at`
    (end of the last occurrence; null when the series never ends). All-day and floating events are stored with
    UTC as their zone in these columns and are widened by 14 hours on each side when queried, then filtered in the
    reader's zone.
  - `organizer` and `attendees` (JSON: address, name, role, `partstat`, `rsvp`, kind), plus `self_partstat`, the
    response of the account owner, kept as a column so "needs action" can be found and indexed.
  - `reminders` (JSON list of `VALARM`s: trigger relative to start or end, or absolute, and action) and
    `conference` (JSON: provider `teams`, `meet`, `zoom`, `webex` or `other`, join URL, conference id, dial-in), read
    from RFC 7986 `CONFERENCE`, `X-MICROSOFT-*`/`X-GOOGLE-CONFERENCE`, Graph `onlineMeeting`, Google
    `conferenceData`, or a join link in the location, URL or description.
  - `message_id`: the invitation this event came from, when it came by mail; `sync_error`: why the last change did
    not reach the provider.
- Parsing, serializing and recurrence expansion use `sabre/vobject` (iCalendar and RRULE per RFC 5545, Windows
  zone mapping). Clients expand recurrence for their local copy with `ical.js` in `packages/core`; the API's range
  endpoint is the reference both are tested against.

#### API

Scopes `calendar:read` and `calendar:write`, in the user scopes of the first-party clients.

| Call | Purpose |
|---|---|
| `GET /api/v1/calendars` | The user's calendars. `PATCH` changes the user's color, visibility and the default calendar, and the name of local calendars (provider calendars are renamed at the provider). `POST`/`DELETE` only for local calendars. |
| `GET /api/v1/calendar-occurrences?from&to&timeZone&calendarId[]` | Occurrences in a range (at most 400 days), recurrence expanded: per occurrence the event id, the `recurrenceId`, start, end and the event's fields, overrides applied and exceptions removed. Series are expanded one occurrence at a time, at most 10,000 per answer (more is a 422 asking for a shorter range, never a silently shortened series; an hourly series fits the longest range). A series is the union of its `RRULE` and `RDATE`s (each in its own `TZID`) less its `EXDATE`s; an override with `RANGE=THISANDFUTURE` changes the later occurrences too, and an override whose occurrence the series no longer has still shows. Each occurrence is keyed by its start as it reads back once written into an event, so on the night clocks go back an occurrence at a repeated time (02:30), its override and its `EXDATE` share one key. An all-day occurrence lasts as many calendar days as its event, also on a 23-hour day. A rule repeating every so many hours, days or weeks (without `COUNT`) is jumped to near the range; any other walk through a rule stops after 100,000 steps, so an old dense series costs no more than a new one. Floating and all-day events are read in `timeZone`. Series that repeat more often than hourly are refused when stored, from the editor and from providers alike. A rule sabre/vobject cannot expand (an unknown `FREQ`, an `X-` part, `RSCALE`) is stored as written, so devices that expand it themselves (ical.js) still can; the server shows its first occurrence (also for busy times and reminders) and treats the series as endless. An occurrence a device names (to change, delete or answer it) is taken as named when it is not before the series' start, since the server cannot tell it from one the rule does not have. Known limit: "this and following" on such a series with `COUNT` cannot count the occurrences before the split (the server cannot expand the rule), so the new series keeps the count of all but the first, and devices may show more occurrences than the original had. A resource the API cannot store at all (a malformed date, duration or rule text, a time outside the years 1 to 9999, a UID over 1024 characters, a NUL character) is skipped and logged: the rest of the batch is stored and the cursor moves on, and since no ETag is kept for it the worker fetches it again on the next round. Calendar parts of mail are skipped the same way, each written in its own savepoint, so nothing a part holds fails the mail batch. |
| `GET /api/v1/calendar-events/{id}` | One event as stored (series or override). |
| `POST /api/v1/calendar-events` | Create in a writable calendar. |
| `PUT /api/v1/calendar-events/{id}?scope=&recurrenceId=&notify=` | Save the editor's complete event; for a series `scope` is `this`, `following` or `all`, and `recurrenceId` the occurrence the user edited. Without `scope`, the id of a changed occurrence (an override) means that occurrence and any other id the whole event; another value is refused (422). A different `calendarId` moves the event (whole series only). |
| `DELETE /api/v1/calendar-events/{id}?scope=&recurrenceId=&notify=` | Delete with the same scopes. |
| `POST /api/v1/calendar-events/{id}/response` | RSVP: `accepted`, `tentative` or `declined`, optional comment, for the series or one occurrence, optionally without telling the organizer. |

Edits of recurring events follow what Google Calendar, Outlook and Apple Calendar agree on:

- **This occurrence:** an override with the occurrence's `recurrence_id` is created or changed. Deleting one adds an
  `EXDATE` and removes its override.
- **This and following:** the series is split. The original gets an `UNTIL` just before the occurrence (a `COUNT`
  is converted to the equivalent `UNTIL`, which is floating for a floating series); the new series keeps what is left
  of a `COUNT`, counted as RFC 5545 does, before `EXDATE`s take any away. The new series with a new `UID` starts at the occurrence with the edited
  fields and takes over the later overrides and exceptions, moved by the same time shift. Deleting cuts the
  series with `UNTIL`.
- **All:** the master changes by the shift the user gave the edited occurrence, measured from where that occurrence
  is shown (a moved occurrence's own start). That shift also moves every
  override's `recurrence_id` and every `EXDATE` and `RDATE`, so exceptions stay attached to their occurrences;
  overrides keep their own changed fields. When the series changes between floating and zoned, those values take its
  new form too, so their keys still meet the series'. The end keeps its own time zone. A changed recurrence rule, or a switch between all-day and timed, starts
  the series fresh: its overrides and exceptions belong to occurrences that no longer exist and are dropped.
- Every change to time, place, status or the recurrence raises `SEQUENCE`, which is what tells attendees' clients
  that an update supersedes the previous one (RFC 5546). Which iTIP messages a change needs (requests to new and
  current attendees, cancellations to removed ones, a reply to the organizer) is decided by sabre/vobject's iTIP
  broker from the object before and after the change. The broker is given the editor's own list of significant
  properties, so a new place (`LOCATION`) reaches the guests too; sabre's list leaves it out.

Writes to provider calendars are optimistic: the row changes at once (clients see it in the delta), and an outbound
**calendar operation** (`PUT` or `DELETE` of one resource, with the `etag` it was based on) is queued for the
worker that leases the account, exactly like the outbox for mail. The worker reports the new `etag` and href. A
conflict (`412`) makes the worker fetch the current resource: the provider's version wins and the user's change is
reported back as failed, visible on the event (`syncError`). A refusal (read-only, quota) is shown the same way, and
the provider's version replaces the row when the worker could read it. While a write for a resource is pending,
provider changes to that resource wait, so a sync never overwrites a change that is on its way.

#### Sync sources

The worker that leases an account runs the calendar syncer next to the mail syncer (`lease.Syncer` for the account
is a group of both); they share the account's credentials and lease but fail independently: a calendar server that
refuses the login does not stop mail. The account carries a calendar status of its own (`calendarStatus`:
`unknown`, `active`, `unsupported`, `auth_failed`, `unconfirmed`, `not_granted` (Google or Microsoft: calendars not
allowed yet) or `error`, with a detail the user can act on), reported once per
problem by `POST /internal/sync/accounts/{id}/calendar-status` and set back to `active` by a calendar list the API
accepted. An `error` is about the sync itself, so a list does not clear it (a calendar that keeps failing would
make the status flip every round). The worker ends it: after a round in which every calendar synced (also when none
had changes) it reports `active` once, and while a calendar keeps failing it reports `error`, never `active`. The API
takes `active` only over `error`; any other status (a login, a permission, an address to confirm) stays until a
calendar list shows it is solved. The list's answer carries the account's `calendarStatus` after the list, so the
worker reports a problem again only when it changed (another status or another text), when the API no longer holds
it (a sign-in again sets it back to `unknown`, and the list then makes it `active`), or after a wake: a problem met
before any list (a refused list, a refused sign-in) cannot be checked against the answer, and a wake is how the API
says the status may have changed. An API that does not send the field gets the problem after every round, as before.
The clients show it where the user looks: the account's card in Settings, Accounts carries a badge for
`not_granted`, `auth_failed`, `error` and `unconfirmed` and opens by itself, and the calendar page lists every account
whose calendars do not show, with "Allow calendar access" (one sign-in that adds the calendar scopes) for
`not_granted`, the detail and a link to the account's settings for the others, and "Looking for the calendars" while
an account has none yet. A notice can be hidden; that is remembered in the browser per account and status for as long
as the account keeps that status, so a problem that goes away and comes back shows again. An IMAP account's settings show its CalDAV status and take the CalDAV address
(`calendarUrl`), with "Use this address" for one the worker found but may not trust on its own (`unconfirmed`). The
worker may send that address as `url` with the status; the API keeps it while the status is `unconfirmed` and returns
it as the account's `calendarFoundUrl`, in the account resource and in the sync delta alike. A worker that sends only the sentence is still understood: the client then
reads the address from `calendarStatusDetail`.

- **CalDAV** for IMAP accounts (`apps/sync/internal/caldavsync` on a small WebDAV client in `internal/caldav`, through
  the guarded dialer). The client keeps objects as raw iCalendar text in both directions and reads colors, ctags and
  privileges, which general WebDAV libraries do not. The mail password goes only where it belongs: never over plain
  HTTP (hrefs and redirects included; the API also refuses an `http://` server address), only after a server asks for
  it (401) and is remembered per scheme, host and port, and only to a trusted host: the IMAP host, the CalDAV address the user entered (or
  that was found on a trusted host before), and the CalDAV site of a known provider (iCloud's hosts vary). A trusted
  host may redirect to another host of its own site; hrefs and redirects to other sites never get it:
  - Discovery: the account's stored CalDAV URL, else RFC 6764 (`_caldavs._tcp` SRV and TXT records, then
    `https://<domain>/.well-known/caldav`, for the address's domain and the IMAP host's domain), else known
    provider hosts by IMAP host (iCloud, Fastmail, Yahoo, mailbox.org and others; Gmail and Microsoft 365 sync
    through their own APIs instead). The user can also set the address on the account (`calendarUrl`). Then
    `current-user-principal`, `calendar-home-set` and the calendars with their name, color, supported components
    (only `VEVENT` calendars are synced), privileges, `getctag` and `sync-token`. The URL that worked is reported
    back and stored with the account; a server without CalDAV is reported as `unsupported` and looked for again
    daily; a timeout or server error during discovery is retried with backoff instead, unless another candidate
    answered and can be confirmed: then the user is asked to confirm it. Discovery answers are read up
    to 1 MiB. Guessed candidates (the web host of the mail domain, hosts named in DNS) are not trusted: they never get
    the login and are never used or stored, also when they answer without asking for it. When one answers and no
    trusted one works, the status becomes `unconfirmed` with that address, and the user confirms it by entering it
    as the account's `calendarUrl`. The worker sends the full address as the status report's `url` (https only; one
    the API would refuse is left out), next to the sentence that names it, cut to 200 characters without its query.
  - Changes: `sync-collection` (RFC 6578) with the stored token when the server supports it; otherwise the `getctag`
    is compared and, when it changed, the resource etags are listed and only changed resources fetched with
    `calendar-multiget`. Every 2 minutes, and right after a write. Missing tokens (`valid-sync-token` error) fall back
    to a full listing, and a failing `sync-collection` to a plain listing. A server that cuts its answer short (a 507
    for the collection, RFC 6578 3.6) is asked again from the token it gave: changes are applied page by page, and a
    full listing is collected over all pages before anything is removed. A full listing goes to
    `POST .../calendars/{calendarId}/inventory` (every href with its etag), which removes what is gone and answers
    which hrefs to fetch. A listing over 50,000 resources goes in `partial` pages, which remove nothing. Removals go
    in batches of 5,000, the cursor with the last one. Calendars, hrefs and etags longer than the API takes are left
    out (and logged), so one cannot block a calendar for good. The pages of a listing are folded in order: a later
    page's entry replaces an earlier one, and a removal reported there drops the resource. A calendar that refuses the login (a share taken back)
    is skipped; only when every calendar refuses is the account's status `auth_failed`. Status details are cut to 500
    characters and name server addresses without login or query.
  - Ingest: `POST /internal/sync/accounts/{id}/calendars` (the complete calendar list, answers each calendar's
    cursor and the account's `calendarStatus`; calendars missing from the list are deleted, except after an empty list, after the first list from
    another server, and while they have writes to make) and `POST /internal/sync/accounts/{id}/calendars/{calendarId}/objects`
    (up to 100 changed resources as `href`, `etag` and raw iCalendar, removed hrefs, and the new cursor). The API
    parses every resource with sabre/vobject, so there is one iCalendar implementation on the server. The cursor only
    advances after the API accepted the work it covers.
  - Outbound: `POST /internal/sync/accounts/{id}/calendar-operations/claim` and `.../calendar-operations/{id}/result`
    (`done`, `conflict` with the server's current version, `failed`, or `retry` up to 6 attempts), the same claim and
    report cycle as the outbox, announced on the Mercure topic `urn:tresso:sync:outbox` and in every heartbeat
    together with mail. New events are written with `If-None-Match: *` to `<calendar>/<uid>.ics`, updates and
    deletes with `If-Match`; an update whose current ETag cannot be read, or that the server does not name, is not
    sent (a conflict: the server's version wins). Writes of one event are handed out one at a time and in order; a put carries the
    event's text, resource and etag as they are when it is claimed, so a quick second edit uses the etag the first
    one got back.
  - Scheduling: servers that implement RFC 6638 (`calendar-auto-schedule` in the `DAV` header) send invitations and
    replies themselves; for others the API sends them as iTIP mail (below).
- **Google Calendar API** and **Microsoft Graph** for Gmail and Microsoft 365 accounts (`apps/sync/internal/calsync`
  with `googlecal` and `graphcal`), next to the mail syncer as for CalDAV, on an access token from
  `credentials?feature=calendar` and through the guarded dialer. Both convert the provider's events to iCalendar
  (`internal/ical`, a small content-line reader and writer; sabre stays the one full implementation, in the API), so
  they go through the same ingest, inventory and write cycle as CalDAV resources. The calendar list says
  `providerSchedules`, and per calendar which meetings it can make (`conferenceProviders`). Every minute, and right
  after a write or a sign-in that allowed calendars (every heartbeat also names leased Gmail and Microsoft accounts
  whose calendar status is still `unknown`, and signing in again with calendars allowed sets every status but
  `active` to `unknown`, so a missed wake-up costs at most one heartbeat, not the hour an `error` or `not_granted`
  account waits otherwise):
  - One resource is a single event, or a recurring series with its changed and cancelled occurrences (overrides and
    `EXDATE`s in one object, as RFC 5545 has it).
  - **Google:** `calendarList` (calendars the user can only see free/busy of are left out; `writer`/`owner` are
    writable; Meet when `allowedConferenceSolutionTypes` has `hangoutsMeet`), then `events.list` with
    `singleEvents=false`, `showDeleted=true` and the stored `nextSyncToken` (a 410 lists the calendar again).
    Exceptions are events of their own at Google (`recurringEventId`): a changed one makes the worker read its
    whole series again (the master, then everything with its `iCalUID`), and a cancelled one is an `EXDATE`; writes
    compare the series' recurrence with these `EXDATE`s, by meaning, so an invitee can answer such a series and an
    unchanged one sends nothing. An event that cannot be written as iCalendar is skipped and keeps its stored copy. The
    remote id is the master's id; the ETag combines the master's and every exception's, so a change to any of them
    is a change of the resource. An occurrence the user was invited to alone (no master in the calendar) is an
    object of overrides only. `useDefault` reminders become the calendar's default reminders as `VALARM`s, and are
    written back as `useDefault` when they still are those.
  - **Microsoft:** `GET /me/calendars` (`canEdit`, `isDefaultCalendar`; Teams when `allowedOnlineMeetingProviders`
    has `teamsForBusiness`). Graph has no change feed of series, so `calendars/{id}/calendarView/delta` over a window
    (a year back, five ahead) is only the signal: when it reports anything (Graph also reports changes outside its
    window), and at least daily, the calendar is listed with each event's `changeKey` (single events and series
    masters only), and the API's inventory names what to fetch. Events are always addressed under their calendar
    (`/me/calendars/{id}/events/{id}`), which also finds them in calendars shared with the user. A fetch reads the
    event in the zone it was made in (`Prefer: outlook.timezone`, Windows zone names mapped to IANA names with the
    CLDR table; a zone Tresso cannot place, such as an old Outlook custom zone, is read in UTC) with
    `exceptionOccurrences` and `cancelledOccurrences`; Graph's recurrence patterns are written as `RRULE`s and back
    (`UNTIL` is the end date at the series' wall clock). The ETag is the master's `changeKey`, which Exchange changes
    with any change to the series. Graph gives a new event a UID of its own and lets no one set it, so Tresso keeps
    its UID in a single-value extended property and reads it back from there.
  - **Writes** go through the provider's API, never as iCalendar: create (Google `events.insert` with an id derived
    from the UID and the `iCalUID`; Graph `POST .../events` with a `transactionId` from the UID, so a retried create
    finds the event), then the changed occurrences (Google patches `<master id>_<recurrence key>`, which makes the
    occurrence an exception; Graph patches the instance it finds in `instances`) and the cancelled ones (Graph deletes
    the instance; Google takes the `EXDATE` in the recurrence). Only fields that changed are sent, compared through
    the same conversion both ways, so an unchanged event costs no write and sends no update mail; writes are
    conditional (`If-Match` on the event's ETag) and checked against the operation's ETag first, a mismatch being a
    conflict with the provider's version. A Google occurrence that is no exception yet is read as Google's own
    instance first, so answering or changing one compares with its real time. Rules Graph has no pattern for
    (`BYMONTHDAY=-1`, numbered days in different weeks such as `BYDAY=1MO,1WE`, `RDATE`s, more often than daily) are
    refused with the reason. A changed description is written to Graph as HTML that keeps the body's Teams join
    block. A write the provider accepted reports the provider's version back as `current`, which replaces the stored
    object unless a newer change of the user's waits; one it could not read back keeps the last known ETag. Both
    providers write a series step by step (the master, then each occurrence): every retry of a write to an event the
    provider has reports the provider's id, ETag and version, because an earlier attempt may have written part of it. That version is adopted only when it is the one the
    attempt read or its own steps left (Google: every event's ETag; Graph: the master's changeKey, read again after
    each step): a provider that answers someone else's change with a 5xx instead of a 412 would otherwise let the
    next attempt pass its If-Match and overwrite that change, so the retry is a conflict instead. The API bases the next attempt on them, and when no
    attempt is left the provider's version replaces Tresso's, so the two never stay apart. A move to another calendar
    of the same Google account (a delete and a create of the same UID in one claim) is Google's `events.move`, which
    tells no one; it is made only when the event still is the version Tresso moved (else nothing is written: the delete reports the
    provider's version, which stays in the old calendar, and the create is held back as a conflict),
    and the update after it is conditional on the moved event's ETag. `events.move` makes the target calendar the
    organizer, so the API refuses to move a meeting with guests between calendars of one Google account and says why.
    A 403 means calendars are not allowed (`not_granted`, sign in again) only for a token without the scopes (Google
    `insufficientPermissions`); the API hands out a calendar token only for a grant that has them, so any other refused
    calendar list (Graph answers `ErrorAccessDenied` alike for a missing scope and for a mailbox or tenant that does
    not allow it) is `error` with the provider's code, and a rate limit is retried like any failure. On one calendar a
    403 skips that calendar, and on a write it is a refusal. An event the provider refuses to hand over (4xx) is left
    out and the cursor moves on (a later change names it again); one it fails on (5xx) is left out too, but the cursor
    stays, so the calendar's next sync asks for it again. Connection errors, throttling and lost access end the sync
    as before.
  - **A calendar that keeps failing** (for CalDAV accounts as well) is backed off on its own: the wait doubles from
    the sync interval up to 30 minutes, and after three failures in a row the account's calendar status is `error`
    naming the calendar, repeated after every accepted calendar list until it syncs again. After a round in which
    every calendar was reached and none failed (also when nothing changed), the worker reports `active` once: after
    it reported a problem, and once after a start, when it does not know what the API shows. An API that does not
    take `active` (422) is not asked again. The
    other calendars go on at their own pace. A CalDAV session that synced resets the failure count and backoff of the
    account, as the provider syncers do.
  - **Scheduling:** both providers send invitations, updates, cancellations and replies themselves, so the API sends
    no iTIP mail for these calendars and puts no incoming invitation into them (the provider does). The calendar
    operation carries `notify` (false when the user said not to tell anyone; folded writes notify when any of them
    did) and the reply's `comment`. Google takes `sendUpdates=all|none`; an invitee's answer patches only their
    `attendees[].responseStatus` (and comment). Graph answers with `accept`, `tentativelyAccept` or `decline`
    (`sendResponse`, `comment`); it always sends an organizer's updates. An invitee may change only their answer and
    reminders (and free/busy at Microsoft); any other change is refused and the provider's version shown again.
  - Push channels (`events.watch`, Graph change notifications) need a public HTTPS endpoint per installation and are
    a later step; until then the cheap incremental calls run every minute.

#### Invitations in mail

- The worker's MIME parser reads `text/calendar` parts (inline or attached, any charset, at most 256 KB) and
  reports them with the message as `calendarParts`: the `METHOD` and the raw iCalendar. They are still stored as
  attachments, so the original can be downloaded.
- The API records an **invitation** per message (`message_id`, `method`, `uid`, `sequence`, `recurrence_id`, the
  iCalendar) and applies it once the ingest has committed (Messenger, transport `async`). Calendar mail in Spam or
  Trash is not recorded; it is applied only from the inbox, and not when the message arrived before the account was
  connected (the first sync must not replay years of invitations). Anyone can send calendar mail, so:
  - a `REQUEST` or `CANCEL` counts only from the event's organizer (as stored, or as the message names for an event
    that is new). A delegate may send for them only when the stored event already names it in `SENT-BY`; a `SENT-BY`
    in the message itself is the sender's own claim and proves nothing, so a new event counts only from its
    organizer. It never changes who organizes the event, never touches an event the user organizes or that has no
    organizer, and may raise `SEQUENCE` by at most 100;
  - a `REPLY` counts only when its single attendee is the sender (in any letter case) and already an attendee of the
    event, and carries an answer; a reply sabre cannot read is ignored once, not retried.
  - Order follows RFC 5546: a higher `SEQUENCE` is newer, at the same `SEQUENCE` a later `DTSTAMP` is, and an update at
    the same `SEQUENCE` keeps the user's answer. Messages about single occurrences are merged into the stored event,
    one occurrence each; a `CANCEL` of occurrences compares each with its own `SEQUENCE` and skips ones the series
    does not have. Applying locks the invitation and the stored event, so the worker and the user's apply action, or
    an edit made meanwhile, never overwrite each other. Of several stored events with the `UID`, the one in a calendar
    of the receiving account is used, else the Tresso one.
  - A same-`SEQUENCE` change to one occurrence keeps the answer the user gave the series, and a reply updates a guest
    however an occurrence spells their address.
  - Known limit (left on purpose): the first stored event with a `UID` owns it. Someone who sends the user a
    self-organized invitation with the `UID` of a meeting they have not received yet holds that `UID`, and the real
    organizer's invitation is then ignored as not coming from the stored organizer. No rule fixes this: whoever stores
    a `UID` first wins under any rule. The user sees the real invitation in the mail and can still answer it there.
  - The sender is the message's `From` address as the mail server delivered it. On Gmail and Microsoft accounts,
    calendar mail that changes what the calendar has (an update of a stored event, a `CANCEL`, a `REPLY`) applies by
    itself only when the provider confirmed its sender. Gmail: its own `Authentication-Results` (authserv-id
    `mx.google.com`) shows DMARC passed. Microsoft: its header names no authserv-id, so it is told from one the
    sender wrote only by `X-MS-Exchange-Organization-AuthAs` (read on Microsoft accounts only, reached through Graph;
    the value case-insensitive), which Exchange Online's header firewall removes from mail arriving from outside the
    organization and sets itself: `Internal` (sent within the tenant, which carries no `Authentication-Results`) is
    confirmed; any other value (`Authenticated` says only that the submitting client signed in, `Anonymous`,
    `Partner`) needs DMARC passed in the topmost `Authentication-Results`; without the header nothing is confirmed. Mail is noted as waiting only where the user can apply
    it (not in a calendar its provider schedules). Otherwise it waits: nothing in the
    calendar changes until the user applies it; the invitation answer carries `senderUnconfirmed` (only together with
    `canApply`, when the user can act), and the message in the sync delta carries `calendarWaiting`, so a message list
    can show it without opening the mail. A new invitation changes nothing that is there and lands by itself.
  - What the sync worker sends for this (its `headers`, see the classification section): `authentication-results` as
    the topmost header of that name, up to 8,000 characters, and for Microsoft accounts
    `x-ms-exchange-organization-authas`. A message without the latter (from an older worker) on a Microsoft account
    waits for the user when it changes an event (the safe side). A header that ends inside a comment or quoted string
    counts only up to where that begins.
  - Known limit: the Microsoft rule rests on Exchange Online's documented header firewall and was not checked against
    a live tenant, nor whether consumer Outlook.com mailboxes carry the header at all.
  - Known limit: the mobile app has no apply action yet; mail that waits is applied in the web app.
  - Known limit: on IMAP accounts no `Authentication-Results` header can be trusted (the sender can write one naming
    any server), so nothing can be verified and calendar mail applies by its `From` address as before. A forged
    `From` that the receiving server let through can then move or cancel an event whose `UID` the forger knows.
  - Calendar mail (`REQUEST`, `CANCEL` or `REPLY`) the calendar did not take by itself (outside the inbox, or from
    before the account was connected) shows `canApply`; `POST /api/v1/messages/{id}/invitation/apply` applies it on
    the user's word, with the same checks, and a second apply changes nothing. `canApply` is false while the calendar
    it would change cannot take it (read-only, or scheduled by its provider), for a stored event as for a new one. Mail moved into the inbox later, or
    rescued from Spam, is recorded and applied then. When there is no calendar to write to (the account's default is
    read-only, or its provider schedules by itself) the apply is a 422 saying so, and the invitation stays to apply
    later.
  - `REQUEST` (new or updated invitation): if the user has the event with that `UID` in a provider calendar, the
    provider owns it (CalDAV servers with scheduling, Google and Microsoft put invitations into the calendar
    themselves) and nothing is written. Otherwise the event is created or updated in the account's default
    calendar (or the Tresso calendar when the account has none, created then for users from before calendars) with the
    user's `partstat` `NEEDS-ACTION`, so it
    shows in the calendar as unanswered. An older `SEQUENCE` than the stored one is ignored.
  - `CANCEL`: the event or occurrence is marked cancelled, under the same ownership rule.
  - `REPLY` (the user organizes): the attendee's `partstat` is updated on the user's event.
  - `COUNTER`, `REFRESH`, `ADD` and `DECLINECOUNTER` are shown on the message only.
- `GET /api/v1/messages/{id}/invitation` returns the invitation as clients show it: the event (expanded summary of
  the recurrence), whether it is new, updated or cancelled, the user's current response, conflicts with other busy
  events in the same time, and the event id in the user's calendar when there is one.
- An RSVP updates the user's `partstat` on the event and sends the reply the way the calendar's source needs it
  (provider API, CalDAV server scheduling, or iTIP). An iTIP `REPLY` goes through the outbox like any mail: a
  message to the organizer from the invited account (or, when no account sends as the invited address, the account
  the invitation came to), with a `text/calendar; method=REPLY` part holding only the
  replying attendee, the event's `UID`, `SEQUENCE`, `RECURRENCE-ID` when answering one occurrence, and the
  optional comment, and a short human-readable text part. Its subject follows the common form ("Accepted:
  Weekly sync").
- An event with attendees always names its organizer: the one it has, else the chosen mail account, else the
  calendar's account, on creation and when guests are added later.
- An event the user organizes with attendees sends `REQUEST` on creation and on changes that raise `SEQUENCE`,
  and `CANCEL` on deletion, through the same path when the provider does not do it.

#### Client sync

- The delta carries `calendars` and `calendarEvents` (series, overrides and single events as stored, without the
  raw iCalendar and provider state). Deleting a calendar implies its events are gone; deleting a mail account
  implies its calendars are gone.
- Clients keep them in their local store and expand recurrence locally (`packages/core`, `ical.js`), so the views
  work offline and switching weeks costs no request. The local copy is limited to events whose series touches the
  last 2 years or the future, which the API filters with `series_ends_at`; older history is read through the range
  endpoint. An event changed to end before that window comes as a deletion, so copies drop it.
- Expansion runs in each series' own zone, on the clock, the way the server's `Occurrences` does (the API's range
  endpoint is the reference): `ical.js` iterates the rule in wall time, hourly rules too, and every occurrence is
  turned into an instant through the platform's `Intl` zone data, so a 09:00 meeting stays at 09:00 across DST in
  its zone and moves for readers in another zone. A time that never happens is read with the offset from before the
  change; one that happens twice is the later one, as PHP reads it on the server (RFC 5545 would take the first),
  so every device and the server's reminders agree. The start always counts as the first occurrence, also when the
  rule would not give it or its `UNTIL` comes before it; an `UNTIL` date on a timed series is midnight of that
  date; a UTC `UNTIL` is compared as an instant, for floating series in the reader's zone. Rules of a fixed period
  without `COUNT` are jumped to near the range on the clock, as the server's `modify('+N hours')` does (an hourly
  series every 2 hours from summer stays on the even hours in winter); a walk that
  reaches 100,000 steps stops and the views say so. A rule that can never match (`BYMONTH=2;BYMONTHDAY=30`) is only
  its start: `ical.js` would loop forever on it, and days it normalizes into another month are left out. Recurrence
  ids, `EXDATE`s and `RDATE`s compare as the same keys the API uses; an override shows also when an `EXDATE` names
  its occurrence, and an override with `RANGE=THISANDFUTURE` (`thisAndFuture` in the delta) changes every later
  occurrence, moved as far as it moved its own. Rows stored before the API kept that flag get it from
  `bin/console app:calendar:reproject`, which projects the stored objects again in id order, a batch at a time,
  without changing their text or writing to a provider, and continues with `--after`. All-day occurrences begin and end at midnight in the reader's zone
  and last as many dates as their event.
- Finding the rows: every stored row carries the span of its whole series (its earliest start and latest end over
  the series and its overrides), so one indexed range read returns every row of each series touching the range,
  an override moved far away included; the views expand again only when a page changed calendar data. Ranges older
  than the copy (series ending more than 2 years ago are not in the delta) are read from `/calendar-occurrences`;
  their full event is fetched when one is opened, and an override read that way is edited as "This event". An end
  to end check against a real API compares device and server, after creating, moving one, renaming all from a moved
  occurrence, splitting and deleting, in four zones.
- Views (`packages/core/src/calendar`, shared by web and mobile): the time grid places timed events at their clock
  minutes (a DST day has 23 or 25 hours, blocks still sit at the hour their times say) and lets overlapping ones
  cascade, each taking the first free column of its group; events of a day or longer and all-day events go to
  lanes in the all-day row and the month weeks; a month cell shows three items, then "+N more". Times are written
  "10:00 to 11:00" and zones city first ("Amsterdam, CEST (UTC+2)").
- Editing: the editor saves the complete event with the occurrence's own times in the event's zone, through the
  series with the scope and the occurrence's `recurrenceId`. It offers "This event", "This and following" and "All
  events", without "This and following" on the first occurrence (it is all of them), without "This event" when the
  rule changes, and only "All events" for a move to another calendar. The stored rule is saved exactly as stored
  until the user changes a repeat field (moving one occurrence to Tuesday keeps `BYDAY=MO`, and a rule from Outlook,
  Apple or Thunderbird keeps its spelling), and rules are compared exactly as the server compares them (case, spaces and the order of parts aside), so a save
  never looks like a new rule that would drop every exception. A move to another day for "All events" or "This and
  following" keeps the rule as the editor sent it; the server moves its weekdays, day of the month or week of the
  month along with the series (`BYDAY=MO` by a day is `BYDAY=TU`), and overrides that kept their time move with
  it. "This and following" from a moved occurrence starts the new series at that occurrence's own time in the
  series, moved by what the user changed, and carries the override along. "All events" or "This and following" from a moved occurrence saves the series'
  own fields with only what the user changed. Invitations are answered, not edited; an update the calendar has not
  taken is applied before it is answered.
- Web client: day, week, month and agenda views, the event editor (vee-validate), the invitation card in the
  reading pane (RSVP, conflicts, "Add to calendar" for `canApply`), and a mini agenda next to mail. Keys: T, J and
  K, 1 to 4, N, E, Shift J (join), Esc; Y, M and N answer while the invitation card has focus. The month follows the
  ARIA grid pattern (rows of day cells, one day in the tab order, the arrow keys between days, Enter into a day's
  events and "+N more", Escape back). The day and week grid is a group per day with one event in the tab order (an
  event crossing midnight has one stop) and the arrow keys moving between events. Every event reads out title,
  time, calendar, place and answer. Mobile: an agenda of the next 30 days, a day view with the week
  strip, and the event detail with RSVP and the meeting link: a Join button named after the app (only for a link
  core's `canJoin` passes; the system opens it with `Linking.openURL`), the link as text through core's `linkText`
  (the host whole, read left to right, wrapping rather than cut again at large text sizes) with "Copy link"
  (expo-clipboard, so the app needs a development and store build that has it), who the link is from and the place
  as the other way to meet, and a link that is being made or could not be made in core's words. On a failed link the
  organizer has "Retry" (POST `/api/v1/calendar-events/{id}/meeting-link`, Meet and Teams), on the series; the
  phone has no "Leave without a link" yet.
- Reminders are scheduled and sent by the server (next section), so they reach every device, also when no app is
  open.

#### Reminders and notifications

Reminders are a reason to use Tresso over a default calendar: they fire on every device the user has, also when no
app is open, they know about travel and quiet hours, and they bracket a meeting with a brief before and a follow-up
after. Everything lives in `apps/api/src/Notification`.

- **What can remind:**
  - Event reminders: any number per event (up to 10 from the editor), each with an offset and its own channels.
    Stored as `VALARM`s in the event's iCalendar, so other clients see them too; the channels ride along as
    `X-TRESSO-CHANNELS` (an alarm without it means phone and desktop, `ACTION:EMAIL` means email). Alarms other clients set
    relative to the end or at a fixed time are kept and fire as well. An event without alarms uses the user's
    **default rules** (`defaultReminders`); `X-TRESSO-DEFAULT-REMINDERS:FALSE` means "no reminders at all".
  - Default rules (`reminder_rule`, `/api/v1/reminder-rules`): by calendar, timed or all-day, the user's role
    (organizes or invited), with or without other people, with an online meeting, with a place. The rule that sets
    the most conditions wins, ties by position. A rule gives reminders in minutes before the start, or for all-day
    events a time on the day before, and switches leave-now, the brief (minutes before) and the follow-up for the
    events it matches. New users start with 10 minutes before timed events and 09:00 the day before all-day events,
    both on the phone and the desktop.
  - A reminder's text is the event's time ("Thursday 22 October, 10:00 to 11:00") and its place after a comma. For
    an event with an online meeting it names the app instead, by the link's host alone (`ConferenceDetector::providerOf`):
    "..., on Microsoft Teams." (Google Meet, Zoom, Webex), or "..., online." for a link of no known app, then
    "Or in <place>." when the event has a place too (no second period after a place that ends in one, "!" or "?").
    A place that only says the event is online is left out: an app's name or its last word, or "online", alone or
    with one of the words a meeting is written with (meeting, vergadering, besprechung, réunion, reunión, call, link):
    "Microsoft Teams Meeting", "Teams", "Online". "Zoom Room" or "Teams-kamer" is a place. A link that
    `MeetingLinkAddress` refuses (a user name in it, no real host) is not called a meeting; the text then reads as
    for an event without one. Every channel (phone, desktop, email) gets this one text.
  - No notification holds a link, and the geocoder never gets one (`App\Notification\EventPlace`): every text that
    shows the place (reminders with or without a meeting, leave-now) uses the place without links, and the travel
    estimate, leave-now and the "with a place" condition of rules use it too, without a place that only says the
    event is online. Words are split at whitespace, and a word goes as a whole when it holds `://` (also app schemes
    such as `msteams://` and a link glued to a word) or starts with `www.`: commas and semicolons belong to links (a
    query, a map position, a Teams context). Any other word is split at commas and semicolons, and a part goes when it
    is a host in lower case followed by a path, query, fragment or port (also an IP address), or a host of a known
    meeting app (`ConferenceDetector::HOSTS`, and names under them) in any case, since phones capitalise a typed
    "Zoom.us/j/...". A place name with a dot and a slash in capitals ("St.Pauli/Hamburg", "U.S./Canada") stays; a
    lower case place written like a host, such as "kamer 2.og/3", loses that word. A bracket group left with only a
    label ("(see <link>)"), empty brackets, left over separators and a colon at the end go with it, whitespace inside
    is collapsed to one space and separators at either end are trimmed. A place that is only a link, or only says
    "online", gets no leave-now and no estimate. Every step is linear in the length of the place, since a place can
    be any length and is read for every occurrence. Known limits, decided:
    - A meeting id or passcode typed as plain text in the place ("Zoom ID 123 456 7890 Passcode 4321") cannot be
      told from a place and is shown.
    - A bare host without a path, query, fragment or port ("zoom.us") is shown, as is a host of an unknown app typed
      with capitals ("Jitsi.example.org/room").
    - `localhost` and other hosts without a dot are not recognised as links and are shown.
    - The tail of a link broken by a space is a word of its own and is shown; a word glued to a link after a comma
      without a space ("<link>,Room 1") goes with the link.
    - E-mail addresses and `tel:` numbers are not links and are shown.
    - The title is the user's own subject and is shown as it is.
  - **Leave now** (switched off as a whole with `leaveNow` in the settings): for timed events with a place. With a
    travel time set on the event (`travelMinutes`, stored as `X-TRESSO-TRAVEL-MINUTES`; Apple Calendar's
    `X-APPLE-TRAVEL-DURATION` is read too) it fires at start minus travel minus the user's extra time (0, 5 or 10
    minutes, `extraTravelMinutes`). When the matching rule asks for leave-now, the travel time comes from the phone:
    the position is read on the phone only, from an hour before such an event until it starts, and is never stored
    or logged on the server. The phone sends it for one estimate (`POST /api/v1/calendar-events/{id}/leave-estimate`
    with the position and the occurrence), the `TravelTimeEstimator` computes the minutes for the user's way of
    travel (`travelMode`: walk, bike, public transport, car), and the reminder moves to the moment to leave. From an
    hour before the start, while no estimate came, the server asks the user's phones for one with a silent push
    (`kind: leave_estimate`, data only, every 15 minutes); without one by shortly before the moment to leave, there
    is no reminder rather than a guessed one. Tresso geocodes with Nominatim and routes with OSRM, one
    server per profile (`ROUTING_OSRM_URL` for the car, `ROUTING_OSRM_BIKE_URL`, `ROUTING_OSRM_FOOT_URL`,
    `GEOCODER_NOMINATIM_URL`); public transport has no estimate there (OSRM has no timetables), so it needs a travel
    time on the event or another estimator.
  - **Pre-meeting brief:** for events with other people. At delivery the `MeetingBriefWriter` writes it: the built-in
    one names the people and the recent threads with them (last 60 days, from mail metadata, nothing leaves the
    server); an AI summary is planned. `GET /api/v1/calendar-events/{id}/brief` returns the full brief.
  - **Follow-up nudge:** at the end of a meeting with other people, to write notes: private notes on an event or an
    occurrence (`PUT /api/v1/calendar-events/{id}/note`, in the delta as `eventNotes`, never sent to a provider) and,
    once todos exist (phase 2), todos. A note hangs on the row that shows its occurrence and follows it: to an
    override when the occurrence gets one, back to the series when the override goes, to the new keys when "all"
    moves the series, to the new series of "this and following", and to the new resource when the event moves to
    another calendar. An occurrence changed by an override with `RANGE=THISANDFUTURE` keeps its note on that override's
    row, as the occurrences answer shows it. A resource the provider reports under a new `UID` (the same href) is the
    same event, and its notes go along. A note whose occurrence no longer exists stays with the event. Two notes that
    end up on one occurrence are joined. Notes of an event that is deleted leave tombstones like other synced data;
    so do those of an event moved to another calendar outside Tresso, which reaches Tresso as a delete in one calendar
    and a new event in another and cannot be told apart from those.
- **Channels:** `phone` reaches the user's Expo devices, `desktop` the desktop app and browsers with web push, `email`
  the address in the settings (or the sign-in address) from the system sender `NOTIFICATIONS_FROM`. Reminders carry
  their own channels; other kinds use the user's choice per kind (`channelsByKind` in the notification settings,
  keyed by kind name so other features add their own), else the kind's default: leave-now on the phone, briefs and
  follow-ups on the desktop, new mail and hand-overs past their due date (`hand_over`, 3.15) on the phone and the
  desktop. Devices register with `POST /api/v1/notification-devices`:
  - Web push (`web_push`): the browser's subscription. Messages are encrypted per RFC 8291 (aes128gcm) and signed
    with VAPID (RFC 8292, ES256) on ext-openssl, checked against the RFC's own example. Endpoints come from clients,
    so they must be https and requests refuse private networks. Keys come from `WEB_PUSH_PUBLIC_KEY` and
    `WEB_PUSH_PRIVATE_KEY` (`bin/console app:notifications:vapid-keys`); clients read the public key from
    `GET /api/v1/notification-devices/web-push-key`.
  - Mobile (`expo`): the Expo push token; sent through Expo's push service (`EXPO_ACCESS_TOKEN` when the project
    requires it). A `PushMessage` names its Android notification channel; the phone creates `reminders` (calendar
    notifications, the default) at high importance (a banner, with sound) and `reminders_silent` at low importance without
    sound for silent deliveries, at every launch (on Android the channel decides sound). Mail notifications go to
    `mail` and `mail_silent`, which the phone creates the same way. Expo's receipts are read some minutes after each
    send, and phones they report as `DeviceNotRegistered` are removed.
  - Desktop (`desktop`): no push service; the delivered notification reaches the running app through the delta
    (`notifications`, and `mailNotifications` for mail) and the realtime ping that comes with every change, and the
    app shows it natively.
  - A subscription the push service reports gone (404, 410, `DeviceNotRegistered`) is removed.
- **Quiet hours, working hours and focus** (`/api/v1/notification-settings`), in the user's time zone:
  - Quiet hours per day (past midnight they end the next day). A notification that fires in quiet hours for an
    event that starts after them is moved to their end; otherwise it is delivered silently (no sound, low urgency,
    shown in the list).
  - Working hours (`workDays`, `workStart`, `workEnd`) apply to calendars the user marks as work (`work` on the
    calendar). Hours that end at or before they start run past midnight: 22:00 to 06:00 on Monday lasts until Tuesday
    06:00, and 09:00 to 00:00 ends at midnight. Hours that end when they start last a whole day (00:00 to 00:00 on
    every day is around the clock). The meeting time finder reads them the same way. Their notifications wait for the next working hours when the event starts after that, and are
    silent otherwise (`workCalendarsQuiet`); leave-now comes through. A reminder that would come before the working
    day, for an event that also starts before it, comes at the end of the working day before instead
    (`shiftEarlyReminders`: a reminder for a 08:00 meeting at 17:30 the evening before).
  - Focus blocks (busy, no one else, titled "Focus..."): while the user is in one, notifications wait until it ends
    (`holdDuringFocus`); reminders of meetings with others and leave-now come through. With `focusDuringBusy`,
    while the user is in another busy event they take part in, notifications of events they are invited to are
    delivered silently; their own meetings and leave-now alerts break through. Mail notifications wait for the end
    of a focus block too, and for the end of a meeting the user takes part in (busy, with other people;
    `holdMailInMeetings`, on by default); in quiet hours and, with `focusDuringBusy`, in other busy events they come
    silently.
  - Important events (`important`, stored as `PRIORITY:1`; `PRIORITY` 1 to 4 from other clients counts too) come
    through quiet hours, working hours and focus.
- **Scheduling:** `scheduled_notification` holds one row per occurrence, kind and reminder, planned for the next 8
  days. Saving or removing a calendar object queues a replan of that object (`PlanCalendarObject`, transport `push`,
  after commit); rule, time zone and location changes replan the user. Every new or moved plan is a delayed
  `FireNotification` for its fire time. A Symfony Scheduler task (`scheduler_notifications`) sweeps every minute:
  it delivers due notifications whose message got lost (up to two hours late) and extends the plan for users whose
  plan ends within a week. A delivered notification is never planned again.
- **Idempotent delivery:** delivery takes a lock on the notification, checks it is still current and marks it
  delivered. Then the `NotificationDispatcher` sends it: given a user, a `PushMessage` (id, kind, title, body, a
  path in the app or none, silent, and a data map), a delivery key and the channels, it claims one
  `notification_delivery` per key and target (unique, `INSERT ... ON CONFLICT`) before anything is sent, so a
  retried message or a sweep never notifies a device twice. For calendar notifications the claim is part of the
  transaction that marks the notification delivered, so a crash before the sends leaves claimed rows to retry, never
  a delivered notification nobody sends. Sends happen after that commit, their outcome is recorded afterwards, and
  devices the push service no longer knows are removed. A failed send is tried again by the sweep after a pause that
  doubles each time (at most 5 attempts), and one that never reported back (a crash) after 10 minutes; a send that
  went out never is. A retry reaches only the targets of the first delivery, not devices registered since. The sweep
  delivers each notification on its own: one that fails is logged and moved 5 minutes later (dropped once its event
  is 2 hours past), and the other notifications, the receipts and the planning go on. Calendar notifications use the key `calendar:{notification}:{round}`,
  mail notifications `mail:{notification}`; any other feature sends through the same dispatcher with keys of its own.
- **New mail:** only new mail that needs the user notifies: a message whose first classification is `do` or
  `delegate`, unread, in an inbox, not in a conversation the user placed elsewhere themselves (their placement wins
  over the message's own verdict), and received in the last hour (an account's history being fetched is not news).
  Classification hands the messages it classifies for the first time to the `MailNotifier` in its own transaction;
  classifying again (after a rule or a correction) never notifies, so a settings change cannot push a burst of old
  mail. The notifier keeps one `mail_notification` per message (unique on the message, under the user's
  classification lock), so a message notifies at most once, whatever runs again. The same mail in two of the user's
  accounts (one Message-ID within the last hour) notifies once: the later copies get a notification that is dropped
  at once. `needsTheUser()` is the one rule both planning and delivery ask. After the commit a
  `SendMailNotification` (transport `push`) delivers it under a lock on the row: the message must still need the user
  (unread, `do` or `delegate`, in an inbox) or the notification is dropped; a focus block or a meeting holds it until
  its end (a delayed message comes back then); quiet hours and other busy events make it silent; no channel chosen
  for `mail` drops it. It goes out with the sender as title, the subject (with "To hand over: " for `delegate`) and
  the start of the text as body, `/thread/{thread}` to open, and the Android `mail` channel. With previews off
  (`mailPreviews` in the settings, on by default) it says only "New mail from {account}", and from the moment it is
  planned the row keeps no more than that (also while it waits, and when it is dropped or a deduped copy), so neither
  a push service nor the delta sees the sender, subject or text. Expo pushes pass through Expo,
  Apple and Google unencrypted (TLS on the way only); Web Push is encrypted end to end (RFC 8291), so only the browser
  reads it. The dispatcher names the user every push is for (`userId` in its data), whichever feature
  sends it. The claim is part of the
  transaction that marks it delivered, as for calendar notifications, and a second scheduler task
  (`SweepMailNotifications`, every minute) delivers what a lost message missed and sends failed or stuck deliveries
  again. Nothing is delivered more than 2 hours after its time. Delivered ones reach the delta (`mailNotifications`:
  the message, thread, title, body, channels and whether it was silent, from the last week), which is how the desktop
  app shows them; waiting and dropped ones never do.
- **Lateness:** nothing is delivered more than 2 hours after its time, nor a reminder more than 15 minutes after its
  event started (or after its own later time, for alarms relative to the end and snoozes); follow-ups are the
  exception. A replan that moves a notification into the past drops it.
- **Replans:** plans are recomputed on every change of the event, the rules or the settings. A fire time set by a
  snooze or by a postponement (quiet hours, working hours, a focus block) is kept: a replan never moves the
  notification before it, unless the event moved to start before that time; then the hold goes, and a reminder whose
  own time has passed comes at once. A notification belongs to its occurrence, not to the row the occurrence takes
  its fields from: when an override (or one for this and future occurrences) appears or goes, the notification moves
  along with its snooze, hold and deliveries, so it is neither lost nor sent twice. When a row goes, the projector
  moves its notifications to the series row before deleting it, and the replan takes them from there. When an occurrence moves after
  its notification was delivered, the notification starts a new round at the new time, if that is still ahead;
  "moves" means its start as the event writes it changed (a date, a wall clock or an instant), so a change of the
  user's zone alone never sends an all-day or floating reminder again. A focus block never holds a notification past the start of
  its event; it comes silently instead. Planning runs per user in the sweep; a user whose planning fails is logged
  and tried again an hour later, and the others go on.
- **In the apps:** `GET /api/v1/notifications` lists the last week and the coming days; `POST .../dismiss` clears a
  notification on every device (the delta carries `dismissedAt`), `POST .../snooze` delivers it again later (a new
  round): after some minutes, or `until` one of the choices a reminder offers (`snoozeChoices` in the settings: 5,
  10 or 15 minutes, one minute before the start, the start, or the end of the meeting the user is in now). A snoozed
  notification is in the delta with `deliveredAt` null and `snoozedUntil` (moved by quiet hours too), so every device
  hides it until it comes again. One waiting for its occurrence's new time (a new round after the event moved) has
  `deliveredAt` and `snoozedUntil` both null: hidden too, but not shown as snoozed. Planning a notification that never
  reached a device is no change for clients (no change number, no realtime ping).
- **Devices and addresses:** a push endpoint belongs to one user: registering it removes it from whoever had it
  before (someone signed out on that phone). Registrations of one endpoint take turns (an advisory lock), so two at
  once do not fail on its unique key. Known limit: Expo gives no proof that the caller holds the phone, so anyone
  who learns another user's Expo push token can register it and receive that user's reminders and mail notifications until the owner's app
  registers again (each launch). Binding a registration to a challenge sent to the device is a later step (C4, with
  the phone's push registration); web push endpoints are unguessable capability URLs. Email notifications go only to an address the user holds:
  - At once: the sign-in address, or a Google or Microsoft account's address that the provider confirmed (the
    account's address is the one of its provider grant; a Microsoft account only once it synced, since Graph's `mail`
    is a directory attribute a tenant administrator can set to anything; `NotificationAddresses`).
  - Any other address (an IMAP account's included: it is typed in next to servers of the user's own choosing, and a
    server of one's own accepts any username, so neither a sync nor a matching username proves it) waits as
    `pendingEmailAddress` on `PATCH /api/v1/notification-settings`. Tresso mails a signed link to it, valid two days
    and built from `API_PUBLIC_URL` (`NotificationEmailAddress`), once the change committed; opening it shows a page
    with a Confirm button (a mail scanner that opens links confirms nothing), and confirming makes it the notification
    address. Until then notifications go where they went (`effectiveEmailAddress`). Choosing it again sends the link
    again (`pendingEmailAddressSentAt`); choosing the current address again drops the pending one. At most three links
    a day go to one address, whoever asks, and five a day per user (429 after that). A link works while its address
    is still the pending one. A link that could not go out is tried again with the next notification.
  - How a chosen address was shown to be the user's is recorded when it is chosen (`email_address_proof`: sign-in
    address, provider, link). One that stops counting (its account removed or renamed, a provider no longer
    confirming it) falls back to the sign-in address without any mail. Only an address that was never proven (stored
    before this was recorded: the migration gives existing rows the proof they have at that moment, so an IMAP
    account's address gets none) is moved to pending the first time a notification would be mailed to it, with a
    link; until it is confirmed, notifications go to the sign-in address.
  The web and mobile apps have no field for this address; it is set through the API or the MCP tool.
- **Time zones:** quiet hours, working hours, all-day reminders and floating times (date-times without a zone) are
  read in the user's zone from the notification settings (`timeZone`, UTC until a client sets it). The web app, the
  desktop app and the phone send the device's zone the first time a user signs in there and again when they come to
  the front in another zone (`keepTimeZone` in `@tresso/core`). Each device remembers per user the zone it last sent,
  so a reload does not send it again and take the zone back from a device the user moved on to.
- **Deployment:** this stage (C3) needs the calendar core (C2) in the same deploy: the planner reads
  `default_reminders` and the other projection columns C2 adds.

#### Online meetings

Calendars list the meetings their provider makes (`conferenceProviders`: `meet` for Google calendars that allow
Meet, `teams` for Microsoft calendars with Teams for work or school). The editor asks for one with
`conferenceProvider` on create or update; the API refuses a provider the calendar does not list, and otherwise marks
the series with `X-TRESSO-CONFERENCE-REQUEST` (nothing when it has a meeting already). The worker turns that into
Google's `conferenceData.createRequest` (`conferenceDataVersion=1`, `hangoutsMeet`) or Graph's `isOnlineMeeting` with
`onlineMeetingProvider: teamsForBusiness`, and reports the provider's version, with the join link and without the
request, as the stored object. The conference is then read like any other: Google's video entry point as RFC 7986
`CONFERENCE` and `X-GOOGLE-CONFERENCE`, Graph's `onlineMeeting.joinUrl` as `CONFERENCE` and
`X-MICROSOFT-SKYPETEAMSMEETINGURL` (the toll number as a `tel:` conference). Join links found in descriptions and
locations of other events (Zoom, Teams, Meet, Webex) are recognized as well, so every event with a meeting has a
`conference.url` for the join button. Personal Microsoft accounts and CalDAV or Tresso calendars get no meeting from
their provider; a link pasted into the event (`conferenceUrl`) works everywhere.

Worker contract for meeting links (the API side is in `EventEditor`, `CalendarOperations` and `CalendarSynchronizer`):

- A request is `X-TRESSO-CONFERENCE-REQUEST:<meet|teams>` with `X-TRESSO-CONFERENCE-NONCE:<8 hex>` on the master. The
  API keeps its state on the object (`conferenceRequest`: pending, or failed with `refused`, `not_supported` or
  `unreachable`) because the provider's version drops both properties. A new request (after a failure, a removal or
  120 seconds) has a new nonce; Google's request id is derived from the UID and the nonce, so it makes a new meeting.
- The result of a write may carry `conferenceStatus` (`pending` while the provider is still making it, or `failed`)
  and `conferenceError` (`refused`, `not_supported`), and nothing when the meeting is there or none was asked for.
  A request still pending five minutes after it was asked for, with no write of the event waiting, is failed
  (`refused`): by the next synced version without a meeting, or else by the `SweepMeetingRequests` run every minute on
  the maintenance worker (which gives the event's row a new change number, so clients see it, and reads only the
  rows with a request, through the partial index `calendar_object_conference_request`). A synced version that
  has the meeting clears the request whatever its state.
- Removal of a Google Meet meeting: the master carries `X-TRESSO-CONFERENCE-REMOVE:meet`. Only then, and only when the
  user organizes the event, does the worker patch `"conferenceData": null` (with `conferenceDataVersion=1`); a master
  that merely lacks `X-GOOGLE-CONFERENCE` is never a reason to remove Google's meeting, and a marker on an override is
  ignored. A new request clears the marker, the provider's version drops it, and a move to a calendar that is not
  Google's leaves it behind (with a request the new calendar cannot serve).
- A Teams meeting Graph made cannot be removed (`conference.removable` is false); the API refuses the change.
- A link the API knows (the user's own) travels as `CONFERENCE` and as the last line of the description, "Join the
  meeting: <url>" or "Join with <App>: <url>" (`MeetingJoinLine`); Google and Microsoft keep the line, and the
  detector reads it back. Into Graph's HTML body it goes as escaped text. The line is read as the last such line
  anywhere in the description, and as Exchange may give it back in a text body (the address again in angle brackets
  after it, more spaces after the colon). The API and the workers read it by one rule, tested on both sides against
  `apps/api/tests/Fixtures/meeting-join-lines.json`.
- Deploy order: the API before the workers. The workers send `conferenceStatus` and `conferenceError` and read the
  nonce and the removal word; an API without them ignores the fields and writes neither property, so nothing changes
  until it is out. Workers older than the API keep working, without the outcome reports and without removal.
- "Leave without a link" is `DELETE /api/v1/calendar-events/{id}/meeting-link/request` (a path of its own, so an
  older server answers 404 or 405 instead of running the plain `DELETE`; servers that have it say
  `meetingRequestDrop: true` in `GET /api/v1/calendar/capabilities`, and clients hide the button otherwise). It drops
  the series' pending or failed request and nothing else. When the series has a link (it arrived after the client last
  looked) it answers 409 and changes nothing; it never removes a link, never notifies guests and never writes
  `X-TRESSO-CONFERENCE-REMOVE`. A request still in the iCalendar text goes out with a write that only lacks the
  `X-TRESSO-CONFERENCE-*` properties (asking the provider for nothing, with `notify` false); one only on the object is
  cleared there. A write that already carried the request to the provider may still come back with a meeting: then
  the link appears seconds after a successful drop, and clients show it from the delta like any other. The plain
  `DELETE .../meeting-link` still removes the link.
- A save with `conferenceUrl: null` and `conferenceProvider` X on an event that has a meeting of app X keeps it: no
  removal, no new request, no write about the meeting (a client's copy may predate the link). This holds for the event,
  one occurrence and the whole series, and for a move within the same mail account. A "this and following" split and
  a move to another account's calendar make a new event at the provider, which asks for a meeting of its own. Removal
  is both fields null or `DELETE .../meeting-link`; another app replaces the link; a fresh link of the same app is
  `DELETE` then `POST .../meeting-link`.

The web and desktop clients show an event's link in the popover as the app's name (from `conference.provider`, which
the server sets only for a link on that app's own host; anything else reads "Meeting link"), the link on one line
(core's `linkText`: whatever comes before the host and the host itself stay whole, so a lookalike such as
`teams.microsoft.com.evil.example` shows where it leads also without a scheme or with odd slashes; a user name before
an `@` is left out; only the path is cut in the middle, and a host longer than the line loses its left end), Join
(Shift J) and Copy link, and the dial-in number. Wherever a link is shown in full (a title, a link without Join) it
goes through core's `displayLink` (characters that show nothing or turn text around become a visible U+FFFD, at most
300 characters), left to right and isolated from the text around it; only the link to copy by hand after a refused
copy is shown whole when it passes `canJoin`, in a box that scrolls. The agenda, the mini agenda and the invitation
card have a Join button labelled by core's `joinLabel` ("Join with Microsoft Teams"); the week and day grid mark such
an event with a small camera. Every Join, button or key, goes through core's `canJoin`: a link it refuses (no https, a
host whose letters may imitate another, a host without a dot, a user name before the host) gets no Join and is shown
as text with Copy link. Join opens a new tab without opener or referrer in the browser, and the user's browser through
the shell's opener on the desktop, never the app's own window. Copy writes the whole link to the clipboard on a click
only and says "Copied" for 2 seconds; when the clipboard refuses, the whole link is shown to copy by hand. A link that
was asked for (the series' `conferenceRequest`, also for a moved occurrence) shows "Making the Teams link" while it is
pending and younger than 120 seconds (on the server's clock), and, to the organizer, "Could not make the Teams link"
with core's reason once it failed or took longer. A link is never written to a log, an error message or analytics; the
desktop shell logs a failed open with the link's scheme only. `conference.removable` says whether the API takes a link
off (false for a Teams meeting Microsoft made); core's `meetingRemovable` falls back to its own rule for rows stored
before the server sent it.

What the workers do with it (`apps/sync/internal/googlecal`, `graphcal`):

- The request, the nonce and the removal word are read on the master only; the same properties on an occurrence are
  ignored, and a guest's copy is only ever answered (response and reminders), never given or relieved of a meeting.
- Google: the `createRequest.requestId` is derived from the UID and the nonce (from the UID alone without a nonce). A
  request on an event that already has a meeting sends nothing. A write Google answers with 400 while it carries the
  request is sent once more without it: the event is saved and the result says `not_supported`. A refused removal is
  sent again without it as well; Google's meeting then stays and its version shows it.
- Graph: a Teams meeting is asked for with `isOnlineMeeting` and `onlineMeetingProvider` on create, or on a patch of
  the organizer's master that is not an online meeting yet. A calendar without Teams gets the event without the
  meeting, reported as `not_supported`, and so does a write Graph answers with 400 while it carries the two fields
  (sent once more without them). Nothing ever sets `isOnlineMeeting` back.
- The result of a done write whose master asked for a meeting the provider's version lacks: `pending` when Google's
  request status is `pending`, when Graph has the event as an online meeting without a join link yet, or when the
  version could not be read back; else `failed` with `not_supported` or `refused`. Only these codes are reported:
  never provider text, never a link. Meeting links are never logged.
- Graph's body: a description with a join line is written as HTML of escaped text (line breaks as `<br>`). When the
  body has a Teams join block, the user's text goes before the block, and the join line (with what the user wrote
  below it) after it. What Tresso put after the block before is no part of the block: from the end, the last div or
  paragraph (also with attributes, a link inside or wrapped in another div, as Exchange may rewrite it) is dropped
  when its first line is a join line, and so are the wrappers it leaves empty. One element with text at most, and
  never the block's own first element: what stands above it is someone else's and stays. A join line the block still
  carries (below other text in its paragraph, or above a paragraph without one) is the block's and is not written
  again; the tail starts at the first join line after the block's text that the block does not carry. So nothing is
  doubled and nothing someone else wrote is lost, and a changed or removed link leaves nothing behind; the text below
  a removed line stays when the description still ends with it. An own link has no meeting outcome to report, so a
  join line left in the block changes no result.

Settings, Meeting apps (web and desktop) reads and writes `GET`/`PATCH /api/v1/calendar/meeting-preferences` through
the `meetingApps` store, and every control saves at once (a failed save shows the field's message under the control,
puts the old value back and reads the preferences again). The store sends reads and changes one after the other and
builds each change from the latest answer, since the server replaces `defaults` and `disabled` whole; the page reads
the preferences on opening and when the window comes back to the front. The Google Meet card has a row per Gmail account and the Microsoft Teams card one per Microsoft account
whose calendars can have Teams (or are not synced yet): connected, not connected (switched off in Tresso through
`disabled`, or no calendar access, which Connect asks for) or permission expired (Reconnect signs in again). Disconnect
only switches the app off in Tresso. The own link is checked with core's `meetingLinkProblem` before it is sent. The
default app table lists per account with a writable calendar the apps core's `meetingChoices` allows there, an app
that cannot serve it right now with what is missing in brackets, and says which apps are not offered and why; "Every
other calendar" sets `defaultOther`. Zoom and Teams for other calendars need the server owner first and have no card;
Zoom is listed as a choice only when `apps` has it. The popover reads the own link from the same store, for "My own
link".

The event editor's "Meeting link" row (`MeetingLinkRow`) shows the state core's `meetingRow` names for the event's
calendar, its mail account and the preferences: off, no app, before saving, the own link, being made, made, failed,
reconnect, an app that cannot serve the calendar or the account, and removed. The first guest switches it on with the
calendar's default when "Add a meeting link when I invite guests" is on and the user has not used the switch; a
changed calendar follows its default unless the user picked an app. The save sends Meet or Teams as
`conferenceProvider` and the own link as `conferenceUrl` only when the user switched a new link on or picked an app;
a removal (both null) only when the user removed the link, which is offered only where core's `meetingRemovable`
allows it. Anything else sends the link and the request as the server has them at the save (read then, so a link made
since the editor opened is never removed), without a provider the event's calendar does not list. Retry and Leave
without a link call `POST` and `DELETE /calendar-events/{id}/meeting-link` on the series and keep the editor open.
Connect a meeting app keeps the editor's values in memory and opens Settings, Meeting apps, whose "Back to the event"
reopens it. On an event someone else organizes the editor only says who added the link.

#### AI features (interfaces with built-in and planned AI implementations)

Tresso defines the interfaces and, where a deterministic version is useful on its own, implements it. The planned AI
versions decorate these services, with the server's own AI key or endpoint; `GET /api/v1/calendar/capabilities`
tells clients which features are available, so they show only what works.

| Interface | Built in | Planned AI version |
|---|---|---|
| `EventDraftInterpreter`: free text ("lunch with Sam Thursday 12:30 at Café Loos") to an event draft | none (capability off) | AI interpretation in the user's language and time zone |
| `MeetingTimeFinder`: proposed slots for a duration, attendees and a window | free/busy of the user's own calendars within working hours | adds attendees' availability where it is known and ranks by preferences and habits |
| `EventExtractor`: events and deadlines in a message | the message's `text/calendar` parts | AI extraction from the text, deadlines offered as todos |
| `MeetingBriefWriter`: a brief before a meeting (who, previous threads, open todos, attachments) | attendees and the recent threads with them, from mail metadata | AI summary of the related mail and todos |

Drafts from these features are never saved by themselves: the client shows them in the event editor or as
suggestions, and the user saves. Content goes only to the AI provider the server is configured with.

The interfaces live in `apps/api/src/Calendar/Assistant`, each with its built-in implementation registered as
the alias an AI version decorates:

| Call | Purpose |
|---|---|
| `GET /api/v1/calendar/capabilities` | `eventDrafts`, `meetingTimes`, `attendeeAvailability`, `eventSuggestions`, `textSuggestions`, `meetingBriefs`, `briefSummaries`: what this server offers. The built-in implementations answer `false` for `eventDrafts`, `attendeeAvailability`, `textSuggestions` and `briefSummaries`. |
| `GET`/`PATCH /api/v1/calendar/scheduling-preferences` | What the finder keeps free besides the working hours: `bufferMinutes`, `travelMinutes` and `minimumNoticeMinutes` (scopes `settings:read`, `settings:write`; JSON merge patch). |
| `POST /api/v1/calendar/meeting-times` | Proposed slots for a duration in a window (below). |
| `POST /api/v1/calendar/event-drafts` | Free text to an event draft; 501 where `eventDrafts` is off. |
| `GET /api/v1/messages/{id}/event-suggestions` | Events (as drafts in the editor's shape, with the stored event's id when the calendar has it) and deadlines found in a message. The built-in one reads the `REQUEST`, `PUBLISH` and `ADD` calendar parts, and finds no deadlines. |
| `GET /api/v1/calendar-events/{id}/brief` | The pre-meeting brief (see reminders above); `summary` is null until an AI version is configured. |

##### Meeting time finder

The finder is deterministic and explainable: the same calendars, preferences and moment give the same slots in the
same order, and every slot says what closes its free time on each side. "Now" comes from the Symfony clock, so tests
fix it. Planning a todo ("Plan automatically") uses the same `MeetingTimeFinder::find` with
`MeetingTimeQuery::beforeDeadline($now, $deadline, $minutes, $ignore)`: one slot, no attendees, from now to the
deadline (only the next 92 days of a later deadline), with `ignore` holding the todo's own planned time when it is
planned again. A deadline that has passed, or a duration outside 5 minutes to 24 hours, is an
`InvalidMeetingTimeQuery` naming the field; a calendar too full to look through is `TooManyOccurrences`.

- **Working hours and zone** are those of the notification settings (`workDays`, `workStart`, `workEnd`,
  `timeZone`), the same ones the reminders keep to, including hours past midnight (a night shift is one stretch from
  its start to its end the next morning). A search may name another zone (`timeZone`).
- **Scheduling preferences** (`scheduling_preferences`, one row per user, created on the first change with an upsert
  and changed under a row lock, read again once locked, so two changes at once neither collide nor work from an
  older read):
  `bufferMinutes` (0 to 120) on both sides of busy time, `travelMinutes` (0 to 240) to and from busy time at a place
  that does not name its own travel time, and `minimumNoticeMinutes` (up to 14 days). All are 0 without a row. The
  same row holds `planTodos` (off without a row), the switch that plans todos on their own (see "Todos in the
  calendar" in 3.14).
- **Busy time** comes from every `BusyTimeSource`: the built-in one reads the user's visible calendars (or the
  `calendarIds` a search names) through the occurrence expander, so recurrence, overrides, exceptions and time zones
  are those of the range endpoint. An occurrence is busy when it is marked busy, not cancelled and not declined;
  tentative and unanswered invitations count. All-day occurrences take their days from midnight to midnight in the
  search's zone. An occurrence is at a place when its location is not a link and does not just name the service of its
  online meeting; an event's own travel time (set for leave-now) is its travel time here. A focus block is what the
  reminders take for one: a timed busy event of the user's own, without guests, titled "Focus...". Planned todos are
  another source (`TodoBusyTimes`): the planned time of open todos, referenced by the todo's id. They are in no
  calendar, so they count whichever calendars a search names. Their label is the todo's title only for a caller with
  the todos read scope; others (an app with calendar access only) see "Planned todo".
- **Attendees' busy time** comes from every `AttendeeAvailabilitySource`; Tresso has none built in, so an attendee's
  availability is `unknown` and closes nothing, except for the user's own addresses, which are known. A provider's
  free/busy (Google, Microsoft Graph, CalDAV scheduling) can be added as a source. A source may also give an
  attendee's working hours with their zone; the time outside them is then busy for that attendee.
- **The search** (`SlotSearch`, framework-free):
  1. The window starts at the later of `from` and now plus the notice, and ends at `to` (at most 92 days later).
  2. Open time is the working hours in the window (or the whole window with `workingHoursOnly: false`), read on each
     local day in the zone: a day with a daylight saving change keeps its clock times and is an hour shorter or
     longer, and a time the clock skips starts when the clock jumps (working hours from 02:30 on the day summer time
     starts at 02:00 begin at 03:00). Overlapping and touching ranges are merged.
  3. Closed time is taken out: busy time, with the buffer on both sides, or the travel time when the busy time is at
     a place or names its own travel time (or the new meeting is in person, `inPerson`) and travel takes longer; focus
     blocks as they are, without buffer; and the busy time of required attendees whose availability is known. Busy
     time that takes no time closes nothing. Closed time with the same start and end is ordered by kind and label, so
     a slot is explained the same whatever order the sources gave it in. `ignore` leaves out events (by id) or single
     occurrences (by occurrence id), such as the meeting being moved.
  4. Slots start on multiples of `stepMinutes` (5, 10, 15, 20, 30 or 60) past the hour on the user's clock, also in
     zones with a half-hour offset, and fit in what is left.
  5. Slots are ranked by how many optional attendees are busy then (`optionalConflicts`), then by start; slots that
     overlap a better one, and slots over `perDay` on one local day, are left out, up to `limit` (at most 50).
- **The answer** lists the slots best first, each with `freeFrom` and `freeUntil`: the instant, the reason (`window`,
  `notice`, `working_hours`, `focus`, `busy`, `buffer`, `travel` or `attendee`) and a label (the busy time's title, the
  focus block's title, or the attendee's address). With no slot, `noSlotReason` is `window_passed`,
  `no_working_hours` or `no_free_time`. It also names the zone used and each attendee's availability.
  `describeSlotEdge` in `packages/core` turns an edge into words for the client.

### 3.14 Todos

- A todo (`todo` table) belongs to one user: title, notes, an optional due date with an optional time, an optional
  duration in minutes, a done moment (`completedAt`), a place among the open todos (`position`), where it came from
  (`source`: `manual`, `suggested` for an accepted AI suggestion, `automatic` from a smart inbox) and optionally the
  email it came from. The due date and time are wall-clock values in the user's own time zone, like a paper diary:
  "Friday 17:00" stays Friday 17:00 when the user travels. The duration and due date are what "Todos in the
  calendar" (below) builds on.
- One email has at most one todo: a unique index on `todo.message_id`, and every path that makes one from an email
  takes the user's todos lock first (lock order: smart inboxes, classification, todos). Deleting the email (or its
  account) clears the link, keeps the todo, and gives it a new change number, so clients drop the link too.
- `/api/v1/todos` (scopes `todos:read`, `todos:write`) lists (open ones in order, then done ones, most recently done
  first), creates, updates (JSON merge patch: fields left out stay, `null` clears the due date, time or duration; a
  cleared date takes its time with it; `done: true` or `false` completes or reopens, keeping the first completion
  moment) and deletes the user's own todos; other users' todos are a 404. Deleting an automatic todo declines
  automatic todos for that email for good (`todoDeclinedAt` on the message); a todo made by hand declines nothing.
  `POST /api/v1/messages/{id}/todo` makes a todo from one of the user's emails, titled after its subject (or "Email
  from" the sender when it has none), or returns the one it has (always 200; `made` says whether this request made
  it, so a client undoing its own action removes only a todo it made). With `perConversation` an open todo of another
  email of the conversation is returned instead of making one (triage's do).
- Todos are in the delta (`todos`, tombstone type `todo`) with `messageId` and `threadId`. Clients treat a link to an
  email they do not have as none, and the thread of the message on the device wins over `threadId`, since a message
  can move to another thread. The delta is built with named arguments, so a list added to `SyncChanges` and not to its
  provider fails loudly.
- Automatic todos: a smart inbox with `autoCreateTodo` (only with the `do` verdict; another verdict switches it off;
  the built-in To do smart inbox has it on) gives new mail a todo when it is first classified there, if the message is
  judged `do`, unread, and received in the last 7 days (a first sync brings years of old mail). A conversation gets one
  open automatic todo: replies to a conversation with an open todo make none, and once it is done the next reply
  makes a new one. Classifying again (after a rule change or a correction) makes none, and a todo the user deleted
  does not come back: deleting an automatic todo marks its email (`todoDeclinedAt`), and no automatic todo is made for
  it again, also not when triage's undo lets the rules place the conversation again.
- Clients: the shared stores keep todos (`todos()`, `todo(id)`, `todosOfThread(threadId)`), and `@tresso/core`
  groups them into Overdue, Today, This week (to Sunday), Later (also those without a date) and Done, labels due dates
  ("Today 17:00", "Fri 23 Oct") and reads a day and time from a quick-add line ("Call Anna friday", "tomorrow 9:00",
  "27 oct"; full weekday names only, so "sun" in a title stays a word). The web client has a Todos page with quick
  add and a detail panel ("Complete and archive email" archives the conversation the todo came from), "Make todo" in
  the reading pane (`T`, keeping the verdict; Do with `D` also sets the do verdict), which uses the newest email someone else sent, and the auto-create switch in the smart
  inbox settings; the mobile app lists todos by section, checks them off, and makes them from a conversation.

#### Todos in the calendar

An open todo with a due date and a duration can hold time in the user's calendar, so nobody books a meeting over it.

- **Where the time is kept:** on the todo itself: `plannedStart` and `plannedEnd` (instants, stored in UTC) and
  `planState` (`planned`, or `conflict`). One todo holds at most one stretch of time; a todo of more than 24 hours
  cannot be planned in one go. The entity keeps the invariant: completing a todo, or clearing its due date or its
  duration, gives its time back, and a done todo or one without a due date or duration cannot be planned. Deleting
  the todo deletes its time with it. The time is in the delta with the todo; no calendar event is written.
- **Deadline:** the due date and time in the user's zone (that of the notification settings), or the end of the due
  date when it has no time.
- **Planning** (`App\Todo\TodoPlanner`) asks the meeting time finder (3.13) for the earliest free stretch of the
  todo's duration from now to the deadline (`MeetingTimeQuery::beforeDeadline`, ignoring the todo's own time): within
  working hours, around busy time, focus blocks, buffers and travel time, and after the minimum notice. A todo shorter
  than the finder's 5 minutes holds only its own length. `POST /api/v1/todos/{id}/plan` (scope `todos:write`) plans
  the todo, again when it was planned, and answers the todo; when it cannot, a 422 says why in words for the user (no
  due date, no duration, done, longer than 24 hours, due date passed, no working hours or no free time left before
  it). `DELETE /api/v1/todos/{id}/plan` gives the time back (204) and records that the user did (`planDeclinedAt`),
  so automatic planning leaves the todo alone until its due date, time or duration changes, it is reopened, or the
  user plans it. Other users' todos are a 404.
- **Busy time:** planned time counts as busy for the finder (`TodoBusyTimes`, see "Meeting time finder"), so meeting
  proposals and other todos keep clear of it. A search can leave a todo out by its id in `ignore`. Todo titles show
  as labels only to callers with the todos read scope.
- **Keeping it right:** planned time that has not started is checked again when the todo's due date, time or duration
  changes (in the same request) and after everything it depends on changes: calendar events (`CalendarStore`), a
  calendar shown, hidden or removed, the zone or working hours (notification settings) and the scheduling
  preferences. Each asks through `TodoReplanning` for one `ReplanTodos` message per user and commit (transport
  `async`), which checks the user's planned todos earliest deadline first under the user's todos lock. Time still fits
  when it is as long as the todo takes, over by the deadline (read in the current zone), and the finder would still
  propose exactly that stretch: inside working hours (also across a daylight saving change), clear of busy time, focus
  blocks, buffers and travel time, and not sooner than the notice. Time that no longer fits moves to the earliest free
  time; when there is none it stays where it was with `planState` `conflict`, until the user plans it again or
  removes it, or the time is free again (it goes back to `planned` then). Time that has started is left alone.
- **Planning on their own:** with `planTodos` on (scheduling preferences, `PATCH /api/v1/calendar/scheduling-preferences`)
  an open todo with a due date and a duration is planned when it is made, reopened, or gets a new due date or duration,
  and every `ReplanTodos` (switching it on is one) tries the open todos without time again, so a todo that found no
  free time gets some once the calendar frees up. A todo whose time the user removed is left out until it changes.
  Switching it off leaves planned time where it is.
- **Provider calendars:** planned time stays in Tresso. It is not written to Google, Microsoft or CalDAV calendars
  through the C5 write path: the design shows todo deadlines as a Tresso calendar of their own, and a block written to
  a provider would come back through sync as an event the finder already counts. Others see it busy only where Tresso
  answers for the user (meeting proposals); a provider's own free/busy does not see it.
- **Clients:** `@tresso/core` places planned time (`todoBlocks`, `TodoBlock`) next to occurrences: the calendar layout
  takes any item with a key, a start and an end, so planned todos share the time grid and its columns with events.
  `plannedLabel` says where a todo is planned, `canPlan` whether it can be, and `planPath` is the endpoint. The web
  views (day, week, month, agenda; also the desktop app) show planned todos in the Do colors, dashed when in conflict,
  with a panel to plan again, remove the time or check the todo off; the todo detail plans a todo ("Plan
  automatically", "Plan again", "Remove from calendar", "Show in calendar"), and Settings > Calendar has the
  `planTodos` switch. The mobile agenda and day view show planned todos, a tap offers the same actions, and the todo
  list plans a todo from a button on its row. The stores changed shape for the new fields: SQLite `SCHEMA_VERSION` 9
  and IndexedDB `VERSION` 11, so existing copies sync again from the start.

### 3.15 Hand-overs

A conversation judged `delegate` is handed over by forwarding it to one person with a note and a due date, and waited
on in "Waiting on" until that person replies. Assignments to teammates are planned (3.9); today a hand-over goes
by mail.

- **Handing over** goes through the shared compose flow (`HandOverFlow` in `packages/core/src/handOvers.ts`, on a
  composer of its own so it never touches what the user is writing): the newest message from someone else is
  forwarded with its files, the note above the original with "Could you get back to me by {due date}?", and once the
  forward is queued `POST /api/v1/hand-overs` records it (`messageId`, `delegate`, `note`, `dueAt`, `forwardId`; scope
  `mail:write`). The API checks that the forward came from the message's account, answers the message handed over,
  went to the delegate, was not cancelled or failed and handed over nothing before (one hand-over per forward, also
  for two requests at once), and that the due date lies ahead (at most a year; stored in UTC, whatever zone the client
  wrote). The clients refuse a second submit while the first is under way. When files of the original could not be
  scanned, the outbox's question comes back as an `UnscannedFilesError` and the clients offer "Hand over anyway",
  which forwards them with `acceptUnscanned`. When recording fails, the forward is
  cancelled and its draft thrown away. Until the forward leaves (the undo window), Undo cancels it and withdraws the
  hand-over (`DELETE`); afterwards the hand-over stays. Hand-overs share one composer, so they run one after another;
  each holds the next for at most a minute from when it starts, and one that runs longer keeps the composer until it
  settles (a hand-over asked for meanwhile is refused with a message to try again). A sign-out starts a new composer
  session: a hand-over asked for before it is refused, and one still hanging from before does not hold up the next
  user's. Every API request the clients make
  (uploads of the user's files aside) is given up after 120 s (`withDeadline`), so a request that hangs ends as a
  failed step instead of keeping hand-overs refused. Undo and take back do not wait for
  them: the cancel and the withdrawal go out at once and they answer when the server did; the draft the forward came
  back as is thrown away by its id afterwards, without opening it (`Composer.discardStored`).
- **Entity** `hand_over` (owner-scoped, tracked for the delta, tombstone type `handOver`): account, message handed
  over (SET NULL when it goes; the subject is kept), the conversation it was handed over in (followed through merges,
  SET NULL), delegate address and name, note, due date, state (`open`, `replied`, `done`), forward and its Message-ID,
  `overdueAt`, `nudgedAt`, the latest nudge, the reply that closed it, created, closed and updated times. The delta
  gives the conversation of the message, or the kept one once the message is gone; the client stores resolve it again
  from their own copy the same way. When the message janitor removes a message a hand-over points at, the hand-over
  gets a new change number, so clients learn the link is gone.
- **Closing:** every newly stored message is checked on ingest, and so is a known one that lands in an inbox (an
  answer the user rescued from Spam). From the delegate's address, received after the
  conversation was handed over, and in it (the conversation of the message handed over, the kept conversation, or a
  reply to the forward by its Message-ID) closes it as `replied` with that message. Not an answer
  (`App\HandOver\ReplyCheck`): automatic replies (`Auto-Submitted` other than `no`, `Precedence` `auto_reply`,
  `bulk`, `junk` or `list`, `X-Autoreply`, `X-Autorespond`; the worker sends these headers), mail in Spam or flagged
  as junk, and mail whose sender failed DMARC in any Authentication-Results header (a forged From; as in
  classification, a failure counts trusted or not, and a forged failure only keeps a hand-over open). The user can
  mark it done or put a closed one back (`PATCH /api/v1/hand-overs/{id}` with `done`).
- **Due dates:** recording (or a new `dueAt` in a `PATCH`) dispatches `HandOverDue` after the commit with
  `DelayStamp::delayUntil(dueAt)` on the `async` transport, like the release of scheduled mail. Its handler locks the
  hand-over and, when it is still open without a reply, sets `overdueAt` once; every worker heartbeat marks overdue
  hand-overs of the leased accounts too, in case a message got lost. A new due date clears `overdueAt` and starts a
  new round.
- **Telling the user** works like new mail (see "New mail" under Reminders and notifications): the server decides.
  Becoming overdue dispatches `NotifyOverdueHandOver` after the commit (transport `push`); the `HandOverNotifier`
  locks the hand-over, which must still be open and overdue. A focus block (`holdDuringFocus`) makes the notice wait
  for its end (a delayed message comes back then); quiet hours and other busy events (`focusDuringBusy`) make it
  silent. It goes out as "No reply from {delegate} yet" through the `NotificationDispatcher` (kind `hand_over`, a
  `NotificationKind` case, path `/waiting?nudge={id}`, the phone's `reminders` channel, `userId` in its data) on the
  channels the user chose for `hand_over` in `channelsByKind`, else the phone and the desktop, keyed
  `handOver:{id}:{round}` (a round per time it became overdue), so a retry never notifies a device twice and a new
  round tells again. The claim is part
  of the transaction that records the notice on the hand-over (`notifiedAt`, `notifiedChannels`, `notifiedSilently`;
  with no channel chosen the decision is recorded with none), and a scheduler task (`SweepHandOverNotices`, every
  minute) delivers what a lost message or an ended hold missed and sends failed or stuck deliveries again. The delta
  carries the recorded notice, which is how the desktop app shows it: natively when it went to the desktop channel, as
  for mail (not for the first pull, while the app has focus, or for notices delivered more than 15 minutes before
  notifications were switched on; once per round, `deliveredNotices` in `@tresso/core`). Every app also shows a notice
  with the nudge one click away for each delivered notice that went out on any channel.
- **Nudges:** `POST /api/v1/hand-overs/{id}/nudge` (scope `mail:send`, `html` and an optional `sendAt` a few seconds
  ahead for undo) queues a reply to the delegate through the outbox, in the same conversation: to the forward's copy
  in Sent when it was synced, else to the message handed over, with "Re:" and the forward's subject. Clients suggest
  the text (`nudgeText`) and add the account's default signature; Undo cancels the outgoing message, and a cancelled
  or failed nudge no longer counts as nudged. A nudge is refused (409) while the previous one is scheduled, queued or
  being sent, and the clients refuse a second send while one is under way. "Edit first" opens the follow-up in the
  compose window instead; any message the user sends to the delegate as a reply in the conversation, or to the
  forward, counts as the latest nudge (recorded when the outbox queues it), except a forward (by its draft, or its
  subject without one) and mail scheduled for later than its undo window, which neither counts nor blocks a nudge.
- **Clients:** both stores keep hand-overs (`handOvers()` in "Waiting on" order: open ones by due date, then closed
  ones). The web client has Hand over in the reading pane (H) and offers it right after a conversation is judged
  `delegate`; the dialog (vee-validate) takes the person, the note and a due date (today while an hour of it is left,
  tomorrow, Friday or next Monday, or a picked day; due at 17:00). Waiting on lists the open hand-overs with the
  delegate, due date and status (waiting, nudged, overdue) and the closed ones, and drafts a follow-up on Nudge (send,
  edit first, no longer waiting, move the due date); the reading pane says who a conversation is handed over to. The
  phone has the same hand-over screen without a picked day, Waiting on with one-tap nudges, and the banner in a
  conversation.

### 3.16 Encryption at rest

Stored mail is encrypted with a key per user. The server keeps its role: it syncs, parses, classifies, scans,
indexes and pushes, so it holds the keys while it works. What this protects against, and what it does not, is in
"Threat model" at the end of this section.

#### Keys

```
master keys (DATA_KEYS, environment)
  └─ wrap ─ user key, version n (user_key row)     ─ HKDF ─ blob key   (objects; also handed to sync workers)
  │                                                 ─ HKDF ─ field key  (database fields, credentials)
  └─ wrap ─ user index key (user.wrapped_index_key) ─ HMAC ─ content fingerprints and object names
  └─ HKDF ─ scan cache key (no copy stored)          ─ HMAC ─ virus scan verdict cache
```

- **Master keys** (key encryption keys) come from the environment as before: `DATA_KEYS` (`id:base64`, comma
  separated) and `DATA_KEY_CURRENT`. They never leave the API: not to the database, not to the sync workers.
- **User keys.** Each user has one or more 32-byte random keys in `user_key`, numbered from 1, each wrapped by a master
  key as `v1.<master key id>.<base64(nonce + ciphertext)>` with `tresso:user-key:<user id>:<version>` as additional
  data, so a wrapped key copied to another user or version does not open. The highest version is current: new data is
  encrypted with it, older versions only decrypt until re-encryption moves their data on. Keys are created with the
  user, or for users from before this the first time something is written for them (under a lock on the user, with
  `INSERT ... ON CONFLICT DO NOTHING`, so concurrent first uses agree on one key). Reading never creates keys, and keys
  are never created again once a user's were shredded (`user.keys_shredded_at`): whatever still wants to write for that
  user fails instead (fail closed). Nothing uses a user key directly: HKDF-SHA256 derives a blob key
  (`tresso:blob-key:v1`) and a field key (`tresso:field-key:v1`) from it, so the sync worker can be given the blob key
  without being able to open database fields.
- **The user index key** is a second per-user random key, wrapped like a user key (`tresso:user-index-key:<user id>`).
  It names content (below) and is never rotated with the user keys: names must stay stable for deduplication and for
  references in the database, and rotating it would mean renaming every object and fingerprint a user has. It reveals
  no content, only which of one user's objects hold the same bytes, and lets its holder test whether that user has a
  file it already knows. Every worker that leases one of the user's accounts gets it, and it stays valid after the
  lease ends; a leaked index key is only replaced by deleting and re-adding the user's data.
- **The scan cache key** is derived from the current master key (HKDF, `tresso:scan-cache:v1`) and identified by the
  master key's id. It is never stored.
- Credentials from before this (sealed `v1.<base64>` with the earlier per-user data key, `user.wrapped_data_key`)
  keep opening: that key becomes the user's key version 1 when the user's keys are first set up, and the old column is
  cleared then. Until re-encryption has sealed those credentials again, version 1 is used in two ways: directly, as the
  AEAD key of the old `v1.` credentials (as before), and through the keys HKDF derives from it. HKDF separates the two,
  and the direct use ends for a user once their credentials are resealed (the `credentials` count of `--status` is 0),
  for good once version 1 is retired. The column is dropped in a later release, once `app:crypto:reencrypt --status`
  reports nothing left.

#### Objects

- **Names.** Every object is stored under its owner: `<kind>/<owner user id>/<fp[0:2]>/<fp>`, with kind one of
  `raw`, `attachments`, `uploads`, `outgoing`, `drafts` and `quarantine`. `fp`, the content fingerprint, is
  `hex(HMAC-SHA256(user index key, SHA-256(content)))`. The same file stored twice by one user is still stored once,
  but the same file at two users gets unrelated names and unrelated ciphertexts, so object storage (or a database dump)
  cannot show that two users have the same file. Attachment rows keep the fingerprint where they kept the SHA-256.
- **Format.** An object is a 40-byte header, `"TRB1"`, the key version (uint32, big endian) and a random 32-byte salt,
  followed by the content in frames of 64 KiB. Each frame is XChaCha20-Poly1305 with key `HKDF-SHA256(blob key,
  salt, "tresso:blob-frame:v1")`, nonce `15 zero bytes || frame number (uint64, big endian) || 1 on the last frame,
  else 0`, and as additional data the header, the owner's id (16 bytes) and the fingerprint (32 bytes). Frames cannot
  be dropped, reordered, cut off or moved to another object, owner or key version without failing authentication, and
  content is decrypted and served frame by frame, so memory stays flat whatever the size. Each object gets its own
  frame key through the salt, so frame nonces can count from zero. The format binds the fingerprint, not the full
  name, because quarantine moves objects between kinds.
- **Writers.** The sync worker encrypts raw MIME and attachments before upload, with the blob key of the account's
  owner; the API encrypts uploads, outgoing messages and Drafts folder copies. The worker gets keys from `GET
  /internal/sync/accounts/{id}/storage-keys?workerId=...` (scope `sync:credentials`, only for accounts it holds an
  unexpired lease on, `Cache-Control: no-store`): the owner's id, the index key, the current version and the blob key of
  every version still in use. It keeps them in memory for at most 5 minutes. It never gets a master key, a user key or a
  field key. Each stored object carries its key version as object metadata (`x-amz-meta-tresso-key-version`, read
  without regard to case). A worker that finds the object already there writes it again only when the stored version is
  older than its own; it never writes over a newer one, which re-encryption may have moved on while the worker still had
  older keys cached. The writes are conditional (`If-None-Match: *` for a new object, `If-Match` with the ETag it saw
  for a replacement), so a concurrent writer is never overwritten blindly; the loser looks again. The ingest call names
  the key version, and the API refuses a raw key that is not under the account owner's id or a version the owner does
  not have. It checks the versions under a shared lock on the owner that lasts until the batch is committed, so a
  version cannot be retired between the check and the rows that name it.
- **Database.** Rows record the key version their object was written with (`message.raw_key_version`,
  `attachment.key_version`, `draft_attachment.key_version`, `outgoing_message.raw_key_version`). Null means content
  from before this: plaintext under the old content-addressed name (`<kind>/<sha256[0:2]>/<sha256>`), which reads keep
  serving until re-encryption has moved it.
- **Reading** goes through `BlobVault`, which takes the owner the database row belongs to: an object under another
  owner's name, or one that fails authentication, is an error (logged, 500 to the client), never served.
- **Fingerprints the worker reports** for attachments are checked when the attachment is scanned, which decrypts and
  hashes it anyway: content that is not what its fingerprint says is not scanned, is marked `failed` (`unscannable`,
  so not downloadable without confirmation) and logged as an error. The verdict cache is keyed by the content itself,
  so a wrong name could not borrow another file's verdict; it could only mix up one user's own files. Raw messages are
  not hashed again: the AEAD binds them to the name they were written under.

#### Database fields

- `message_text` (the body text kept for search) and `message.snippet` are sealed with the owner's field key as
  `f1.<version>.<base64(nonce + ciphertext)>` (XChaCha20-Poly1305) in `message_text.sealed_text` and
  `message.sealed_snippet`, with the field and row id as additional data. The plaintext columns are empty for new rows
  and are dropped together with `user.wrapped_data_key`.
- Credentials and provider tokens use the same format (`tresso:mail-account-credentials:<id>`,
  `tresso:provider-grant-tokens:<id>`); `v1.<base64>` from before still opens with key version 1.
- What a mail notification says (the subject and the start of the text, or for a summary who it is from) is sealed in
  `mail_notification.sealed_body` (`tresso:mail-notification-body:<id>`). Its title (the sender's name, or for a summary
  how many) stays plaintext like the sender columns. Once clients no longer get a notification through the delta (7 days
  after it was delivered or dropped, or for one still waiting 7 days after its fire time, when it can no longer be
  delivered), an hourly job clears its title and body; the row stays, because it is what makes a message notify at most
  once.
- **Plaintext on purpose:** subject, sender and recipient addresses and names, dates, flags, sizes, folder and thread
  structure, attachment names and types. The server queries them: threading matches the normalized subject and the
  participants, sender rules and smart inboxes match addresses, recipient suggestions and the meeting brief search
  recipients, and the delta, lists, notifications and the daily brief read them in bulk SQL. Encrypting them needs
  blind indexes for every one of those queries; that is a follow-up on the roadmap. Copies of them stay plaintext too:
  thread subjects in calendar reminders (a meeting brief names recent conversations) and the subject a hand-over
  keeps. What users write themselves is also still plaintext and next on the roadmap: draft bodies (`draft.html`,
  `draft.quote_html`), hand-over notes, event notes and todos. Calendar data is plaintext as a whole (events,
  attendees, descriptions, and an RSVP's comment while it waits to be sent, `calendar_operation.comment`); only mail is
  in scope here.

#### Search

The Meilisearch index keeps plaintext: subject, addresses, snippet, body text and attachment names. A search engine
needs the words to match prefixes, typos and phrases with ranking and highlights. Indexing hashed tokens would keep
exact words only (no prefixes, typos or highlights) and still leak which messages share words, and searching metadata
only would drop the body. Full search stays, and the index is protected the way the database is not: Meilisearch is
only reachable on the internal network with a master key only the API has, it keeps no copy of raw content or
attachments, and its volume must be on encrypted disk (production requirement). The indexer decrypts body text and
snippets just before sending them. Deleting a user removes their documents.

#### Virus scanning

- Verdicts apply per content within one user (by fingerprint): the lock per content, the bulk verdict, quarantine and
  release all work as in "3.8 Virus scanning", now per user.
- The verdict cache (`scan_result`) is shared by all users, keyed by `HMAC-SHA256(scan cache key, SHA-256(content))`
  with the master key id beside it. The scan job decrypts the content once to compute that key and, without a cached
  verdict for the current signatures, a second time while streaming it to clamd. Nothing ties a cache row to a user
  or an attachment, and without the master key a database dump cannot test whether a known file was ever received.
  Rows of another master key id (and rows from before this) are never used and are deleted by key rotation and by
  re-encryption.
- The cache has a timing side channel: a scan that finds a cached verdict finishes sooner than one that scans. Whoever
  can watch scan jobs (logs, metrics, the job queue) can tell that some user had the same file before, though not who.
  That is accepted: those who can watch the jobs run the server.

#### Rotation

- **Master key:** add a key to `DATA_KEYS`, make it current, run `bin/console app:crypto:rotate-data-keys`, then remove
  the old key. It re-wraps every user key and index key and drops scan cache rows of other master keys. No content is
  re-encrypted.
- **User keys:** `bin/console app:crypto:rotate-user-keys --user=<email>` (or `--all`) adds a new current version; new
  data uses it at once (workers within 5 minutes), and it queues the background re-encryption for those users, which
  moves everything on older versions to the current one and deletes an older version once nothing uses it and its
  successor is at least 15 minutes old, which outlasts every worker's key cache. "Nothing uses it" is counted again
  while the owner is locked for update, so an ingest batch in progress (which holds the shared lock) is either counted
  or refused afterwards; a refused batch is rebuilt by the worker with fresh keys.

#### Re-encryption and migration

Re-encryption runs in the background on its own. An hourly sweep (`SweepReencryption`) queues a job
(`ReencryptUserData`, transport `reencrypt`, with a consumer of its own, so a long run never holds up mail or pushes)
for every user whose data is not all on their current version (`user.data_key_version`, which re-encryption sets when
nothing is left) or who still has older versions to retire: after a deploy every user from before has one, after a
rotation the rotated users do. A job works for up to 50 seconds (checked before every row, so it overshoots by one
object at most), then queues itself again while work is left, and comes back after the grace period to retire an older
version; one job per user runs at a time (an advisory lock), so duplicates do nothing. It logs progress per step, and
`app:crypto:reencrypt --status` counts what is left, per kind of row and in users.

`bin/console app:crypto:reencrypt --all` (or `--user=<email>`, repeatable) does the same work now, in the foreground. It
brings each user's data to the current key version: their keys (version 1 from the old data key), credentials and
tokens, raw messages, attachments (live or in quarantine), draft files, outgoing messages, body texts, snippets and
notification texts, then retires old versions. Each step selects only rows not yet on the current version (`key_version
IS DISTINCT FROM current`), in batches of `--batch` (200) in id order, and each row is updated in its own short
transaction after its new object is written. Attachments are moved under the same lock per content as verdicts and
quarantine, and draft files under the upload collector's lock, so neither can move or remove the new object before the
row names it. Running it again, or after a crash, continues where it stopped; a row that fails is logged and left for
the next run. Content goes straight from decryption into encryption: only ciphertext is buffered (and may spill to a
temporary file), never plaintext. Content from before encryption is named by its SHA-256, which is checked once all of
it went through and before anything is written. Every old name a row had is recorded in `legacy_object`. When nothing
anywhere is left on old content, `app:crypto:reencrypt --purge-legacy` deletes those plaintext objects (they could be
shared between users, so they go only then) and lists only `drafts/`, whose copies no row referred to; `--scan-bucket`
lists every kind as well, for plaintext no row ever knew of (an upload whose ingest batch never arrived). There is no
data change in any Doctrine migration.

Deploying this: run the migration and update the API and the sync workers together. The API refuses ingest batches
that name no key version or a raw key outside the owner's names, so a worker from before keeps retrying its batch (its
folder cursor does not move) until it is updated; nothing is lost. Until re-encryption has run, a message without a
Message-ID that was stored before and shows up in another folder is not recognised by its raw content (the names
differ) and is stored once more; re-encryption gives the old one the new name, so it does not happen afterwards.

#### Deleting a user

`bin/console app:users:delete <email>` first shreds the user's keys (user keys, index key, old data key) in its own
transaction and marks the user, so no keys are created for them again. From that commit on, what was encrypted with
those keys is unreadable wherever copies of it are: objects, sealed fields, credentials and tokens. It then deletes the
user (the database cascades to everything they own), their OAuth tokens, and queues `PurgeDeletedUser`, which deletes
their search documents and everything under the user's id in every kind of object, retrying on errors. If the
deletion stops after the shredding, the user is left without keys: nothing can be read or written for them, and
running the command again finishes it.

What shredding does not reach, because it was never encrypted with those keys:

- the plaintext columns (subjects, addresses, names, hand-over notes, drafts, todos, event notes): the cascade deletes
  them from the live database, but they stay in database backups, WAL archives and point-in-time recovery until those
  expire, and in disk pages until they are overwritten;
- Meilisearch snapshots and dumps taken before the deletion (the live index loses the documents);
- content from before re-encryption (plaintext objects, possibly shared with other users, until `--purge-legacy`;
  plaintext snippets and body texts until re-encryption sealed them);
- older object versions, when the bucket keeps versions (see Operating it).

#### Operating it

- **After re-encryption,** run `VACUUM` (autovacuum does it eventually) so the plaintext snippets, body texts and
  notification texts it replaced leave the live tables; older copies stay in backups, WAL archives and PITR until those
  expire, so let them expire (or rotate them out) before counting on the data being gone.
- **Object storage versioning:** a bucket that keeps versions keeps the replaced and deleted objects as noncurrent
  versions, so plaintext from before survives `--purge-legacy`, and a deleted user's ciphertext survives
  `PurgeDeletedUser` (unreadable, but still there). Turn versioning off for the mail bucket, or add a lifecycle rule
  that expires noncurrent versions after a short time.
- **Disk encryption** stays a requirement for the database, Meilisearch and Redis volumes: it covers the plaintext
  columns, the search index and free pages that still hold old rows.

#### Performance

Measured on an Apple M-series laptop in the dev containers, one core: the API (PHP, libsodium) encrypts a 50 MiB file
read in 1 MiB chunks at about 370 MB/s and decrypts it at about 420 MB/s, with peak memory 4 MiB and 0.3 MiB above the
baseline; computing its SHA-256 alone runs at about 130 MB/s, so for uploads the hashing every upload already did
costs more than the encryption. The worker (Go, `go test -bench . ./internal/blobcrypt`) encrypts 10 MiB at about
640 MB/s and decrypts at about 800 MB/s. Frames add 16 bytes per 64 KiB (0.02 %) plus the 40-byte
header. The API streams uploads through a temporary stream that spills to disk above 2 MiB and streams downloads frame
by frame, so neither direction holds a whole file in memory; the worker already holds each message in memory to parse
it and encrypts in place.

#### Threat model

- **Protected:** copies of object storage, database dumps, backups and replicas, lost or reused disks, and anyone with
  read access to the bucket or the database but not to the API's environment. They see ciphertext, owner ids, sizes,
  timestamps and the plaintext metadata listed above, and cannot tell which users share a file.
- **Not protected:**
  - the operator, and anyone who controls the running API or its environment (`DATA_KEYS`): the server decrypts to do
    its work, by design. This is encryption at rest, not end-to-end encryption.
  - a compromised sync worker: it holds the blob keys and credentials of the accounts it leases while it leases them,
    and the index keys stay usable afterwards. Key access follows the lease, and the lease follows the worker's word:
    any holder of the sync client's credentials (scope `sync:credentials`) can lease accounts under a `workerId` of its
    choosing and fetch their keys, the same as for mail credentials. That secret is as sensitive as every user's blob
    keys.
  - the Meilisearch index (plaintext, see Search) and Redis (queued jobs carry ids, not content; realtime and cache
    entries carry no mail content). Both rely on network isolation, access keys and disk encryption.
  - the plaintext metadata columns listed above, and sizes and timing everywhere.
  - mail at the provider and on clients' devices, which have their own protection.
- **Crypto-shredding** makes what was encrypted with a deleted user's keys unreadable as soon as the key deletion
  commits. Backups taken before still hold the wrapped keys, so they stay readable for as long as the master key that
  wrapped them exists: rotate the master key and let those backups expire. What was never encrypted with the user's
  keys is listed under "Deleting a user".
- **Tampering** with an object or a sealed field fails authentication. A sealed field or a whole object read at once is
  refused outright; a download is served frame by frame, each frame only after it is authenticated, and a frame that
  fails cuts the download off with an error. A tampered first frame (which covers any file up to 64 KiB) fails before
  anything is sent.

### 3.17 WhatsApp relay and reply queue

With "All my devices" one of the user's desktops relays their WhatsApp to the server: it reads the bridge's store and
passes the messages on, and it sends the replies written on other devices. Chat accounts, chats, messages and replies
are their own entities (`chat_account`, `chat`, `chat_message`, `chat_outgoing`), sealed with the owner's field key
(`App\Chat\ChatFields`); the server finds a chat by the fingerprint of its JID and a message by the fingerprint of its
chat's JID and WhatsApp id, so it never needs either readable.

- **Who calls what.** `App\Security\ChatAccessVoter` decides every chat endpoint. The relay calls
  (`POST /api/v1/chat-accounts/{id}/relay/status`, `relay/messages`, `relay/outgoing/claim`,
  `relay/outgoing/{replyId}/result`) need `CHAT_MANAGE` (our own apps with `mail:write`) and our desktop app
  (`DESKTOP_CLIENT`); `App\Chat\ChatRelayGuard` then answers only the account's relaying device (409 with
  `"code": "not_the_relay"` for another desktop of the user, until it takes over through
  `PUT /api/v1/chat-accounts/whatsapp`; a desktop linked to another number than the account's may not take over an
  account that holds chats, 409 `"code": "other_number"`, and a `PUT` without a number keeps the stored one). Queueing a reply (`POST /api/v1/chats/{id}/outgoing`), cancelling it
  (`DELETE /api/v1/chat-outgoing/{id}`) need `CHAT_SEND`; trying it again (`POST /api/v1/chat-outgoing/{id}/retry`)
  needs `CHAT_SEND` and one of our own apps (`FIRST_PARTY_CLIENT`), since a reply that failed as `unconfirmed` may
  have gone out and only the user decides to send it again. Replies queued by a caller that is not one of our apps
  (an app by its client id, a personal access token by its id, `App\Security\CallerKey`) are limited per caller too
  (`chat_reply_caller`: 20 in 10 minutes, `chat_reply_caller_day`: 100 a day), on top of the user's limit; Tresso's own chat state (`PATCH /api/v1/chats/{id}`: `readThrough`, `archivedThrough`, `leftOut`) needs
  `CHAT_MANAGE`. Everything is loaded through the signed-in user: another user's id is a 404.
- **Reading without the delta.** The delta needs `mail:read`, so callers with `chat:read` alone (an MCP client, a
  script) read through endpoints of their own (`App\Chat\ChatReader`, `App\State\ChatReadProvider`), each needing
  `CHAT_READ`: `GET /api/v1/chats` (the chats, newest message first, `limit` 1 to 100, default 25),
  `GET /api/v1/chats/{id}/messages` (a chat's messages and the user's replies newest first, `limit` 1 to 100, default
  30; items have `type` `message` or `reply`; cancelled replies and a sent reply the bridge also stored as an own
  message are left out, by the same rule as `timeline()` in packages/core) and `POST /api/v1/chat-messages/search`
  (a POST with a JSON body, so the text searched for never sits in a URL, a proxy's access log or the request line of
  an error report; it changes nothing). `GET /api/v1/chat-accounts/whatsapp/status` needs `CHAT_READ` or
  `CHAT_SEND`: whether WhatsApp is on the server (`onServer`), the relay's device name (only with `CHAT_READ`), online
  state and since when it is offline, the bridge and link state, and no number or message. Rows are what `ChatViews` makes of them, as in the delta. Chats left out are neither
  listed, read nor searched (404 by id); another user's chat is a 404. Pages go on by an opaque `cursor` (the time,
  kind and id of the page's last row, base64url), in a stable order (time, then id) that two indexes serve
  (`chat_last_message` on `chat (chat_account_id, last_message_at)`, `chat_message_account_sent` on `chat_message
  (chat_account_id, sent_at)`; a search reads the account's id first so it filters on it). A cursor is not signed and
  not bound to a user or a chat: it only names a position, and every read filters by the signed-in user, so another
  user's cursor moves nothing but the position within the caller's own chats. A cursor not of the shape this API gives
  is 400, a parameter out of range 422.
- **Search.** `q` (2 to 200 characters) is matched anywhere in a message's text, file name or sender name, on both
  sides in Unicode compatibility form (NFKC) and fully case folded (so a decomposed "é" matches "é", "İstanbul" matches
  "İSTANBUL" and "Straße" matches "STRASSE"), newest first, within `days` (1 to 90, default 30), in every chat or one (`chatId`), with up to `limit` (1 to
  50, default 20) results. Chat text is sealed at rest and never goes to Meilisearch or any other index, so each
  message is opened in PHP to be compared: one call opens at most 2,000 messages (read 250 at a time), says how many
  it opened (`scanned`) and back to when (`searchedThrough`), and when it stopped before the window's start
  (`complete` false) gives a `nextCursor` to go on further back. Opening a message is a key derivation and an
  XChaCha20-Poly1305 decryption of its text (and of its sender and file name when it has them): microseconds each, so
  a full call costs a few tens of milliseconds and reads at most 2,000 rows. Searches are limited per caller
  (`chat_search_caller`: 30 in 10 minutes for an app, a token or our own apps) and per user as the outer bound
  (`chat_search`: 60 in 10 minutes), 429 above either.
- **Messages.** At most 200 messages, 200 chats and 8 MB a call (413 with `"code": "too_large"` above that: an announced
  length is checked before the body is read, and a body without one is read up to one byte past the limit, never whole;
  the relay sends fewer at once; a 429 of the import limit says in `Retry-After` when to send the next); a text up to 65,536 characters (what the desktop cuts at)
  and 262,144 bytes. Batches are limited per account (`chat_relay_import`: a token bucket of 1,200 batches, refilled
  with 120 a minute, so a first import of a large history goes through and a looping relay does not). A batch is stored
  in one transaction, whole or not at all, and answers counts and per message `stored`, `known` (the server had it: a
  replayed batch changes nothing), `left_out` (a chat the user left out, or a group while the account leaves groups
  out) or `refused`. `refused` is for what the relay copies from the bridge's store and cannot repair: a JID that is not
  a chat `importableChat` in `packages/core/src/chat/format.ts` takes, a WhatsApp or sender id other than 1 to 128
  visible ASCII characters, a time before 2009 or more than a day ahead. The rest of the batch is stored, so one bad row
  never holds the relay's cursor; a malformed request (types, missing fields, sizes, a message whose chat is neither in
  the call nor on the server) is still 422 as a whole. JIDs are stored in one form (lower case, without agent and
  device suffix); the cases both sides test are in `packages/core/src/chat/importable-jids.json`. Names lose control
  characters and direction overrides and are cut to 255 characters. `firstImport` is honoured until the relay's first
  batch without it (and again for a relay that takes over): then a chat made in that import, or one read through its last
  message, is read through its newest message, so the history arrives read; a chat with unread messages stays unread.
- **Reply queue.** A reply's id is a UUIDv7 the client made in the last 10 minutes; the same id again returns the stored
  reply (200), the same id for another chat or user is 409 `id_taken` (the chat is looked up first, so another user's
  chat is a 404 whatever the id), and the id of a reply that was cancelled or went with a chat left out is 409
  `cancelled` for good (its tombstone is the record). Both are looked up before the id's age is checked, so a late repeat
  of a reply that was queued or cancelled is answered as such and never as "too old, make a new id", which would send a
  cancelled reply after all. At most 100 replies per user in 10 minutes (429). The relay
  claims the oldest waiting reply of its account (`waiting` to `sending`); a claimed reply is never handed out again.
  The claim answers a `claimToken` (16 random bytes, hex), kept with the reply beside the claiming device
  (`claim_token`, `claimed_by`) and never in the delta or any other answer; it is short-lived and random, so it is
  stored as it is, not sealed. The result must carry it back (compared in constant time): another token is 409
  `result_final`. A result is final and ends the claim: the same result again is a 200 (it changes nothing, so no token
  is asked), another is 409 `result_final`, except that `sent: true` wins over `unconfirmed` of the same claim (it did go
  out, and Try again would send it twice); `unconfirmed` keeps the claim for that, and Try again ends it. A desktop that
  no longer relays the account may still report `sent: true` for a claim it made, with that claim's token and its own
  device id, nothing else (409 `not_the_relay`). `sent: false` carries
  the shell's reason (`bridge_stopped`, `not_linked`, `refused`, `unconfirmed`); nothing sends a failed reply again until
  the user's Try again. Cancelling deletes a waiting or failed reply (a tombstone); a reply being sent or sent is 409
  `already_going_out`.
- **Left out.** Leaving a chat out removes its messages and replies (tombstones) and keeps the chat row with its sealed
  JID and name, which is no longer renamed: the relay must know to leave it out, and the user can take it in again. A
  chat the user left out on a desktop before the server knew it comes as a chat entry with `"leftOut": true` in
  `relay/messages` (no messages needed, the same limits, validation and import limit as any batch): the server makes a
  left-out row with the JID sealed, no name and no messages (its last message time the earliest the server takes, so
  messages taken in later set it), and leaves a chat it holds as it is (it may have been taken in again); a repeat
  changes nothing, and messages of the chat in the same call are `left_out`. `relay/status` takes the linked number
  (`address`, 5 to 20 digits, optional): another than the account's is 409 `other_number`; an account without one
  stores it.
- **Sweep.** `SweepChatRelays` runs every minute on `scheduler_default` (the `maintenance` worker), and by hand as
  `bin/console app:chat:sweep-relays`: a relay not heard from for 3 minutes goes offline from when it was last heard
  from (its next call brings it back), and a reply still `sending` 5 minutes after its claim fails with `unconfirmed`,
  since the bridge returns no id and may have sent it. Heartbeats are no change for clients; these flips are.
- **Locks.** Every chat write takes the owner's row first, `FOR NO KEY UPDATE` (`App\Chat\ChatOwnerLock`), then the
  chat rows: the order the change numbers take them in, so no two writers wait on each other in a circle. It conflicts
  with the change number update and with the key locks of `UserKeys`, and not with the KEY SHARE of an insert that
  refers to the user. Claims, imports, cancels and the sweep of one user therefore take turns (tested on two real
  connections); the sweep skips an owner whose row is busy.
- **Push.** With the account's `notify` on (Notify me, off by default; no client sets it on the server yet), a relay
  batch hands each chat's newest incoming message it stored to `App\Chat\ChatNotifier`, never for a batch the server
  honoured as part of the first import, a message of the user's own or one older than 15 minutes. After the commit and
  10 seconds later (`NotifyChatMessage` on the `push` queue) it decides: nothing for a message sent before the chat's
  last push (that push named the chat), when the chat was read through it on another device, was left out, or Notify me
  went off; nothing when a newer incoming message of the chat (by time, then id) was stored meanwhile and the oldest
  message the chat was not pushed for is younger than a minute (the newer one notifies, so a burst notifies once and a
  busy chat at least once a minute). The last push is read from the deliveries of the chat's messages, so no column is
  needed. A message sent before a push of its chat but stored after it (the relay lagged) gets no push of its own:
  that push already named the chat. Then one push to the phone only (kind `whatsapp`, Android channel `whatsapp`, silent in quiet hours and busy
  events, keyed `whatsapp:{message}` so a repeat never notifies twice): title `WhatsApp`, body the chat's name opened
  from its seal, or `New WhatsApp message` for a chat without a name, or one that is or holds a phone number or another
  run of seven digits once separators are removed (the bridge names an unsaved contact by its number, and a group
  without a subject `Group <id>`), path `/chats/{id}`. The text, a sender and a number never leave in a push. A failed
  delivery is not tried again by a sweep (a chat push is stale within minutes).
- **Delta.** Every write is a change in `chatAccounts`, `chats`, `chatMessages` and `chatOutgoing`; removals (a
  cancelled reply, the messages and replies of a chat left out) are tombstones. A relay batch gets a change number per
  megabyte of text, and a chat message counts as one row of a delta page per 4 KB of its sealed text, so a page of long
  messages stays as small as one of short ones. Nothing of a message's text reaches a log, an error or a validation
  message.

## 4. Scale notes

- Every mail metadata row (folders, threads, messages, attachments) carries `mail_account_id` and every query path
  is scoped by it. That keeps hash partitioning (or Citus distribution) by account possible. Introducing it is a
  planned migration that widens primary keys to `(mail_account_id, id)`; it is done once volume needs it.
- Bodies and attachments never live in Postgres.
- Search lives in Meilisearch (swappable for OpenSearch at very large scale), indexed asynchronously.
- API and sync workers are stateless and scale horizontally; Postgres scales with read replicas, then sharding by
  user.

## 5. Repository layout

```
apps/
  api/        Symfony 8 + FrankenPHP
  sync/       Go sync workers
  web/        Vue 3 web client
  desktop/    Tauri 2 shell around apps/web
  mobile/     Expo app
packages/
  core/       Shared TS domain types and logic
  api-client/ Generated TS API client
docker/       Dockerfiles and config for local services
docs/         Architecture, roadmap, decisions
compose.yaml  Local development stack
```
