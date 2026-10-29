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
Billing is planned to live in this repository too, turned on by configuration on that server and off everywhere else;
its infrastructure, secrets and runbooks live outside this repository. Features with an outside provider, such as AI,
take your own key or endpoint, so they work self-hosted too.

### Deployment

Every release publishes three images on `ghcr.io/gettresso`: `tresso-api` (FrankenPHP; the same image runs the API and,
with another command, every Messenger worker), `tresso-sync` (the Go sync workers) and `tresso-web` (the web client on
Caddy), each for amd64 and arm64. Nothing server-specific is built in: the web image renders `/config.js` from
`TRESSO_API_URL` when it serves it, and the API reads everything from its environment. `compose.prod.yaml` runs them
with a Caddy proxy that gets the certificates, and with the services they need. Before anything else the API image runs
`app:settings:check`, which refuses to start while a secret is missing, too short or one of the development values in
the repository's `.env` files, since a production image would otherwise fall back to those public values. The API
container (`RUN_MIGRATIONS=1`) then makes the OAuth signing keys once, in a volume, migrates the database and updates
the first-party OAuth clients; the workers start when it is healthy.

### Organizations

Every user owns a personal organization from the moment the account exists; teams (planned, 3.9) will be organizations
with more members. A subscription will belong to an organization and its members are the seats it pays for, so one user
with several mail accounts pays once. `GET /api/v1/organizations` lists the signed-in user's organizations, their own
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
Only first-party clients are approved automatically. Third-party apps, personal access tokens and MCP clients are
planned (3.9).

Scopes: `mail:read`, `mail:write`, `mail:send`, `todos:read`, `todos:write`, `calendar:read`, `calendar:write`,
`settings:read`, `settings:write`, `signatures:read`, `signatures:write`. The scopes `teams:read`, `teams:write` and `webhooks:manage` are reserved for
the planned features in 3.9.

Users log in with email + password (Argon2id) and, later, Google / Microsoft sign-in as identity providers. (Signing
in with Google or Microsoft to connect a mail account is separate: see Provider sign-in below.)

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
  servers are suggested. Answers are cached per domain in Redis: a day when found, an hour when not.

#### Provider sign-in (Gmail, Microsoft 365)

Gmail and Microsoft 365 accounts connect through the provider's OAuth 2.0 authorization code flow with PKCE (S256),
as a confidential client (the API holds the client secret). The layer is generic: one **provider grant** per
signed-in provider account, shared by every feature that uses it: mail, and the calendar (Google Calendar and
Microsoft Graph calendars, with Meet and Teams meetings), which adds its scopes to the same grant.

- **Start:** `POST /api/v1/provider-authorizations` (scope `settings:write`) with `{"provider": "google" | "microsoft",
  "features": ["mail", "calendar"], "mailAccountId": <optional, to sign in again or allow more>}`. Calendars alone
  are only asked for an existing account (`mailAccountId`). The web client asks for calendars only when the user
  chooses to ("Also sync my calendars" on a new sign-in, "Allow calendar access" later): a Microsoft tenant may not
  let its users allow them, and asking would then cost the mail too. Signing in again asks for mail and the API adds
  what the grant allows already. The API stores a pending request (the
  SHA-256 of a random 256-bit `state`, the PKCE verifier, the user, the requested scopes; 15 minutes, single use) and
  answers the provider's `authorizationUrl`. `GET /api/v1/oauth-providers` lists the providers this server has an
  OAuth app for.
- **Callback:** the provider redirects the browser to `<API_PUBLIC_URL>/connect/<provider>/callback`. That route is
  behind the browser session of the API (the one used to sign in for `/oauth/authorize`; a signed-out browser signs
  in first and comes back), and the session user must be the user who started: a sign-in link someone else started
  cannot attach your provider account to their Tresso account. The API redeems the code with the verifier, reads who
  signed in (Google: the ID token's `sub` and verified `email`; Microsoft: the ID token's `tid` and `oid`, and the
  mailbox address from Graph `/me`), checks that the mail scopes were granted (users can untick them; calendars left
  unticked are allowed later, and only the calendar status says so),
  creates or updates the grant and creates the mail account (or signs an existing one in again), then redirects to
  the web app: `/settings/accounts/new` (or `/settings/accounts` when signing in again) with `connected=<account id>`
  or `connectError=<code>` (`denied`, `expired`, `different_user`, `scopes_missing`, `wrong_account`,
  `already_connected`, `unverified_address`, `no_mailbox`, `failed`). ID tokens come straight from the token endpoint
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
  renewed by heartbeat, so a crashed worker's accounts move to another worker automatically.
