# Roadmap

Each phase ends in something usable. Phases are started one at a time after review. Everything on it comes to
this repository; what a phase still has planned is noted at its end.

## Phase 0: Foundation (done)

- [x] Architecture document
- [x] Monorepo layout, npm workspaces, Docker Compose dev stack (Postgres, Redis, RustFS (S3), Meilisearch, ClamAV)
- [x] Symfony 8 API on FrankenPHP with health endpoint
- [x] Initial domain schema + migration
- [x] OAuth2 authorization server skeleton (auth code + PKCE, client credentials)
- [x] Go sync worker skeleton (OAuth client credentials, lease heartbeat loop)
- [x] Vue 3 web, Tauri desktop and Expo mobile skeletons
- [x] Open source under `AGPL-3.0-only`, every feature in this repository (the early open core add-on hooks are
  gone)

## Phase 1: Read and send mail

Delivered in steps, each its own pull request:

- [x] 1.1 Accounts and credentials: envelope encryption with key rotation, mail account API (create, list, update,
  pause, delete), worker credentials endpoint, server-side request forgery checks, GreenMail test server
- [x] 1.2a Ingest protocol and threading: folders, message batches, changes, account status, thread merging
- [x] 1.2b Go IMAP sync: folder discovery, newest-first backfill, raw MIME and attachments to S3, MIME parsing,
  IDLE, CONDSTORE deltas, presence-based deletions, SSRF-guarded connections
- [x] 1.3a Client delta sync: per-user change numbers committed in order, tombstones, paged delta endpoint
- [x] 1.3b Mercure realtime: issuer-based hub, RFC 9396 subscriber tokens per user, "changes up to N" published
  after commit
- [x] 1.4a Message content API: sanitized HTML body with remote content blocked by default, signed attachment URLs
- [x] 1.4b Web client: sign-in, Unified Inbox and per-account inboxes from a local IndexedDB copy kept current by
  delta sync and realtime, reading pane rendering the body in a sandboxed frame
- [x] 1.4c Account management in the web client: server settings found from the address, add, fix, pause and remove
  mail accounts, with the connection result shown live
- [x] 1.5a Sending through the worker: outbox, send later and undo, retries, Sent copies, no double sends
- [x] 1.5b HTML signatures per mail account: sanitized on save, a default per account, synced to clients, edited
  in Settings with a live preview
- [x] 1.5c Compose, reply and forward in the web client: recipient suggestions, undo send, send later, outbox, drafts
  kept on the device until a message is confirmed sent
- [x] 1.5d Search: Meilisearch index kept in step with sync changes, from:, to:, in:, has:attachment and date filters,
  results with highlights in the web client
- [x] 1.5e Drafts synced across devices and filed in the account's Drafts folder, with conflicts between devices
  settled by the user
- [x] 1.6 Gmail and Microsoft 365: OAuth connection, Gmail API and Microsoft Graph sync
- [x] 1.7 Message actions: read, flag, archive, trash and move from the clients, made on the server by the worker

## Calendar

Built next to phase 1, each step its own pull request. See "3.13 Calendar" in the architecture.

- [x] C1 Architecture: data model, sync sources, invitations, client sync, reminders and notifications, online
  meetings, AI interfaces
- [x] C2 Calendar core: calendars (provider and local Tresso calendar) and events with RFC 5545 recurrence,
  overrides, exceptions, time zones, attendees, reminders and conference data; occurrences in a range; create, edit
  and delete with "this / this and following / all"; RSVP with iTIP replies through the outbox; calendars and
  events in the delta; `text/calendar` parts parsed by the worker and applied as invitations; CalDAV sync for IMAP
  accounts (discovery, sync-token or ctag, outbound writes, a calendar status per account)
- [x] C3 Reminders and notifications: server-side scheduling with a sweep, idempotent delivery per device through a
  dispatcher other features share, phone (Expo), desktop (web push and the desktop app) and email channels with
  the user's channels per kind, multiple reminders per event with their own channels, default rules per calendar
  and kind of event, important events, leave-now with a fixed travel time or the phone's estimate by travel mode
  (the position never stored), quiet hours, working hours for work calendars, focus blocks, snooze choices,
  pre-meeting briefs and follow-up nudges
- [ ] C3b Digests and attendance: the email digest channel with tomorrow at a glance (end of the working day) and the
  week ahead, warnings when the user will be late with an offer to tell the organizer, and asking about meetings the
  user did not join (reschedule or let the organizer know)
