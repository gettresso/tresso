<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import type { DailyBriefSettings, NotificationChannel } from '@tresso/core'
import { ApiError, errorMessage } from '@/api/errors'
import FieldLabel from '@/forms/FieldLabel.vue'
import { briefSettingsSchema, type BriefSettingsValues } from '@/forms/brief'
import { provideRequiredFields } from '@/forms/required'
import { useBriefStore } from '@/stores/brief'
import LogoLoader from '@/components/LogoLoader.vue'

provideRequiredFields(briefSettingsSchema)

const store = useBriefStore()
const loading = ref(true)
const saving = ref(false)
const error = ref<string | null>(null)
const savedNotice = ref(false)

const CHANNELS: { value: NotificationChannel; label: string; hint: string }[] = [
  { value: 'phone', label: 'Phone', hint: 'A push to the Tresso app on your phone.' },
  { value: 'desktop', label: 'Desktop and browser', hint: 'A notification on the computers where you allowed them.' },
  { value: 'email', label: 'Email digest', hint: 'The brief by email, per smart inbox. Noting happens in the app.' },
]

const { defineField, handleSubmit, errors, meta, resetForm, setErrors } = useForm<BriefSettingsValues>({
  validationSchema: toTypedSchema(briefSettingsSchema),
  initialValues: { enabled: true, deliverAt: '08:00', channels: [] },
})
const [enabled] = defineField('enabled')
const [deliverAt] = defineField('deliverAt')
const [channels] = defineField('channels')

const zone = computed(() => store.settings?.timeZone.split('_').join(' ') ?? '')
const next = computed(() => {
  const at = store.settings?.nextBriefAt
  if (at === null || at === undefined) {
    return null
  }
  return new Date(at).toLocaleString(undefined, { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
})

function formValues(settings: DailyBriefSettings): BriefSettingsValues {
  return { enabled: settings.enabled, deliverAt: settings.deliverAt, channels: [...settings.channels] }
}

onMounted(async () => {
  try {
    resetForm({ values: formValues(await store.load()) })
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    loading.value = false
  }
})

/** The API reports a refused channel as channels[0]; the form shows it for the whole group. */
function fieldErrors(violations: Record<string, string>): Partial<Record<keyof BriefSettingsValues, string>> {
  const mapped: Partial<Record<keyof BriefSettingsValues, string>> = {}
  for (const [path, message] of Object.entries(violations)) {
    if (path.startsWith('channels')) mapped.channels = message
    else if (path === 'enabled' || path === 'deliverAt') mapped[path] = message
  }
  return mapped
}

const save = handleSubmit(async (current) => {
  saving.value = true
  error.value = null
  savedNotice.value = false
  try {
    resetForm({ values: formValues(await store.save({ enabled: current.enabled, deliverAt: current.deliverAt, channels: current.channels })) })
    savedNotice.value = true
  } catch (e) {
    error.value = errorMessage(e)
    if (e instanceof ApiError) setErrors(fieldErrors(e.violations))
  } finally {
    saving.value = false
  }
})
</script>

<template>
  <form class="brief-settings" aria-labelledby="brief-settings-title" novalidate @submit.prevent="save">
    <header class="header">
      <h2 id="brief-settings-title">Daily brief</h2>
      <p class="lead">
        Once a day, the mail that is good to know but asks nothing of you comes together in one brief: per smart inbox, with
        subject and preview. Note it with one click, and it is read and archived.
      </p>
    </header>

    <p v-if="loading" class="state" role="status"><LogoLoader /> Loading…</p>

    <template v-else>
      <label class="toggle">
        <input v-model="enabled" type="checkbox" />
        <span>
          <span class="toggle-label">Make a daily brief</span>
          <span class="hint">Without it, mail to know stays in its smart inbox until you get to it.</span>
        </span>
      </label>

      <fieldset class="when" :disabled="!enabled">
        <legend class="visually-hidden">When the brief comes</legend>
        <label class="field">
          <FieldLabel name="deliverAt">Time</FieldLabel>
          <input v-model="deliverAt" type="time" step="60" :aria-invalid="errors.deliverAt ? 'true' : undefined" aria-describedby="brief-zone" />
          <small v-if="errors.deliverAt" class="error">{{ errors.deliverAt }}</small>
        </label>
        <p id="brief-zone" class="hint zone">In your time zone, {{ zone }}. Your devices keep it current.</p>
      </fieldset>

      <fieldset class="channels" :disabled="!enabled">
        <legend class="legend">Also send it to</legend>
        <p class="hint">Tresso always shows the brief in the app, under Daily brief.</p>
        <label v-for="channel in CHANNELS" :key="channel.value" class="toggle">
          <input v-model="channels" type="checkbox" :value="channel.value" />
          <span>
            <span class="toggle-label">{{ channel.label }}</span>
            <span class="hint">{{ channel.hint }}</span>
            <span v-if="channel.value === 'email' && store.settings" class="hint">Goes to {{ store.settings.emailAddress }}, the address your notifications go to.</span>
          </span>
        </label>
        <small v-if="errors.channels" class="error">{{ errors.channels }}</small>
      </fieldset>

      <p v-if="enabled && next && !meta.dirty" class="hint" role="status">The next brief comes {{ next }}.</p>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <p v-if="savedNotice && !meta.dirty" class="saved" role="status">Saved.</p>

      <div class="actions">
        <button type="submit" class="button button-primary" :disabled="saving || !meta.dirty"><template v-if="saving"><LogoLoader tone="current" /> Saving…</template><template v-else>Save</template></button>
      </div>
    </template>
  </form>
</template>

<style scoped>
.brief-settings {
  display: flex;
  flex-direction: column;
  gap: 20px;
  max-width: 640px;
}
.header h2 {
  margin: 0 0 6px;
  font: 700 22px/28px var(--font-display);
}
.lead,
.state {
  margin: 0;
  color: var(--ink-2);
  line-height: 21px;
}
.toggle {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  cursor: pointer;
}
.toggle input {
  width: 18px;
  height: 18px;
  margin: 2px 0 0;
}
.toggle > span {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.toggle-label {
  font-weight: 600;
}
.hint {
  margin: 0;
  font-size: 13px;
  color: var(--ink-2);
}
.when {
  display: grid;
  grid-template-columns: minmax(120px, 160px) minmax(0, 1fr);
  align-items: end;
  gap: 16px;
  margin: 0;
  padding: 0;
  border: 0;
}
.channels {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 0;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
}
.legend {
  padding: 0 4px;
  font-weight: 600;
}
fieldset:disabled {
  opacity: 0.55;
}
.zone {
  padding-bottom: 10px;
}
.saved {
  margin: 0;
  color: var(--know);
  font-weight: 600;
}
.actions {
  display: flex;
  gap: 8px;
}
@media (max-width: 520px) {
  .when {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