- **Change detection (IMAP):** `IDLE` on the inbox for instant new mail; other folders every 5 minutes. With
  `CONDSTORE`, flag changes since the last MODSEQ; without it, a full flag check, after an IDLE update at most once a
  minute (a throttled update is postponed, never dropped). Changes that happen between a sync and the next IDLE are
  caught by comparing the inbox's EXISTS, UIDNEXT and MODSEQ at re-selection.
- **Deletions without QRESYNC:** the worker reports presence ranges ("between UID a and b only these exist") in
  chunks of 5000; the API removes the rest. Every folder is checked at session start and every 30 minutes.
- **Gmail** (`internal/gmailsync`, Gmail API): labels are folders (remote name = label id; INBOX, SENT, DRAFT, TRASH
  and SPAM get their roles, user labels are custom), plus a virtual `tresso:all` folder (role `all`) for everything
  outside Trash and Spam, so archived mail keeps a location. Chats, UNREAD, STARRED, IMPORTANT and CATEGORY_* are not
  folders; seen = no UNREAD, flagged = STARRED, draft = DRAFT (Gmail has no "answered"). History is account-wide, so
  one cursor (`historyId`, backfill page token) lives on `tresso:all`; the history id is taken before the backfill
  starts, so nothing is missed. Backfill fetches `format=raw` newest first, once per message, and files it in every
  folder its labels map to. Changes come from `history.list` every 30 s; touched messages are re-read (`format=minimal`)
  and reported per folder. When the history id has expired (404), the folders are listed in full and compared with
  the API's `GET /internal/sync/accounts/{id}/folders/remote-uids` to find what was deleted.
- **Microsoft 365 / Outlook.com** (`internal/graphsync`, Microsoft Graph): every request asks for immutable ids
  (`Prefer: IdType="ImmutableId"`), so a message keeps its id when it moves. Folders are the folder tree (remote name
  = folder id, display name = path), with roles from the well-known folders. Each folder has its own cursor: the
  delta link, taken before the backfill, and the backfill position (by received time, so deletions during the
  backfill do not shift pages). The inbox delta is polled every 30 s, other folders every 5 minutes; a round with
  removals re-reads the folder tree first and applies every folder's additions before any removal, so a move links
  the message to its new folder instead of deleting it. An expired delta link (410, `syncStateNotFound`) restarts the
  folder's delta and compares with the API's remote uids. "Answered" is not available through delta.
- **Both providers:** flag changes go first (`changes`), and only the uids the API answers as `unknownUids` are
  downloaded (Gmail raw, Graph `$value`) and ingested; a message entering another folder is downloaded once more and
  linked to the stored one by Message-ID. Requests are rate limited per account (Gmail 200 quota units/s, Graph
  15/s), 429 and 5xx are retried with Retry-After, and a refused access token is renewed once through
  `credentials?rejected=1` (a second refusal, or missing scopes, reports `auth_failed`). Change notifications (Gmail
  Pub/Sub, Graph webhooks) need a public endpoint and are not used yet; polling covers both.
- **Connections** go through a guarded dialer that resolves the host and refuses private, loopback, link-local,
  CGNAT, NAT64, 6to4 and documentation ranges at connect time (the API checks at save time, the worker again on every
  connection, so DNS changes cannot redirect it). TLS 1.2+ with certificate verification, or STARTTLS.
- **Failures:** sessions reconnect with exponential backoff (2 s to 5 min). A refused login reports `auth_failed` and
  stops until the user changes the credentials; three failed sessions in a row report `error` with a user-safe
  detail.
