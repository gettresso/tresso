import { describe, expect, it } from 'vitest'
import { describeSubscription, hasSubscription, trialDaysLeft, type BillingOrganization } from './billing'

const NOW = new Date('2026-11-01T12:00:00Z')

function organization(change: Partial<BillingOrganization> = {}): BillingOrganization {
  return {
    id: 'org-1',
    name: 'Kim Visser',
    personal: true,
    status: 'trial',
    entitled: true,
    trialEndsAt: '2026-11-04T10:00:00Z',
    currentPeriodEnd: null,
    seats: 1,
    canManage: true,
    ...change,
  }
}

describe('billing', () => {
  it('counts the trial days left, rounded up, never below zero', () => {
    expect(trialDaysLeft(organization(), NOW)).toBe(3)
    expect(trialDaysLeft(organization({ trialEndsAt: '2026-11-01T13:00:00Z' }), NOW)).toBe(1)
    expect(trialDaysLeft(organization({ trialEndsAt: '2026-10-20T00:00:00Z' }), NOW)).toBe(0)
  })

  it('knows when Stripe has a subscription to manage', () => {
    expect(hasSubscription(organization())).toBe(false)
    expect(hasSubscription(organization({ status: 'past_due' }))).toBe(true)
    expect(hasSubscription(organization({ status: 'unpaid' }))).toBe(true)
    expect(hasSubscription(organization({ status: 'canceled' }))).toBe(false)
    expect(hasSubscription(organization({ status: 'incomplete_expired' }))).toBe(false)
  })

  it('says where each status stands', () => {
    expect(describeSubscription(organization(), NOW)).toMatch(/^Free trial, 3 days left/)
    expect(describeSubscription(organization({ trialEndsAt: '2026-11-01T13:00:00Z' }), NOW)).toMatch(/^Free trial, 1 day left/)
    expect(describeSubscription(organization({ trialEndsAt: '2026-10-01T00:00:00Z' }), NOW)).toBe('The free trial has ended.')
    expect(describeSubscription(organization({ status: 'active', currentPeriodEnd: '2026-12-01T00:00:00Z' }), NOW)).toMatch(/^Subscribed, renews on /)
    expect(describeSubscription(organization({ status: 'past_due' }), NOW)).toContain('A payment failed')
    expect(describeSubscription(organization({ status: 'canceled' }), NOW)).toBe('The subscription has ended.')
  })
})
