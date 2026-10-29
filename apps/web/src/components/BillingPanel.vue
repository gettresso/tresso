<script setup lang="ts">
import { computed } from 'vue'
import { describeSubscription, hasSubscription, type BillingOrganization, type BillingPlan } from '@tresso/core'
import { useBillingStore } from '@/stores/billing'

/** Where each of the user's organizations stands, with the buttons that open Stripe for the ones they manage. */
const billing = useBillingStore()

const PLAN_LABELS: Record<BillingPlan, string> = { monthly: 'Subscribe monthly', yearly: 'Subscribe yearly' }

const organizations = computed(() => billing.status?.organizations ?? [])
const plans = computed(() => billing.status?.plans ?? [])

function title(organization: BillingOrganization): string {
  return organization.personal ? 'Your account' : organization.name
}

function seats(organization: BillingOrganization): string | null {
  return hasSubscription(organization) && organization.seats > 1 ? `${organization.seats} members` : null
}
</script>

<template>
  <ul class="organizations">
    <li v-for="organization in organizations" :key="organization.id" class="organization">
      <div class="summary">
        <strong>{{ title(organization) }}</strong>
        <span v-if="seats(organization)" class="seats">{{ seats(organization) }}</span>
        <p :class="{ ended: !organization.entitled }">{{ describeSubscription(organization) }}</p>
      </div>
      <div v-if="organization.canManage" class="actions">
        <template v-if="hasSubscription(organization)">
          <button type="button" class="button button-primary" :disabled="billing.opening" @click="billing.open(organization.id, 'portal')">
            Manage subscription
          </button>
        </template>
        <template v-else>
          <button
            v-for="(plan, index) in plans"
            :key="plan"
            type="button"
            class="button"
            :class="index === 0 ? 'button-primary' : 'button-quiet'"
            :disabled="billing.opening"
            @click="billing.open(organization.id, { plan })"
          >
            {{ PLAN_LABELS[plan] }}
          </button>
        </template>
      </div>
      <p v-else-if="!organization.entitled" class="hint">Ask an owner or admin of {{ organization.name }} to renew it.</p>
    </li>
  </ul>
  <p v-if="billing.error" class="form-error" role="alert">{{ billing.error }}</p>
</template>

<style scoped>
.organizations {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.organization {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
  background: var(--paper);
}
.summary p {
  margin: 2px 0 0;
  color: var(--ink-2);
}
.summary p.ended {
  color: var(--ink);
  font-weight: 600;
}
.seats {
  margin-left: 8px;
  color: var(--ink-2);
}
.actions {
  display: flex;
  gap: 8px;
}
.hint {
  margin: 0;
  color: var(--ink-2);
}
</style>