- **Ingest:** raw MIME goes directly to object storage, encrypted with the account owner's blob key
  (`raw/<owner id>/<fp[0:2]>/<fp>`, named by the owner's content fingerprint, so duplicates within one user are
  stored once); attachments too (`attachments/<owner id>/<fp[0:2]>/<fp>`). The worker fetches the keys from
  `GET /internal/sync/accounts/{id}/storage-keys` (see "3.16 Encryption at rest"), and each message names the key
  version it was encrypted with (`keyVersion`); attachments are reported by `fingerprint`. Parsed metadata goes to the
  ingest protocol (scope `sync:ingest`, only for the leasing worker, every call safe to repeat):

  | Call | Purpose |
  |---|---|
  | `POST /internal/sync/accounts/{id}/folders` | The complete folder list. Answers each folder's stored cursor; a changed UIDVALIDITY resets the folder. Folders missing from the list are deleted. |
  | `POST /internal/sync/accounts/{id}/messages` | Up to 200 new messages for one folder plus the folder's cursor after the batch. A known (folder, uid) only refreshes flags; a message already stored (same Message-ID, else same raw content) only gains a location. |
  | `POST /internal/sync/accounts/{id}/changes` | Flag changes and vanished uids for one folder. A message that is in no folder anymore is deleted. |
  | `POST /internal/sync/accounts/{id}/status` | `active`, `auth_failed` or `error` with a short detail the user sees. |

  The cursor is opaque to the API: the worker decides what it holds (UIDNEXT, HIGHESTMODSEQ, backfill position).
- **Threading** (API side, at ingest): first by headers in both directions (messages this one refers to through
  In-Reply-To/References, and stored messages that refer to this one), merging threads that turn out to be one
  conversation; without any references, a thread from the last 14 days with the same normalized subject that shares
  a participant; otherwise a new thread.
- **Backfill:** newest first, in budgeted steps per folder, so the inbox is usable within seconds while history fills
  in behind and new mail is never stuck behind it. Fetches are grouped by count (50) and size (20 MB).
- **Cursor:** per folder, opaque to the API: UIDVALIDITY, UIDNEXT, backfill position and HIGHESTMODSEQ. It only
  advances after the API accepted the work it covers, so a crash never skips mail.
- **Sending:** `POST /api/v1/outgoing-messages` (scope `mail:send`) queues mail from one of the user's accounts, now or
  at a `sendAt` (send later, or a few seconds for undo; cancellable until a worker takes it). The API builds the
  MIME message (In-Reply-To and References for replies, Bcc only on the envelope) and stores it in object storage.
  Once the transaction commits it tells the workers on the Mercure topic `urn:tresso:sync:outbox`; scheduled mail is
  released by a delayed Messenger message, and every heartbeat both releases due mail and lists the leased accounts
  with mail to send, so a lost notification only delays sending. The leasing worker claims due messages (5 minute
  claim), sends over SMTP (whole message refused when one recipient is refused), or for Gmail and Microsoft 365
  through their APIs (Gmail `users.messages.send`; Microsoft through a draft, see below; the envelope-only Bcc
  recipients are added as a Bcc header, which both providers strip; Gmail replies carry the thread id of the message
  they answer), files a copy in Sent (except at providers that do that themselves, Gmail and Microsoft included) and
  reports sent, retry (4xx, connection problems, a wrong password: up to 6 attempts over about 4.5 hours) or failed
  (5xx). A message claimed again after an unreported attempt is first looked up, so it is never sent twice; the
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
  consumer keeps running). A stopped action can still be undone.
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
  `hasMore`. Threads and messages also carry `heldUntil` and `batchedAt` (batched delivery, 3.7), messages the
  `unsubscribe` method they offer (`oneClick`, `mailto` or null) and the `unsubscribeMailto` address, smart inboxes
  `batchDelivery`, and the page the user's `unsubscriptions` (one per account and sender). A page never splits one
  change number. A deleted mail account implies its folders,
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
    never served (see 3.8).
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
  Gmail and Microsoft 365 the topmost header is always theirs. A generic IMAP server may add none, and then the
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
  put off for 15 minutes, so the sweep goes on with the others. The hourly backfill goes on in batches of 500 users for
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
  `Auto-Submitted: auto-generated`, to the notification address (the sign-in address or one of the user's mail
  accounts' addresses, the sign-in address when the chosen account is gone). It goes out at most once: `emailed_at`
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
  minutes on the `scheduler_default` transport) claims attachments never queued, then those still pending 15 minutes
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
rules), API keys and third-party apps, webhooks, the MCP endpoint, developer tools, statistics and Year in mail.

