<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import type { SchedulingPreferences, SchedulingPreferencesUpdate } from '@tresso/core'
import { ApiError, errorMessage } from '@/api/errors'
import { calendarSettingsSchema, type CalendarSettingsValues } from '@/forms/calendarSettings'
import { useAuthStore } from '@/stores/auth'
import LogoLoader from '@/components/LogoLoader.vue'

const PATH = '/api/v1/calendar/scheduling-preferences'

const auth = useAuthStore()
const loading = ref(true)
const saving = ref(false)
const error = ref<string | null>(null)
const savedNotice = ref(false)

const { defineField, handleSubmit, errors, meta, resetForm, setErrors } = useForm<CalendarSettingsValues>({
  validationSchema: toTypedSchema(calendarSettingsSchema),
  initialValues: { planTodos: false },
})
const [planTodos] = defineField('planTodos')

onMounted(async () => {
  try {
    const preferences = await auth.api<SchedulingPreferences>(PATH)
    resetForm({ values: { planTodos: preferences.planTodos } })
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    loading.value = false
  }
})

const save = handleSubmit(async (current) => {
  saving.value = true
  error.value = null
  savedNotice.value = false
  try {
    const update: SchedulingPreferencesUpdate = { planTodos: current.planTodos }
    const saved = await auth.send<SchedulingPreferences>('PATCH', PATH, update)
    resetForm({ values: { planTodos: saved.planTodos } })
    savedNotice.value = true
  } catch (e) {
    error.value = errorMessage(e)
    if (e instanceof ApiError) setErrors(e.violations)
  } finally {
    saving.value = false
  }
})
</script>

<template>
  <form class="calendar-settings" aria-labelledby="calendar-settings-title" novalidate @submit.prevent="save">
    <header class="header">
      <h2 id="calendar-settings-title">Calendar</h2>
      <p class="lead">How Tresso uses your calendar for the things you have to do.</p>
    </header>

    <p v-if="loading" class="state" role="status"><LogoLoader /> Loading…</p>

    <template v-else>
      <label class="toggle">
        <input v-model="planTodos" type="checkbox" />
        <span>
          <span class="toggle-label">Plan todos in my calendar</span>
          <span class="hint">
            A todo with a due date and a duration gets free time before it is due, in your working hours and around focus
            blocks and travel time. That time is busy, so nobody books a meeting over it, and it moves when your calendar
            or working hours change. A todo without free time gets some once your calendar frees up. When you remove a
            todo's time, it stays out of your calendar until you change the todo.
          </span>
        </span>
      </label>
      <small v-if="errors.planTodos" class="error">{{ errors.planTodos }}</small>

      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <p v-if="savedNotice && !meta.dirty" class="saved" role="status">
        {{ planTodos ? 'Saved. Your open todos with a due date and a duration are being planned.' : 'Saved. Time already planned stays until you remove it.' }}
      </p>

      <div class="actions">
        <button type="submit" class="button button-primary" :disabled="saving || !meta.dirty"><template v-if="saving"><LogoLoader tone="current" /> Saving…</template><template v-else>Save</template></button>
      </div>
    </template>
  </form>
</template>

<style scoped>
.calendar-settings {
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
.error,
.form-error {
  margin: 0;
  color: var(--danger);
  font-size: 13px;
}
.saved {
  margin: 0;
  color: var(--ink-2);
}
.actions {
  display: flex;
  gap: 8px;
}
</style>
