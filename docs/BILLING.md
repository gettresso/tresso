# Billing

Self-hosting Tresso is free and has every feature. Tresso Cloud, the managed hosting of the same code, is paid per
organization member. Billing is part of this repository and is turned on by configuration on the server that bills
(`TRESSO_BILLING=1`). It is off everywhere else: such a server never bills, never asks for payment and never blocks
anyone. This document is the contract the API, the web and desktop clients and the mobile app work to.

## Model

- **Organization.** Every user owns a personal organization from the moment the account exists; teams are
  organizations with more members (see [Architecture](ARCHITECTURE.md#organizations)). A subscription belongs to an
  organization, so one user with several mail accounts pays once.
- **Seats.** The members of an organization are its seats: Checkout subscribes to the price with the member count as
  quantity, and the seat count shown is the quantity Stripe reports. Until teams exist every organization has one
  member; updating the quantity when members join or leave comes with teams.
- **Trial.** Every organization starts with a free trial of 14 days, without a card and without anything at Stripe
  (status `trial`), made together with the organization. A server that turns billing on later runs
  `php bin/console app:billing:restart-trials` once, which gives every organization without a Stripe subscription 14
  days from then.
- **Access.** A user may use the server while at least one of their organizations gives access. An organization gives
  access until `trialEndsAt`, whatever happens at Stripe meanwhile, and after that by the status of its Stripe
  subscription:

  | Status | From | Access after the trial |
  |---|---|---|
  | `trial` | Tresso | no: the trial is over |
  | `trialing`, `active` | Stripe | yes |
  | `past_due` | Stripe | yes: a payment failed and Stripe is retrying it (its retries and emails run) |
  | `unpaid`, `canceled`, `incomplete`, `incomplete_expired`, `paused` | Stripe | no |

- **Blocked.** Without access, everything that serves that user stops: the API answers `402`, the sync workers lease
  none of their accounts (no mail in or out), and no notification or daily brief goes out. Their data stays as it is,
  and everything resumes as soon as a subscription gives access again. What still works carries no new data: signing
  in and out and refreshing tokens (so the app can show the payment screen), a realtime token already issued until it
  expires (within an hour), and attachment links already handed out until they expire.

## API

### Server info

`GET /api/v1/server-info` needs no sign-in and is always open, also to a blocked user:

```json
{ "product": "tresso-server", "apiVersion": 1, "billing": true, "trialDays": 14 }
```

`billing` is false and `trialDays` 0 on a server that does not bill. `apiVersion` is raised only when an older app can
no longer work with the server.

### Billing status

`GET /api/v1/billing` (signed in with `settings:read`, open while blocked):

```json
{
  "userId": "…",
  "enabled": true,
  "entitled": false,
  "plans": ["monthly", "yearly"],
  "organizations": [
    {
      "id": "…",
      "name": "Kim Visser",
      "personal": true,
      "status": "trial",
      "entitled": false,
      "trialEndsAt": "2026-11-12T10:00:00+00:00",
      "currentPeriodEnd": null,
      "seats": 1,
      "canManage": true
    }
  ]
}
```

- `entitled` says whether the user may use the server now; `organizations[].entitled` whether that organization gives
  access. The user's own personal organization comes first.
- `plans` lists the plans this server sells (a plan without a configured price is left out).
- `canManage` is true for owners and admins: only they pay or manage.
- On a server that does not bill: `{"enabled": false, "entitled": true, "plans": [], "organizations": []}`.

### Paying and managing

Both need `settings:write`, take `{"organizationId": "…"}` and answer `{"url": "https://…"}`, a Stripe page to open in
the browser:

- `POST /api/v1/billing/checkout` with `"plan": "monthly" | "yearly"`: Stripe Checkout for that plan, for every
  member. Checkout collects the billing address and VAT id, and Stripe Tax charges the VAT. After paying, Stripe
  returns to `<WEB_APP_URL>/settings/billing?checkout=done` (or `?checkout=cancelled`).
- `POST /api/v1/billing/portal`: Stripe's billing portal, to change the plan or the card, see invoices or cancel. It
  returns to `<WEB_APP_URL>/settings/billing`.

Answers: `404` when the server does not bill or the organization is not the user's, `403` for a member who is not an
owner or admin (or a token without `settings:write`), `409` for a checkout while the organization has a Stripe subscription that is
not over (trialing, active, past due, unpaid, paused or incomplete, also one Stripe has whose events did not arrive
yet, which the server then takes over; change plans in the portal instead), `422` for a plan the server does not sell or a portal before any subscription, `502`
when Stripe refused the request (logged on the server) and `503` when Stripe could not be reached.

### Payment required

A blocked user gets `402` from every `/api/` call except the ones above (`/api/v1/server-info`, `/api/v1/billing`,
`/api/v1/billing/checkout`, `/api/v1/billing/portal`):

```json
{
  "type": "https://tresso.app/errors/payment-required",
  "title": "Payment Required",
  "status": 402,
  "detail": "The trial or subscription has ended. Open billing to subscribe."
}
```

Signing in and out (`/login`, `/oauth/…`, `/logout`) are outside `/api` and keep working. A client that gets `402`
shows its payment screen: from `GET /api/v1/billing`, the trial's end or the subscription's status, and for an owner or
admin the buttons that open Checkout or the portal. The server alone decides; a client never unlocks anything itself.

## Stripe

- **Webhook.** One endpoint per server, `POST <API_PUBLIC_URL>/billing/stripe/webhook`, with these events:
  `checkout.session.completed`, `customer.subscription.created`, `.updated`, `.deleted`, `.paused`, `.resumed`,
  `invoice.paid`, `invoice.payment_failed` and `customer.deleted`.
  - The `Stripe-Signature` header must be an HMAC-SHA256 of `timestamp.body` with the endpoint's signing secret, made
    within 5 minutes; anything else gets `400`.
  - Every event id is handled once; a repeat answers `{"received": true, "duplicate": true}`.
  - An event only says which subscription changed: the server then reads that subscription from the Stripe API and
    takes it over as it is, with the organization's row locked before Stripe is asked, so events may come in any
    order and the later one stores the later answer. A subscription that does not pay never replaces another one that
    does, nor one of another customer, so a late event about an old, canceled subscription, or about a customer that
    was deleted, changes nothing. If Stripe cannot be asked, the answer is `500` and Stripe sends the event
    again.
  - `customer.deleted` forgets the customer and its subscription; a new checkout makes a new customer.
  - Two Checkout pages opened at once, before either is paid, are not refused: Stripe only knows a subscription once
    one is paid. Should both be paid, the portal cancels the extra one.
- **Nightly check.** At 03:17 UTC the server asks Stripe for the subscriptions of every customer it knows and takes over
  the best one (one that pays, then the one it follows, then the newest), in case webhooks were lost; this also finds a
  first checkout none of whose events arrived. Each organization is checked with its row locked, like a webhook. A
  customer Stripe says it does not have is kept and reported (a wrong
  key says the same); only `customer.deleted` forgets one. Handled event ids older than 30 days are removed. `php bin/console app:billing:reconcile` does
  the same by hand.
- **Linking.** Checkout puts the organization id in the subscription's metadata and as `client_reference_id`; the
  customer is made once per organization and kept.
- **API version.** Requests pin `Stripe-Version: 2025-03-31.basil`.
- **Stripe Tax** must be turned on in the Stripe dashboard (with the origin address and the registrations), and the
  billing portal configured (which plans can be switched to, cancellation).

## Configuration

Only the server that bills sets these; the API refuses to start when billing is on and one is wrong:

| Setting | Value |
|---|---|
| `TRESSO_BILLING` | read as a boolean: `1`, `true`, `yes` or `on` (or any other non-zero number) turn billing on; `0`, `false`, empty or unset leave it off |
| `STRIPE_SECRET_KEY` | `sk_live_…` or a restricted `rk_live_…` key; `sk_test_…` on a staging server |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…`, the signing secret of the webhook endpoint above |
| `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_YEARLY` | `price_…`, at least one; a recurring price per seat |

Prices and their amounts live in Stripe, not in the code. Production uses Stripe's live mode and staging its test mode,
each with its own webhook endpoint. The keys live in 1Password and reach the deployment from there; its
infrastructure is in the private `tresso-internal` repository.
