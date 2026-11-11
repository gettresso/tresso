<script setup lang="ts">
import { useId } from 'vue'
import { APP_PASSWORD_GUIDES, PROVIDERS } from './providers'

/** Step "Connect iCloud Mail (or Yahoo Mail) with an app password": how to make one, and where to paste it. */
const props = defineProps<{
  provider: 'icloud' | 'yahoo'
  /** The address once valid, for the field's label. */
  address: string | null
  /** The user chose the provider without typing an address first: it is asked for here. */
  askAddress: boolean
  /** Problems to show: `refused` when the provider did not accept the password. */
  passwordError: 'refused' | 'empty' | null
  emailError: string | null
  formError: string | null
  busy: boolean
}>()
const password = defineModel<string>('password', { required: true })
const email = defineModel<string>('email', { required: true })
const emit = defineEmits<{ open: [url: string]; back: []; connect: [] }>()
const id = useId()

const guide = APP_PASSWORD_GUIDES[props.provider]
const company = PROVIDERS[props.provider].company
</script>

<template>
  <form class="cf-form" novalidate @submit.prevent="emit('connect')">
    <div class="cf-heading">
      <h1 id="connect-title">Connect {{ guide.full }} with an app password</h1>
      <p class="cf-lead">{{ guide.why }}</p>
    </div>
    <ol class="steps">
      <li v-for="(text, index) in guide.steps" :key="text">
        <span class="number" aria-hidden="true">{{ index + 1 }}</span>
        <span>{{ text }}</span>
      </li>
    </ol>
    <button type="button" class="button cf-secondary open" @click="emit('open', guide.url)">
      Open {{ guide.site }}
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5" />
      </svg>
    </button>
    <label v-if="askAddress" class="cf-field">
      <span class="cf-label">Email address</span>
      <input v-model="email" type="email" autocomplete="email" placeholder="you@example.com" maxlength="320" :aria-invalid="emailError ? 'true' : undefined" />
      <span v-if="emailError" class="cf-error" role="alert">{{ emailError }}</span>
    </label>
    <label class="cf-field">
      <span class="cf-label">App password for {{ address ?? 'this address' }}</span>
      <input
        v-model="password"
        class="mono"
        type="password"
        autocomplete="off"
        data-1p-ignore
        data-lpignore="true"
        spellcheck="false"
        :placeholder="guide.format"
        :aria-invalid="passwordError ? 'true' : undefined"
        :aria-describedby="`${id}-hint`"
      />
      <span v-if="passwordError === 'refused'" :id="`${id}-hint`" class="cf-error" role="alert"
        ><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16.5v.01" /></svg
        >{{ company }} did not accept this password. Check that you copied all of it, or make a new one and paste that.</span
      >
      <span v-else-if="passwordError === 'empty'" :id="`${id}-hint`" class="cf-error" role="alert">Paste the app password you made at {{ company }}.</span>
      <span v-else :id="`${id}-hint`" class="cf-hint">{{ guide.needs }}</span>
    </label>
    <p v-if="formError" class="cf-error" role="alert">{{ formError }}</p>
    <div class="cf-footer">
      <button type="button" class="button button-quiet" @click="emit('back')">Back</button>
      <button type="submit" class="button button-primary" :disabled="busy">Connect</button>
    </div>
  </form>
</template>

<style scoped>
.steps {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.steps li {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  color: var(--ink);
  font-size: 15px;
  line-height: 26px;
}
.number {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 999px;
  background: var(--ground);
  font: 500 12px var(--font-mono);
}
.open {
  align-self: flex-start;
}
.mono {
  font-family: var(--font-mono) !important;
  letter-spacing: 0.04em;
}
</style>