- [ ] C4 Calendar clients: day, week, month and agenda views and the event editor in the web client, the invitation
  card with RSVP in the reading pane, a mini agenda next to mail, notification settings and push registration;
  agenda and event detail on mobile with Expo push, on shared types and recurrence expansion in `packages/core`
  - Done: calendars and events in the local copies, recurrence expansion, layout, edit scopes and time zones in
    `packages/core`; the four web views, the editor, the invitation card and the mini agenda; the mobile agenda,
    day view and event detail with RSVP.
  - Still to do, on the C3 endpoints: the notification settings screens, push registration on web and desktop
    (`POST /api/v1/notification-devices`), and Expo push on mobile.
- [x] C5 Google and Microsoft calendars and online meetings: Google Calendar API and Microsoft Graph calendar sync
  in both directions through the provider OAuth layer (1.6), with calendars as a feature of their own (incremental
  consent, a `not_granted` calendar status and "Allow calendar access" in the account settings); invitations,
  updates and replies sent by the providers (`notify` and the reply comment on each write); Teams meetings through
  Graph, Google Meet through `conferenceData`, asked for with `conferenceProvider` per calendar; a join link for
  every recognized meeting (`conference.url`; the join buttons themselves come with the calendar views of C4)
- [x] C6 Calendar assistant interfaces with the deterministic meeting time finder: the
  `EventDraftInterpreter`, `MeetingTimeFinder`, `EventExtractor` and `MeetingBriefWriter` interfaces with their
  capabilities; meeting times from the user's calendars within their working hours, focus blocks, buffer, travel time
  and notice, across time zones and daylight saving, each slot explained, with the same API for planning todos; event
  suggestions from a message's calendar parts

Planned, with your own AI key or endpoint: natural language event creation, meeting time suggestions with attendees'
availability, events and deadlines extracted from mail, meeting briefs.

## Phase 2: Do, hand over, know

Delivered in steps, each its own pull request:

- [x] 2.1 Smart inboxes and rule-based classification: built-in smart inboxes (spam, notification, advertise, todo,
  informational) and custom ones (name, instructions, include/exclude lists, verdict mapping), a classifier interface
  with a rule-based implementation run after ingest, the smart inbox and verdict per conversation in the delta,
  corrections remembered as sender rules, smart inboxes in the web client's sidebar, lists and settings
- [x] 2.2 Todos: synced todos with a due date, time and duration, "Make todo" from an email (one todo per email),
  automatic todos per smart inbox (only with the Do verdict), a Todos page with quick add and sections on the web,
  and a todo list on mobile
- [x] 2.4 Hand over by forwarding with a note and due date, tracked in "Waiting on" with nudges: the conversation is
  forwarded through the shared compose flow with its files, a synced hand-over closes when the delegate replies in it
  (detected on ingest) or is marked done, the due date is scheduled through Messenger and, when it passes without a
  reply, announced through the notification dispatcher and in the apps, and a one-click nudge replies to the delegate;
  web and mobile clients
- [x] Daily brief for `know` mail, one-click "Noted": once a day at the user's time in their zone, the conversations
  judged `know` since the last brief, per smart inbox or sender with subject and snippet, synced to every client;
  Noted reads and archives through the message actions, with undo; push to phones and desktops and an email digest
  through the notification preferences (kind `daily_brief`); settings and the brief on the web, the brief on mobile
- [x] 2.7 Batched delivery and one-click unsubscribe: mail of smart inboxes that deliver in batches (notification and
  advertise by default) held until the user's batch times in their zone and kept out of lists and notifications
  until then, released by a delayed message with a sweep every minute as safety net; for authenticated senders only,
  RFC 8058 one-click requests made by the sync worker through a strict guarded dialer, or one fixed mail to an address
  in the sender's own domain through the outbox, recorded per account and sender; the batches view, the unsubscribe
  button and the batch settings in the web client, the data layer on mobile
- [x] Triage mode: the inboxes' undecided mail one conversation at a time in the web client (D do, H hand over, K
  know, J skip, Z undo) and on the phone (buttons); do and hand over place only that conversation (do makes its todo),
  know archives it

- [x] Todos in the calendar: a todo with a due date and a duration ("takes 30 minutes") is planned with "Plan
  automatically" at the earliest free time before it is due, with the meeting time finder of C6 (working hours, focus
  blocks, buffers and travel time respected); that time is busy, so no meeting is booked over it, moves when the
  calendar or the todo changes, and is flagged when nothing else is free; a setting plans todos on their own; planned
  todos show in the calendars of web, desktop and mobile, and stay in Tresso (not written to provider calendars)