### 3.10 Clients

| Client | Stack | Local store | Push |
|---|---|---|---|
| Web (`apps/web`) | Vue 3, Vite, TypeScript, Pinia | IndexedDB | Web Push |
| Desktop (`apps/desktop`) | Tauri 2 (Rust) wrapping `apps/web` | SQLite via Rust | Native notifications |
| Mobile (`apps/mobile`) | Expo (React Native), TypeScript | expo-sqlite | APNs / FCM via Expo |

The desktop app runs the web client unchanged; only signing in and keeping the tokens go through the shell
(`apps/web/src/platform/desktop.ts`). It is its own OAuth client (`desktop`) with the redirect URI
`tresso://auth/callback`: sign-in opens the authorization page in the system browser, where the user's password
manager and existing sessions work, and the operating system hands the `tresso://` link back to the running app
(single instance on Windows and Linux), which exchanges the code with its PKCE verifier. Tokens are kept in the OS
keychain (Keychain, Credential Manager, Secret Service) by Rust commands, never in web storage, and read back before
the first screen. When the keychain refuses, the app says that the sign-in will not last instead of failing quietly.
The API and the Mercure hub accept the app's origins (`tauri://localhost`, and `http://tauri.localhost` on Windows),
and the main window may only open http(s) pages in the browser and read the link it was opened with.

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
through `packages/core`. `Session` (`apps/mobile/src/auth/session.ts`, plain TypeScript, unit tested) keeps the tokens
in expo-secure-store (Keychain on iOS, Keystore-encrypted on Android) as three entries, because some iOS releases
refuse values above about 2 KB, refreshes them before they expire with one shared request (refresh tokens rotate),
and never lets a refresh that finishes after sign-out sign the user back in.

Mail on the phone: the mobile app keeps a SQLite copy (expo-sqlite, one database per user) of
the mail accounts, folders, threads and messages from the delta, with a summary per thread as the web client does
(`summarizeConversation` in `packages/core`), each page applied in one exclusive transaction. The same `SyncEngine`
pulls it and the same `RealtimeClient` triggers pulls while the app is in the foreground; in the background the
connection rests and the copy catches up when the app comes back. `MailSession` runs this lifecycle one switch at a
time, awaiting every step: a copy is deleted only after it is closed (on sign-out, or when another user signs in),
and a small index database lists every copy on the device, so one that could not be deleted is removed the next
time. The last signed-in user is remembered, so their copy opens before the server confirms who is signed in, also
offline. The copy is the same `SqliteMailStore` the desktop app uses (see below). Message bodies show in a web view with the same Content-Security-Policy as
the web client's frame; only links the reader taps open, in the browser, and remote images load only when the
reader asks. Opening a conversation on the phone reads it, and its action bar archives, trashes, marks unread and
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

Push on the phone (`apps/mobile/src/notifications`): at every launch the app creates the Android channels the API's
pushes name (`reminders`, `mail` and their `_silent` twins). Once signed in, it asks the user for permission and
registers its Expo push token as an `expo` device, again when the token changes; the token needs the EAS project id
in the build (`extra.eas.projectId`, which `eas init` writes to `app.json`), and without it the app says that this
phone cannot get notifications. A sign-out removes the device first, so the user's notifications stop coming; when the
server cannot be told, the app signs out anyway and says so (the next sign-in on the phone takes the device over). A
tapped notification opens the screen its path names when the phone has it (`tappedRoute`: a conversation
`/thread/{id}`, the daily brief `/brief`, the todos `/todos`); other paths (a calendar event) open the app as it is. While the app is open, mail goes to the list without
a banner or sound (the user is in their mail already), and reminders show as a banner unless they came silently. A
conversation opened from a notification before the delta brought it shows as loading, pulls once, and says it is
gone only after a pull that completed; when that pull fails (offline) it says it could not be loaded, with Try again
(the web client does the same).

Shared TypeScript lives in `packages/core`: domain types, the OAuth flow, and the client side of the sync
protocol, so every client syncs the same way:

