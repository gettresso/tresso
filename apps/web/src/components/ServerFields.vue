<script setup lang="ts">
import FieldLabel from '@/forms/FieldLabel.vue'
import { useId } from 'vue'
import { defaultPort, type ConnectionSecurity, type ServerSettings } from '@tresso/core'

const props = defineProps<{
  protocol: 'imap' | 'smtp'
  title: string
  /** Validation messages by field: host, port, security. */
  errors?: Record<string, string>
  /**
   * Whether this server accepts unencrypted connections (MAIL_ALLOW_UNSAFE_SERVERS, local test servers only). Without
   * it "None" is offered only for a server that has it already, so its settings still show what they are.
   */
  allowUnencrypted?: boolean
  /** A short word next to the title about how checking this server went, such as "No answer". */
  status?: { label: string; tone: 'danger' | 'neutral' } | null
  /** Marks the server and port as the part that failed. */
  failed?: boolean
}>()
const settings = defineModel<ServerSettings>({ required: true })
const id = useId()

function setSecurity(security: ConnectionSecurity): void {
  const usual = [defaultPort(props.protocol, 'tls'), defaultPort(props.protocol, 'starttls')]
  // Follow the port along when it still is one of the usual ones.
  const port = usual.includes(settings.value.port) ? defaultPort(props.protocol, security) : settings.value.port
  settings.value = { ...settings.value, security, port }
}
</script>

<template>
  <fieldset class="server">
    <legend>
      <span>{{ title }} ({{ protocol.toUpperCase() }})</span>
      <span v-if="status" class="status" :class="status.tone">{{ status.label }}</span>
    </legend>
    <div class="row">
      <label class="field host">
        <FieldLabel :name="`${protocol}.host`">Server</FieldLabel>
        <input
          :id="`${id}-host`"
          class="mono"
          :value="settings.host"
          autocomplete="off"
          spellcheck="false"
          required
          :aria-invalid="errors?.host || failed ? 'true' : undefined"
          :aria-describedby="errors?.host ? `${id}-host-error` : undefined"
          @input="settings = { ...settings, host: ($event.target as HTMLInputElement).value.trim() }"
        />
        <small v-if="errors?.host" :id="`${id}-host-error`" class="error" role="alert">{{ errors.host }}</small>
      </label>
      <label class="field port">
        <FieldLabel :name="`${protocol}.port`">Port</FieldLabel>
        <input
          class="mono"
          :value="settings.port"
          type="number"
          min="1"
          max="65535"
          required
          :aria-invalid="errors?.port || failed ? 'true' : undefined"
          @input="settings = { ...settings, port: Number(($event.target as HTMLInputElement).value) }"
        />
        <small v-if="errors?.port" class="error" role="alert">{{ errors.port }}</small>
      </label>
      <label class="field security">
        <FieldLabel :name="`${protocol}.security`">Security</FieldLabel>
        <select :value="settings.security" @change="setSecurity(($event.target as HTMLSelectElement).value as ConnectionSecurity)">
          <option value="tls">SSL/TLS</option>
          <option value="starttls">STARTTLS</option>
          <option v-if="allowUnencrypted || settings.security === 'none'" value="none">None (not recommended)</option>
        </select>
        <small v-if="errors?.security" class="error" role="alert">{{ errors.security }}</small>
      </label>
    </div>
  </fieldset>
</template>

<style scoped>
.server {
  margin: 0;
  padding: 0;
  border: 0;
  min-width: 0;
}
legend {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 0 0 8px;
  font-weight: 600;
}
.status {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
}
.status.danger {
  background: var(--danger-soft);
  color: var(--danger);
}
.status.neutral {
  background: var(--ground);
  color: var(--ink-2);
}
.mono {
  font-family: var(--font-mono) !important;
}
.row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 96px 168px;
  gap: 12px;
}
@media (max-width: 600px) {
  .row {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }
  .host {
    grid-column: 1 / -1;
  }
}
</style>
