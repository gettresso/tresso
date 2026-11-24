<script setup lang="ts">
import { computed, ref } from 'vue'
import { guessedServers, type ServerSettings } from '@tresso/core'
import { fieldErrors, manualSchema, serverErrors } from '@/forms/accounts'
import ServerFields from '@/components/ServerFields.vue'
import { domainOf, LIST, passwordLabel } from './importTexts'
import type { ImportRow, PasswordValues } from './useAccountImport'

/**
 * The password form of one row of the list (the AddAccountsList board): the server settings that were found, the
 * username and a password field marked up as a sign-in form, so a password manager offers the entry of this address.
 * "Change settings" (and a row without found settings) shows the servers to change.
 */
const props = defineProps<{ row: ImportRow; settingsShown: boolean; busy: boolean; allowUnencrypted: boolean }>()
const emit = defineEmits<{ submit: [values: PasswordValues]; showSettings: [] }>()

const start = props.row.servers ?? guessedServers(domainOf(props.row.address))
const imap = ref<ServerSettings>({ ...start.imap })
const smtp = ref<ServerSettings>({ ...start.smtp })
const username = ref(props.row.username)
const password = ref('')
const errors = ref<Record<string, string>>({})

/** The servers are shown to change when asked for, or when none were found. */
const editing = computed(() => props.settingsShown || props.row.servers === null)

function submit(): void {
  const parsed = manualSchema(domainOf(props.row.address)).safeParse({ imap: imap.value, smtp: smtp.value, username: username.value, password: password.value })
  if (!parsed.success) {
    errors.value = fieldErrors(parsed.error)
    return
  }
  errors.value = {}
  emit('submit', parsed.data)
}
</script>

<template>
  <form class="form" :aria-label="passwordLabel(row.address)" novalidate @submit.prevent="submit">
    <div v-if="!editing && row.servers" class="found">
      <span class="found-text">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7" /></svg>
        <span
          >Server settings found: <span class="mono">{{ row.servers.imap.host }}</span>, port {{ row.servers.imap.port }}, and <span class="mono">{{ row.servers.smtp.host }}</span>, port
          {{ row.servers.smtp.port }}.</span
        >
      </span>
      <button type="button" class="change" @click="emit('showSettings')">{{ LIST.changeSettings }}</button>
    </div>
    <template v-else>
      <ServerFields v-model="imap" protocol="imap" title="Incoming mail" :errors="serverErrors(errors, 'imap')" :allow-unencrypted="allowUnencrypted" />
      <ServerFields v-model="smtp" protocol="smtp" title="Outgoing mail" :errors="serverErrors(errors, 'smtp')" :allow-unencrypted="allowUnencrypted" />
    </template>
    <div class="fields">
      <div class="field-box">
        <label :for="`bulk-user-${row.id}`" class="field-label">{{ LIST.username }}</label>
        <input
          :id="`bulk-user-${row.id}`"
          v-model="username"
          type="email"
          name="username"
          autocomplete="username"
          spellcheck="false"
          :readonly="!editing"
          class="input"
          :class="{ readonly: !editing }"
          :aria-invalid="errors.username ? 'true' : undefined"
        />
        <small v-if="errors.username" class="error" role="alert">{{ errors.username }}</small>
      </div>
      <div class="field-box">
        <label :for="`bulk-password-${row.id}`" class="field-label">{{ passwordLabel(row.address) }}</label>
        <input :id="`bulk-password-${row.id}`" v-model="password" type="password" name="password" autocomplete="current-password" maxlength="1024" class="input password" :aria-invalid="errors.password ? 'true' : undefined" />
        <small v-if="errors.password" class="error" role="alert">{{ errors.password }}</small>
      </div>
      <button type="submit" class="add" :disabled="busy">{{ LIST.checkAndAdd }}</button>
    </div>
    <span class="note">{{ LIST.passwordNote }}</span>
  </form>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 0 0 12px 36px;
  padding: 14px 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
  background: var(--ground);
}
.found {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
}
.found-text {
  display: flex;
  flex: 1 1 300px;
  gap: 8px;
  font-size: 13px;
  line-height: 19px;
  color: var(--ink);
}
.found-text svg {
  flex-shrink: 0;
  margin-top: 2px;
  color: var(--know);
}
.mono {
  font: 400 12px var(--font-mono);
}
.change {
  padding: 0;
  border: 0;
  background: none;
  color: var(--focus);
  font: 600 13px var(--font-ui);
  cursor: pointer;
}
.change:hover {
  text-decoration: underline;
}
.fields {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 10px;
}
.field-box {
  display: flex;
  flex: 1 1 200px;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.field-label {
  font-size: 13px;
  font-weight: 600;
}
.input {
  box-sizing: border-box;
  height: 38px;
  padding: 0 12px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-control);
  background: var(--paper);
  color: var(--ink);
  font: 400 14px var(--font-ui);
  outline: 0;
}
.input.readonly {
  background: var(--ground);
  color: var(--ink);
}
.input:focus-visible {
  border: 2px solid var(--focus);
}
.add {
  height: 38px;
  padding: 0 14px;
  border: 0;
  border-radius: var(--radius-control);
  background: var(--ink);
  color: var(--paper);
  font: 600 13px var(--font-ui);
  white-space: nowrap;
  cursor: pointer;
}
.add:disabled {
  opacity: 0.55;
  cursor: default;
}
.note {
  font-size: 12px;
  line-height: 17px;
  color: var(--ink-2);
}
.error {
  color: var(--danger);
  font-size: 12px;
}
</style>