- `SyncEngine` pulls the delta into a `SyncStore` (each page and its cursor in one transaction). Pulls never overlap;
  a request during a pull makes it go round once more.
- `RealtimeClient` reads the hub through `fetch()` with the token as bearer, reconnects with backoff, renews the token
  before it expires, and asks for a pull on every (re)connect, because missed notifications are not replayed.
- `mailFrameDocument` wraps a sanitized body in the document for the sandboxed frame, with its Content-Security-Policy.

Every client keeps a copy of the user's mail behind one interface, `MailStore` in `packages/core`: the browser in
IndexedDB (`apps/web/src/mail/db.ts`), the desktop app and the phone in SQLite (`SqliteMailStore` in
`packages/core/src/store/sqlite.ts`, behind a small `Sql` interface each client implements). One database per user,
deleted on sign-out after it is closed. The browser's copy closes when another connection needs it gone or upgraded
(a sign-out or a newer version in another tab), so a delete or upgrade never waits on it. The tab then never fails
quietly: after an upgrade elsewhere it stops and says to reload (its code cannot open the newer copy), and after a
delete elsewhere or the browser closing the copy (site data cleared) it opens a fresh copy and syncs it again. Calls
on a copy closed like this say the copy is closing instead of failing on a dead connection. Next to the synced records each stores a summary per thread (senders,
snippet, unread count, whether it is in an inbox), recomputed whenever one of its messages changes, so the inbox lists
read a few dozen rows through an index however much mail is stored, plus the people the user exchanged mail with and
the drafts. How contacts and drafts follow the delta is shared (`packages/core/src/store/rules.ts`), and
both stores run the same tests (`describeMailStore`, exported as `@tresso/core/testing`; the SQLite store on sql.js).

The SQLite store writes one change at a time (a device may give each exclusive transaction its own connection without
a busy timeout), refuses writes once closing and waits for the ones under way, and stores each page with its cursor
in one transaction. A copy made by another schema version is dropped and rebuilt, keeping the drafts that exist only
on the device. A resync (after a change the server refused could not be put back) makes the next pull start from the
beginning, and holds across a restart and against a pull that was already running.

Both stores keep the smart inboxes and list a smart inbox across all accounts through an index on smart inbox,
whether the conversation is in an inbox or junk folder, and date (`ListScope`: an inbox or a smart inbox).
Conversations in the Spam smart inbox stay out of the inboxes, also when the server left them there
(`summarizeConversation`). A correction shows at once (`classifyThread`) and is put back when the server refuses
(`restoreThread`), unless the delta changed the conversation since. In the web client the sidebar lists the smart
inboxes with unread counts, the list and the reading pane show the verdict and change it or move the conversation,
and Settings > Smart inboxes edits them and lists the remembered senders. The IndexedDB copy moved to version 5 and the
SQLite copy to schema 3; both sync again from the start. Todos (3.14) moved them to version 6 and schema 4, batched
delivery to version 7 and schema 5, hand-overs (3.15) to version 8 and schema 6.

Both stores keep held conversations out of the lists and counts, list the delivered batches through an index on
inbox, batch time and date, and keep the unsubscribe requests (dropped with their account). The web client has a
Batches view (with the next batch time), an Unsubscribe button on the conversation and on each conversation in the
batches, a "Deliver in batches" choice per smart inbox and Settings > Batched delivery for the times and the zone;
the phone's `MailSession` unsubscribes and says what a conversation offers. The IndexedDB copy moved to version 7
and the SQLite copy to schema 5; both sync again from the start.

Drafts in the web client are saved on the device first and uploaded right after (one upload at a time per
draft). Edits made here are never overwritten by the delta: when another device saved a newer version, the compose
window asks whether to keep this version or take the other one. Drafts written before they were synced are
uploaded after the update.