Still to come in this phase:

- Busy hints when picking a due date: choosing a deadline or a time shows how busy each day and hour already is

Planned, with your own AI key or endpoint: AI classification with feedback learning, automatic todo extraction, AI
summaries in the daily brief.

## Phase 3: Native apps

- [x] 3.1 Desktop sign-in: the system browser signs in, `tresso://auth/callback` brings the result back, tokens in the
  OS keychain
- [x] 3.2 Desktop notifications: native notifications for new unread inbox mail judged `do` or `delegate`
- [x] 3.3 Mobile sign-in: Expo Router app shell, the system's authentication browser signs in through
  `tresso://auth/callback`, tokens in the OS secure store
- [x] 3.4 Mobile mail: a SQLite copy kept current by the delta and realtime, the Unified Inbox and conversations with
  their messages
- [x] 3.5 Tauri desktop with a local SQLite cache instead of the web view's IndexedDB
- [x] 3.6 Mobile message actions: read on open, archive, trash, unread and flag, with the exact undo
- [x] 3.7 Mobile compose and push: new mail judged `do` or `delegate` (unread, in an inbox) reaches the phone, the
  desktop app and browsers once, held in meetings and focus blocks and silent in quiet hours; a tap opens the
  conversation

Planned, on top of organizations: teams, shared inboxes, assignments, internal comments, delegation rules, workload.

## Phase 4: Safety and housekeeping

- [x] 4.1 ClamAV attachment scanning and quarantine: clamd over INSTREAM in a Messenger job per attachment, verdicts
  cached by content hash, infected content moved to quarantine, the message flagged through the delta sync and
  realtime, no downloads before a scan, rescans from the console, scan states on the web client's attachments
- [x] 4.2 Bulk actions in the web client: select conversations (checkboxes, shift for a range), act on all of them,
  select everything from their senders or older than an age
- [x] 4.3 Bulk management by smart inbox, cleanup suggestions (after 2.1): act on everything a smart inbox lists, one
  of its senders or what is older than an age, in batches on the server with the exact undo; suggestions from fixed
  rules (newsletters and senders never opened, old notifications, large old mail) with one click each
- [x] 4.4 Encryption at rest per user: versioned user keys and an index key wrapped by the master keys, raw MIME,
  attachments, uploads, outgoing messages and Drafts folder copies encrypted per user in a streamed AEAD format under
  owner-scoped names (the sync worker encrypts with keys it gets per leased account), body texts, snippets and
  notification texts sealed in the database (notification texts cleared after a week), a virus scan cache that links no
  users, master and user key rotation, re-encryption of existing data as a resumable background job, user deletion with
  crypto-shredding that fails closed
- [ ] 4.5 Encryption at rest, next: blind indexes so subjects, addresses and names can be sealed too, draft bodies,
  hand-over notes, event notes and todos sealed, rotating the index key (renaming a user's objects), dropping
  `user.wrapped_data_key`, `message.snippet`, `message_text.text` and `mail_notification.body` once
  `app:crypto:reencrypt --status` reports nothing left everywhere

Planned: API keys and third-party apps, webhooks, MCP endpoint, developer tools, statistics, Year in mail.

## Phase 5: Tresso Cloud

Managed hosting of this same code, paid per organization member; self-hosting stays free with every feature.

- [x] 5.1 Organizations: a personal organization for every user (new users and, in the migration, existing ones),
  `GET /api/v1/organizations` with role and seats, removed with the user
- [x] 5.2 Billing in the API behind configuration, off by default ([Billing](BILLING.md)): Stripe subscriptions per
  organization with a 14-day trial without a card, Checkout with Stripe Tax and the billing portal, a signed and
  idempotent webhook with a nightly check, 402 for a user without access, and no sync, notifications or daily brief
  for them
- [ ] 5.2b The payment screen in web and desktop (on 402, from `GET /api/v1/billing`), a subscription page in the
  settings and a notice before the trial ends; mobile names the expired subscription and points to the web
- [x] 5.3 Production images per release on GitHub's container registry (API and workers, sync workers, web client;
  amd64 and arm64), a production compose file with automatic HTTPS, and a start that refuses missing or development
  secrets, which the managed service runs unchanged
