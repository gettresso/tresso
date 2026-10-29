/**
 * Billing on a server that bills (Tresso Cloud), as `GET /api/v1/billing` describes it; see docs/BILLING.md. On any
 * other server `enabled` is false and nothing is ever blocked.
 */

export type BillingPlan = 'monthly' | 'yearly'

/** `trial` is Tresso's own free start; the rest are Stripe's statuses. */
export type SubscriptionStatus =
  | 'trial'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'unpaid'
  | 'canceled'
  | 'incomplete'
  | 'incomplete_expired'
  | 'paused'

export interface BillingOrganization {
  id: string
  name: string
  /** The signed-in user's own personal organization. */
  personal: boolean
  status: SubscriptionStatus
  /** Whether this organization gives its members access now. */
  entitled: boolean
  trialEndsAt: string
  currentPeriodEnd: string | null
  seats: number
  /** Owners and admins pay and manage. */
  canManage: boolean
}

export interface BillingStatus {
  enabled: boolean
  /** Whether the user may use the server now. */
  entitled: boolean
  plans: BillingPlan[]
  organizations: BillingOrganization[]
}

/** A Stripe page to open in the browser. */
export interface BillingPage {
  url: string
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Whole days left in the trial, rounded up; 0 once it is over. */
export function trialDaysLeft(organization: BillingOrganization, now: Date = new Date()): number {
  return Math.max(0, Math.ceil((new Date(organization.trialEndsAt).getTime() - now.getTime()) / DAY_MS))
}

/** Whether Stripe has a subscription for it: managing it goes through the portal, not a new checkout. */
export function hasSubscription(organization: BillingOrganization): boolean {
  return organization.status !== 'trial' && organization.status !== 'canceled' && organization.status !== 'incomplete_expired'
}

/** One sentence on where the organization stands, for the payment screen and the settings. */
export function describeSubscription(organization: BillingOrganization, now: Date = new Date()): string {
  const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })
  const days = trialDaysLeft(organization, now)
  switch (organization.status) {
    case 'trial':
      return days > 0 ? `Free trial, ${days === 1 ? '1 day' : `${days} days`} left (until ${date(organization.trialEndsAt)}).` : 'The free trial has ended.'
    case 'trialing':
    case 'active':
      return organization.currentPeriodEnd ? `Subscribed, renews on ${date(organization.currentPeriodEnd)}.` : 'Subscribed.'
    case 'past_due':
      return 'A payment failed. Stripe tries again; update the card to keep access.'
    case 'unpaid':
      return 'The subscription is unpaid. Pay the open invoice to continue.'
    case 'paused':
      return 'The subscription is paused.'
    case 'incomplete':
      return 'The first payment is not complete yet.'
    case 'canceled':
    case 'incomplete_expired':
      return 'The subscription has ended.'
  }
}

/** Trials that end this soon get a reminder. */
export const TRIAL_REMINDER_DAYS = 3
