# Operations

Steps for whoever runs a Tresso server or tags a release, beyond the README
([Your own server](../README.md#-your-own-server)): moving sign-in and MCP to their own addresses, scheduled work, and what is checked
by hand.

## Moving sign-in and MCP to their own addresses

For a server that runs the web client, the API and MCP on separate addresses behind a proxy: the sign-in pages move
from the API address to the web address (`TRESSO_AUTH_URL`) and MCP gets a host of its own (`TRESSO_MCP_URL`).
Section "Self-hosted and Tresso Cloud" in [ARCHITECTURE.md](ARCHITECTURE.md) describes what the two settings do. In
the steps, `<web>`, `<api>` and `<mcp>` stand for your three addresses. Do them in this order.

1. **Deploy the release with both settings unset.** The server behaves as before, plus the fixes of the release. Right
   after the deploy, sign in once on the web and once from the desktop app: this is the first real use of the Redis
   session handler, which the tests only drive directly. Every browser signs in once more after this deploy (sessions
   moved from files to Redis); apps and their tokens are not touched. If a release workflow deploys your server by
   itself, this step happens at the tag.
2. **DNS**: add a record (A and AAAA) for `<mcp>`, pointing at the same server as `<web>` and `<api>`, behind the same
   proxy or CDN as they are.
3. **One change, deployed as one:**
   - In your environment file: set `TRESSO_AUTH_URL=<web>` and `TRESSO_MCP_URL=<mcp>`. Leave `TRESSO_MCP_ON_API_HOST`
     unset (it means on). Load the file wherever your deployment keeps it.
   - In your proxy configuration (if it is not the `compose.prod.yaml` of this release, which has these routes): in
     the site block of `<web>`, before the web route, send the six sign-in paths to the API and put the web route in a
     `handle` of its own. In Caddy:

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
     ends on a 404 after the password. Add `<mcp>` to the API's site address (in `compose.prod.yaml`,
     `${TRESSO_API_URL} ${TRESSO_MCP_URL:-} {`), with the same `reverse_proxy api:80` and `header_up` line.
   - Login throttling behind the proxy: the sign-in form counts wrong passwords per client address (5 per address and
     IP, 25 per IP, 15 minutes). The API takes that address from `X-Forwarded-For` only from a proxy that
     `SYMFONY_TRUSTED_PROXIES` covers (`compose.prod.yaml` sets `private_ranges`, which covers the proxy container),
     and the `header_up` line makes the proxy pass the visitor's address on. With a CDN in front of the proxy,
     `{client_ip}` is the visitor's address only when Caddy trusts the CDN's address ranges (`trusted_proxies`);
     check that it does. Without both, every visitor counts as one address and 25 wrong passwords lock the form for
     everyone.
   - The API and web services get the three settings from this release's `compose.prod.yaml`. Pass them on yourself
     only where your own configuration overrides those environments: `AUTH_PUBLIC_URL`, `MCP_PUBLIC_URL` and
     `MCP_ON_API_HOST` for the API, `TRESSO_AUTH_URL` for the web image.
   - Never set `TRESSO_AUTH_URL` before the proxy routes are live: `/login` on the web address would reach the web
     client and nobody could sign in.
4. **Deploy checks**: besides the health check and the web root, check that `<web>/login` answers 200, and that a
   POST without a token to `<mcp>/mcp` answers 401 naming `<mcp>/.well-known/oauth-protected-resource/mcp` in its
   `resource_metadata`.
5. **CDN**: no cache or page rule may cache `/login`, `/logout` or `/oauth/authorize` on `<web>` (the API sends
   `no-store` on all three). The web image sends a Content-Security-Policy with `script-src 'self'`: a CDN feature
   that rewrites or injects scripts (such as Cloudflare's Rocket Loader) breaks the app, and an injected analytics
   script only logs an error. Open the browser console on `<web>` once after the deploy and look for CSP errors.
6. **Check by hand:**
   - Web sign-in from a signed-out browser, on `<web>`.
   - An installed desktop app signs in: it opens the API address and is sent on to the web address.
   - An existing MCP connection on `<api>/mcp` still calls a tool and refreshes its token.
   - A new MCP connection on `<mcp>/mcp` registers and signs in.
   - A third-party client that sends `resource=<api>/mcp` still reaches its consent screen.

   Every browser signs in once more on the web address, since its sign-in cookie belonged to the API host. Tokens are
   not touched.
7. **Then** point people at `<mcp>/mcp` (for Tresso Cloud: the README's Claude section and the website), and update
   your own notes on which address serves what.
8. **Much later**, by decision: `TRESSO_MCP_ON_API_HOST=0` ends MCP on the API host. Clients set up with the old
   address then add the server again under the new one and sign in once.
9. **Nothing changes at Google, Microsoft or Stripe:** `/connect/...` and the Stripe webhook stay on the API host.

The README has the short version
([Sign-in on the web address, MCP on its own host](../README.md#sign-in-on-the-web-address-mcp-on-its-own-host)).

## Scheduled work

The `maintenance` worker consumes `scheduler_default` alone (`apps/api/src/Schedule.php`). Besides the sweeps and
nightly purges described in ARCHITECTURE.md it runs `SweepChatRelays` every minute: a WhatsApp relay not heard from for
3 minutes is shown offline, and a WhatsApp reply still being sent 5 minutes after the relay took it is marked
"could not confirm" (never sent again by itself). When the worker was down, run it once by hand:

```
bin/console app:chat:sweep-relays
```

It prints how many relays went offline and how many replies could not be confirmed. A reply that carries a file gets
30 minutes before it counts as not confirmed.

The other WhatsApp jobs of the `maintenance` worker:

- `SweepChatMedia`, every 10 minutes: files uploaded for a reply that no reply took within an hour go, with their
  objects once nothing else refers to them, and so do temporary upload files (`tresso-chat-*`) older than an hour that
  a killed worker left. The API removes those temporary files itself too, so they also go where the API and the
  worker do not share a temporary directory.
- `PurgeCancelledReplies`, once a day at 03:59: replies cancelled while their sending was not confirmed are removed 30
  days after the relay took them. Their removal stays in the delta, so their ids stay refused.
- `SweepPendingScans` (every 5 minutes) and `SweepReencryption` (every hour) cover WhatsApp files and sealed chat
  columns like mail.

Removing a file that nothing needs any more (`CollectChatMedia`) runs on the `async` worker, and a WhatsApp push
(`NotifyChatMessage`) on the `push` worker. While the `maintenance` worker is down, relays are not shown offline,
unconfirmed replies stay `sending`, and unqueued uploads count toward the user's waiting bytes until it is back.

## WhatsApp files and a proxy in front of the API

With WhatsApp set to "All my devices", files go to the API as the raw body of a PUT: the relaying Mac's
`PUT /api/v1/chat-accounts/{id}/relay/media/{messageId}` and the browser's and phone's
`PUT /api/v1/chats/{chatId}/uploads/{id}`, up to `CHAT_MAX_FILE_BYTES` (100 MB, also the most it may be set to; the API
refuses to start with a value that is not a whole number from 1 to 100 MB). PHP's
form limits (`post_max_size`) do not apply to a PUT body, and the Caddy of the API image sets no limit, but a proxy in
front of it may: allow request bodies of at least 100 MB on those two paths (for nginx `client_max_body_size 100m;`),
and a request time of a few minutes. A proxy that refuses a body answers 413, which the apps show as "too large"; one
that cuts the connection makes the Mac try a requested file three times before it reports it as not brought.
`CHAT_MAX_WAITING_BYTES` (1 GB by default) bounds what one user's files waiting for the Mac take up.

## WhatsApp: deploy order and what an operator decides

Deploy the API first: it migrates the chat tables, and every WhatsApp endpoint the apps call is there before they
call it. Then the web client, then the desktop and phone apps. The browser's CORS rules allow `X-Device-Id` and
`X-Content-SHA256` (the relaying Mac's file upload). Settings:

- `CHAT_MAX_FILE_BYTES` (100 MB, the default and the most): the largest WhatsApp file, both ways. The API refuses to
  start with a value that is not a whole number from 1 to 100 MB.
- `CHAT_MAX_WAITING_BYTES` (1 GB): what one user's files waiting for the Mac (uploads and the files of replies not sent
  yet) may take up together.
- A proxy in front of the API: the body limit and request time above.
- `ATTACHMENTS_REQUIRE_SCAN=1` (a server that only serves checked files): a WhatsApp file that could not be scanned
  is then never linked; with the default the apps open it only after the user accepted a warning.

What is not the operator's to decide: WhatsApp is switched on per Mac by its user (`defaults write
app.tresso.desktop EnableWhatsApp -bool YES`), the bridge is the user's own build of the fork
([the bridge](whatsapp-bridge.md)), and a server holds chats only for users who chose "All my devices" on a Mac.

## Meeting links

Deploy the API before the sync workers. The workers report a meeting's outcome (`conferenceStatus`,
`conferenceError`) and read the request's nonce and the word to remove Google's meeting; an older API ignores the
fields and writes neither property, so nothing changes until it is out. Workers older than the API keep working,
without outcome reports and without removal. `SweepMeetingRequests` runs every minute on the maintenance worker
(`apps/api/src/Schedule.php`) and fails requests still pending after five minutes; while the maintenance worker is
stopped, such requests stay pending on the server. Clients offer "Leave without a link" only when
`GET /api/v1/calendar/capabilities` reports `meetingRequestDrop`, so they may go out before or after the API.

What this version does without the owner: Google Meet for events on Google calendars and Microsoft Teams for events
on Microsoft 365 work or school calendars, made by the calendar's provider with the calendar permission the account
already has, and the user's own room link on every calendar. Two parts wait on the owner, and are not built until
then. The names below are the planned ones: nothing in Tresso reads them yet.

- **Zoom.** A Zoom Marketplace app (OAuth, user-managed) registered by the owner, with its client id and secret given
  to the API as `ZOOM_OAUTH_CLIENT_ID` and `ZOOM_OAUTH_CLIENT_SECRET`. Without them a server never lists `zoom` in
  `apps`.
- **Teams links for events on calendars that are not Microsoft 365** (Google, CalDAV, Tresso): the Graph permission
  `OnlineMeetings.ReadWrite` added to the Entra app registration (and consented to where an organization requires
  it). Teams on a Microsoft 365 calendar needs no extra permission: Graph makes it through the event's
  `isOnlineMeeting`.

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

Meeting links, with real Google and Microsoft accounts (web and desktop unless named). Numbers follow on from the
list above.

Making and keeping a link:

20. A new event on a Microsoft 365 calendar: add a guest, the row switches on with Teams; save; the popover shows
    "Making the Teams link" with a spinner, then the link. The same on a Google calendar with Meet. With "Add a meeting
    link when I invite guests" off the row stays off.
21. With the worker stopped the popover turns to the red "Could not make the Teams link" after two minutes. Retry in
    the open editor, wait more than two minutes, start the worker again: the row shows the link by itself. A request
    the worker reported pending while no meeting was made shows as failed within about six minutes, without any sync
    (`SweepMeetingRequests`).
22. "Leave without a link" in the editor: the request goes, guests get no mail. Against a server without
    `meetingRequestDrop` in `/calendar/capabilities` the button is not there.
23. Pick another app in the editor, then let the first link arrive: the row shows the arrived link with the notice,
    and the save keeps it. Open an event, let another device add a link, save a title change: the link stays.
24. Remove the link on a second device while the editor is open, then save a title change: no new link, no mail.
    Move the event to another calendar on a second device while the editor is open, then save: "This event was moved
    to another calendar meanwhile. ..." appears and nothing is sent.
25. A recurring event edited for "This event", "This and following" and "All events", once with a link and once with a
    failed request: "This event" never makes a new meeting.
26. Pick "My own link", save, reopen: the link line with Copy link and Join. Remove a link, save, reopen, pick the same
    app again: a new link is made. An own link on a Teams or Meet address: that app's item is disabled with "The
    current link is already a ... link. Remove it first to get a new one." A Teams link pasted on a Microsoft 365
    calendar can be removed, with "Removed" and Undo. A Teams event made by Microsoft: the switch and removal are
    disabled, and the menu shows "Microsoft keeps ...".
27. "Connect a meeting app" from a new event, then "Back to the event": the values are there (a reload loses them).
    Desktop: sign out with a kept editor, sign in as another user: no editor opens. Escape in the editor's app menu
    closes only the menu (Safari, Chrome, desktop).

Providers:

28. Google Workspace and consumer Gmail: Google answers the Meet request with `success` (or `pending`, reported as
    such). The status Google gives when a calendar cannot have Meet (assumed 400), and its request status values
    (`pending`, `success`, `failure`).
29. Google: removing Meet (`PATCH` with `"conferenceData": null` and `conferenceDataVersion=1`) really removes it, and
    guests get an update; asking again makes a new link. A `createRequest` that reuses an earlier request id on the
    same event makes no second meeting.
30. Microsoft 365: a calendar without `teamsForBusiness` (or a tenant without Teams) saves the event without the
    meeting; how often `isOnlineMeeting: true` comes back without `onlineMeeting.joinUrl` right after the write.
31. Outlook, own link on an event: the body shows "Join the meeting: <url>" once as plain text, Graph gives the line
    back unchanged (no `<url>` suffix, no changed line breaks), and the next sync does not patch the body again. With a
    Teams join block in the body, the block stays and the line stays last.
32. Outlook, under a Teams block: two paragraphs that each start with a join line both survive an agenda edit in
    Tresso; a join line below other text appears once after an edit. Removing the link in Tresso while its line sits
    in such a paragraph brings the link back (a known limit).
33. Worker and API logs of these checks contain no `meet.google.com`, `teams.microsoft.com` or own link host.

Showing and joining:

34. Popover of a Teams and a Meet event, light and dark: the app's name, the link cut in the middle (hover shows it
    whole), Join with the Shift J keycap, Copy link ("Copied" for 2 s, the clipboard holds the whole link, VoiceOver says
    "Link copied" once). An invited event: "Microsoft Teams, added by {organizer}. Only the organizer can change it."
    The own link reads "My own link". Week and day view: the small camera after the title, also on short blocks.
35. Join in the browser opens a new tab that gets no referrer, and so does Shift J; on the desktop (macOS and Windows)
    the system browser opens and the app window stays. An `http://` link or a lookalike host gets no Join anywhere
    (popover, agenda, mini agenda, invitation card), only the link with Copy link.
36. Settings, Meeting apps in light and dark: cards, pills, table. Disconnect Meet, the editor greys it, Connect
    again. Reconnect on real Google and Microsoft accounts opens the sign-in (the system browser on the desktop) and
    comes back on Settings, Accounts. The own link: Tab away saves, `http://` is refused with nothing saved, Remove
    clears, and typing in the field then clicking Remove clears it without saving what was typed. A default survives a
    reload; with the network off the old value comes back with the error. Keyboard only through the page, the editor
    row and its menu; VoiceOver reads "Meeting app for ..." and the switch with its title and hint. With reduced motion
    the spinner turns slowly.
37. Phone: Join opens the provider's app or the browser for a Teams, Meet and Zoom link; Copy link says "Copied" for
    2 s and VoiceOver and TalkBack say "Meeting link copied"; a long Teams link keeps its whole host and wraps at the
    largest text size; in Hebrew or Arabic the link reads left to right, also a refused host on Android; an invitation
    with a place reads "Link from {organizer}. Or {place}" and the place is not repeated; dark mode. A link asked for
    on the web shows "Making the ... link" on the phone, then the link after a sync; Retry on a failed link shows
    "Making the ... link", and in airplane mode "No connection. Try again when you are online."

Reminders:

38. On the phone's lock screen, a reminder for a Dutch Outlook Teams event and for a Google Meet event names the app
    and holds no link. Leave-now for a place "Room (link)" and for a place that is only a link. One reminder by email.
    A desktop notification for an all-day event with a meeting.

WhatsApp, with a real WhatsApp account and phone, two Macs (Mac A relays, Mac B does not), a browser and the phone
app. Numbers follow on from the list above. Each check says what to expect.

Connecting on a Mac:

39. With `EnableWhatsApp` deleted (`defaults delete app.tresso.desktop EnableWhatsApp`) nothing of WhatsApp shows on
    the Mac and no bridge starts; with it set, the Accounts card appears.
40. A fresh clone of the fork, built with the command the dialog shows, links today. A bridge built from upstream, or
    one already running in a Terminal window, is refused as not protected, in plain words; Settings says `Port in use`
    or `open to your network on port ...` for it. From a second computer, the Mac's address on the fork's port 8741
    answers nothing.
41. The QR code scans from the phone, renews about every 20 seconds, and `Show a new code` works after 3 minutes.
    `Linked as <name>` shows the right name and number, and the first import's count roughly matches 30 days on the
    phone; that history arrives read.
42. Unlink the Mac on the phone: within a minute Tresso says WhatsApp is not linked, a reply fails with that reason,
    `Show how` gives a new code, and after scanning messages flow again.

Only this Mac:

43. Send to a person and to a group: each arrives once and shows `Sending`, then `Sent`. A reply sent from Tresso that
    the bridge stores as well (now, after a restart, after linking again) shows once.
44. A busy group: names above the bubbles are right, members without a saved contact show their WhatsApp name, members
    known only by a hidden number show something sensible, and a name that becomes known later appears on its own.
45. Stop the bridge for ten minutes while messages arrive, then start it: see whether they arrive after all, and that
    the bridge check in Settings says what happened.
46. Close the window (the app stays in the Dock) for an hour while messages arrive: they are there at once when it
    opens, and notifications came meanwhile with Notify me on, none with it off, and none for the chat open in a
    focused window.
47. Download a picture, a video, a document and a voice message, old and new; in a chat with many pictures each file
    is the right one, or Tresso refuses with the mismatch text. Attach a jpg, a pdf and an ogg: they arrive as a
    picture, a document and a voice message.
48. Leave a chat out and take it back in from Settings: its old messages come back read, a message sent after that
    arrives unread. Change folder keeps the chats. Disconnect leaves the bridge's store in the whatsapp-mcp folder, and
    reading in Tresso leaves the phone's unread badge as it was.
49. Dark mode: the chat pane, bubbles, notices, the connect dialog and the QR code read well.

All my devices:

50. On Mac A connect with "All my devices": copying is asked first, the last 30 days arrive read, Settings names Mac A
    as the relaying Mac. In the database `chat_message.sealed_text` starts with `f1.`; no text is readable.
51. A message from the phone reaches Mac A, Mac B, the browser and the phone app as unread.
52. Reply on Mac B, in the browser and on the phone while Mac A is online: `sending`, then `sent`. Quit Mac A, or let it
    sleep: within about 3 minutes every device says `Your Mac is offline since ...`, and a reply shows `waiting for your
    Mac`; start or wake Mac A: the replies go out once, in order, and turn `sent`.
53. Quit the bridge on Mac A: within a minute Mac B's Relaying Mac row shows the bridge's state.
54. Cancel a waiting reply: it never goes out. Kill Tresso on Mac A in the middle of a send (try with the network off):
    the reply ends as not sent with the "could not confirm" text, and is sent again only with Try again.
55. On Mac B, `Use this Mac instead`: Mac A stops relaying and its Settings names Mac B, no chat or message is doubled.
    Take over while Mac A is sending a reply: it ends `sent` everywhere, never `not confirmed`, and goes once.
56. Switch Mac A from "Only this Mac" to "All my devices" with a reply waiting (bridge unlinked): after linking again
    it goes out exactly once. Switch back: Remove is asked, the chats go from Mac B, the browser and the phone, and Mac
    A reads them in again, read. Quit Tresso in the middle of a switch, both ways, and start it: the switch finishes.
57. Leave a chat out on Mac B, take it back in on Mac A: old messages come back read, new ones unread. Groups off on
    Mac A: groups go from every device; on again: they come back read.
58. Disconnect on Mac B: the chats go from both Macs, the browser and the phone, and Mac A says WhatsApp was
    disconnected from the server. Remove WhatsApp from the server in the browser: the same.
59. Push with Notify me on (set in the browser or on Mac A): one push per chat burst on the phone, named after the chat,
    never the text or a number (a contact without a name says `New WhatsApp message`); a tap opens the chat. Expect a
    notification from WhatsApp itself as well.
60. Console.app on both Macs and the API and worker logs show no message text, names or numbers.

Files through the server:

61. In the browser and on the phone, ask for a photo and a PDF while Mac A relays: both arrive, show `Checking for
    malware.`, then open (the photo inline in a tab, the PDF as a download). With Mac A offline the row says it waits
    for the Mac.
62. A file over 100 MB, and an old message whose file WhatsApp no longer has: the row says why, and Try again is offered
    only where it may pass.
63. A file of nearly 100 MB on a slow line (a throttled network), asked for and attached: it arrives with its progress,
    behind the real proxy in front of the API (the body limit and request time in "WhatsApp files and a proxy").
64. Attach a file in the browser and on the phone: Mac A sends it, the recipient sees its name, and the staged copy in
    the app's `whatsapp-outbox` folder is gone after.
65. Cancel an attach halfway through the upload, and again while the reply is being queued (browser and phone):
    nothing reaches the chat. Cut the network right after Cancel: the line says the file may still be sent. Send the
    phone app to the background mid upload: nothing is sent.
66. Send yourself the EICAR test file on WhatsApp and ask for it: it is blocked and never opens on any device.
67. Leave a chat out after downloading one of its files: the object is gone from storage.

Tokens and MCP:

68. A personal access token with every scope except the two WhatsApp ones, and an MCP client without them: neither
    sees any WhatsApp list or endpoint. With `chat:read`, a token and an MCP client list, read and search the chats and
    see a file's kind, name and size, but never get a link to it; with `chat:send` alone, a reply is queued and nothing
    is read. A third-party app that did not name the WhatsApp scopes never gets them.