Message actions in the web client: opening a conversation reads it; the conversation's buttons archive, trash, mark
unread, flag and move it (shortcuts E, #, U and S, not while typing or writing), and archiving, trashing or moving
goes back to the list with an undo. The undo moves back only what the action moved, each message from where it went
into the one folder it came from (`fromFolderId` on the move); for a message that was in several folders (Gmail's
All Mail aside) no exact undo exists, so none is offered. Each action changes the local copy first
(`applyAction` of the mail store), so lists update at once; when the server does not take it (for a large selection, the
batches it did not take), it is put back, except on messages the delta updated since.

Bulk actions in the web client: conversations are selected with their checkboxes (shift selects a range), by age
from the list's Select menu, or as everything from the senders of the selected ones; the last two search the whole
mailbox on screen in the local copy, not only the part of the list that is loaded. A bar above the list then marks
read or unread, archives, moves (within one account) or trashes every message of the selected conversations, with the
same exact undo as a single conversation (`apps/web/src/mail/useMessageActions.ts`); K, E, # and Escape work while a
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
(`apps/web/src/stores/bulk.ts`), with a Stop button while it runs. One bulk action runs at a time: the buttons are
disabled from the first click.

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
again; the outcome of each sent message is announced once. Recipient suggestions come from the people in synced
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
| `GET /api/v1/calendar-occurrences?from&to&timeZone&calendarId[]` | Occurrences in a range (at most 400 days), recurrence expanded: per occurrence the event id, the `recurrenceId`, start, end and the event's fields, overrides applied and exceptions removed. Series are expanded one occurrence at a time, at most 10,000 per answer (more is a 422 asking for a shorter range, never a silently shortened series; an hourly series fits the longest range). A series is the union of its `RRULE` and `RDATE`s (each in its own `TZID`) less its `EXDATE`s; an override with `RANGE=THISANDFUTURE` changes the later occurrences too, and an override whose occurrence the series no longer has still shows. Each occurrence is keyed by its start as it reads back once written into an event, so on the night clocks go back an occurrence at a repeated time (02:30), its override and its `EXDATE` share one key. An all-day occurrence lasts as many calendar days as its event, also on a 23-hour day. A rule repeating every so many hours, days or weeks (without `COUNT`) is jumped to near the range; any other walk through a rule stops after 100,000 steps, so an old dense series costs no more than a new one. Floating and all-day events are read in `timeZone`. Series that repeat more often than hourly are refused when stored, from the editor and from providers alike. |
| `GET /api/v1/calendar-events/{id}` | One event as stored (series or override). |
| `POST /api/v1/calendar-events` | Create in a writable calendar. |
| `PUT /api/v1/calendar-events/{id}?scope=&recurrenceId=&notify=` | Save the editor's complete event; for a series `scope` is `this`, `following` or `all`, and `recurrenceId` the occurrence the user edited. A different `calendarId` moves the event (whole series only). |
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
  overrides keep their own changed fields. A changed recurrence rule, or a switch between all-day and timed, starts
  the series fresh: its overrides and exceptions belong to occurrences that no longer exist and are dropped.
- Every change to time, place, status or the recurrence raises `SEQUENCE`, which is what tells attendees' clients
  that an update supersedes the previous one (RFC 5546). Which iTIP messages a change needs (requests to new and
  current attendees, cancellations to removed ones, a reply to the organizer) is decided by sabre/vobject's iTIP
  broker from the object before and after the change.

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
accepted.

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
    as the account's `calendarUrl`.
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
    cursor; calendars missing from the list are deleted, except after an empty list, after the first list from
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
  after a write or a sign-in that allowed calendars:
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
    A 403 means calendars are not allowed only for the calendar list (unless it is a rate limit, which is retried like
    any failure) or a token without the scopes; on one calendar it skips that calendar, and on a write it is a
    refusal.
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
  - The sender is the message's `From` address as the mail server delivered it. Tresso does not check SPF, DKIM or
    DMARC for this yet, so a forged `From` that the receiving server let through passes these checks; they keep
    strangers from acting for someone else, not a forger from acting for the organizer. Checking the
    `Authentication-Results` the receiving server adds is a later step.
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
  strip, and the event detail with RSVP.
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
    once todos exist (phase 2), todos.
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
  the phone's push registration); web push endpoints are unguessable capability URLs. Email notifications go only to the user's sign-in address or one of
  their mail accounts' addresses.
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
  the reading pane (`T`), which uses the newest email someone else sent, and the auto-create switch in the smart
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
  hand-over (`DELETE`); afterwards the hand-over stays.
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
