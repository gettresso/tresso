<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useFieldArray, useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import { MAX_BATCH_TIMES, NO_UNSUBSCRIBE_ON_IMAP, oneClickUnsubscribeAvailable, type BatchSchedule } from '@tresso/core'
import { ApiError, errorMessage } from '@/api/errors'
import FieldLabel from '@/forms/FieldLabel.vue'
import { batchScheduleSchema, browserTimeZone, timeZones, type BatchScheduleValues } from '@/forms/batches'
import { provideRequiredFields } from '@/forms/required'
import { useBatchesStore } from '@/stores/batches'
import { useMailStore } from '@/stores/mail'
import LogoLoader from '@/components/LogoLoader.vue'

provideRequiredFields(batchScheduleSchema)

const batches = useBatchesStore()
const mail = useMailStore()
/** Accounts whose batches offer no Unsubscribe button, named so the missing button is explained. */
const withoutUnsubscribe = computed(() => mail.accounts.filter((account) => !oneClickUnsubscribeAvailable(account)).map((account) => account.displayName || account.emailAddress))
const saving = ref(false)
const error = ref<string | null>(null)
/** The next batch after a save, to confirm it; gone once the form changes again. */
const savedNext = ref<string | null>(null)

const { defineField, handleSubmit, errors, values, meta, resetForm, setErrors } = useForm<BatchScheduleValues>({
  validationSchema: toTypedSchema(batchScheduleSchema),
  initialValues: { times: [], timeZone: browserTimeZone() },
})
const { fields: times, push, remove } = useFieldArray<string>('times')
const [timeZone] = defineField('timeZone')

const fieldErrors = computed(() => errors.value as Record<string, string | undefined>)
/** The browser's zone is offered while the user has not picked one; saving makes it theirs. */
const suggestingZone = computed(() => batches.schedule !== null && !batches.schedule.configured)
// Every zone this browser knows, and the chosen one when it does not list it (some leave out "UTC").
const known = timeZones()
const zones = computed(() => {
  const chosen = values.timeZone

  return chosen && !known.includes(chosen) ? [chosen, ...known] : known
})

function fromSchedule(schedule: BatchSchedule): BatchScheduleValues {
  return { times: [...schedule.times], timeZone: schedule.configured ? schedule.timeZone : browserTimeZone() }
}

// Fills the form once the schedule is known, and follows it while the form has no changes of its own.
watch(
  () => batches.schedule,
  (schedule) => {
    if (schedule !== null && !saving.value && !meta.value.dirty) {
      resetForm({ values: fromSchedule(schedule) })
    }
  },
  { immediate: true },
)
watch(
  () => meta.value.dirty,
  (dirty) => {
    if (dirty) {
      savedNext.value = null
    }
  },
)
onMounted(() => void batches.reload())

/** A whole hour that is not a batch time yet, to start a new one from. */
function freeTime(): string {
  const taken = new Set(values.times ?? [])
  for (let hour = 8; hour < 32; hour++) {
    const time = `${String(hour % 24).padStart(2, '0')}:00`
    if (!taken.has(time)) {
      return time
    }
  }

  return ''
}

const save = handleSubmit(async (current) => {
  saving.value = true
  error.value = null
  try {
    // "HH:MM" sorts as the day goes.
    const saved = await batches.save({ times: [...current.times].sort(), timeZone: current.timeZone })
    resetForm({ values: fromSchedule(saved) })
    savedNext.value = batches.nextBatchLabel
  } catch (e) {
    error.value = errorMessage(e)
    if (e instanceof ApiError) setErrors(e.violations)
  } finally {
    saving.value = false
  }
})
</script>

<template>
  <form class="batches" aria-labelledby="batches-title" novalidate @submit.prevent="save">
    <header>
      <h2 id="batches-title">Batched delivery</h2>
      <p class="intro">
        Smart inboxes set to deliver in batches hold their new mail until the next batch time, so it arrives a few times a day instead of all
        day long. Turn it on per smart inbox.
      </p>
    </header>

    <p v-if="withoutUnsubscribe.length > 0" class="note" role="note">
      {{ NO_UNSUBSCRIBE_ON_IMAP }} This applies to {{ withoutUnsubscribe.join(', ') }}.
    </p>

    <p v-if="batches.schedule === null && batches.error" class="form-error" role="alert">
      {{ batches.error }} <button type="button" class="button button-quiet" @click="batches.reload()">Try again</button>
    </p>
    <p v-else-if="batches.schedule === null" class="state" role="status"><LogoLoader /> Loading…</p>

    <template v-else>
      <fieldset class="times">
        <FieldLabel name="times" tag="legend">Batch times</FieldLabel>
        <ul class="time-list">
          <li v-for="(field, index) in times" :key="field.key" class="time">
            <input
              v-model="field.value"
              type="time"
              class="time-input"
              :aria-label="`Batch time ${index + 1}`"
              :aria-invalid="fieldErrors[`times[${index}]`] ? 'true' : undefined"
              :aria-describedby="fieldErrors[`times[${index}]`] ? `batch-time-error-${index}` : undefined"
            />
            <button type="button" class="button button-quiet" :aria-label="`Remove batch time ${index + 1}`" @click="remove(index)">
              Remove
            </button>
            <small v-if="fieldErrors[`times[${index}]`]" :id="`batch-time-error-${index}`" class="error">{{ fieldErrors[`times[${index}]`] }}</small>
          </li>
        </ul>
        <small v-if="fieldErrors.times" class="error">{{ fieldErrors.times }}</small>
        <div>
          <button type="button" class="button button-quiet" :disabled="times.length >= MAX_BATCH_TIMES" @click="push(freeTime())">+ Add a batch time</button>
        </div>
        <small class="hint">Up to {{ MAX_BATCH_TIMES }} a day.</small>
      </fieldset>

      <div class="field zone">
        <FieldLabel name="timeZone" tag="label" for="batch-time-zone">Time zone</FieldLabel>
        <select id="batch-time-zone" v-model="timeZone" :aria-invalid="errors.timeZone ? 'true' : undefined" aria-describedby="batch-time-zone-hint">
          <option v-for="zone in zones" :key="zone" :value="zone">{{ zone }}</option>
        </select>
        <small id="batch-time-zone-hint" class="hint">
          {{ suggestingZone ? 'This is the time zone of this device. Save to use it for your batches.' : 'Batch times are in this time zone.' }}
        </small>
        <small v-if="errors.timeZone" class="error">{{ errors.timeZone }}</small>
      </div>

      <p v-if="error" class="form-error" role="alert">{{ error }}</p>

      <div class="actions">
        <button type="submit" class="button button-primary" :disabled="saving">Save</button>
        <p v-if="savedNext" class="saved" role="status">Saved. Next batch at {{ savedNext }}.</p>
        <p v-else-if="batches.nextBatchLabel" class="next">Next batch at {{ batches.nextBatchLabel }}</p>
      </div>
    </template>
  </form>
</template>

<style scoped>
.note {
  margin: 0;
  color: var(--ink-2);
  font-size: 13px;
}
.batches {
  display: flex;
  flex-direction: column;
  gap: 20px;
  max-width: 640px;
}
h2 {
  margin: 0 0 4px;
  font-size: 20px;
  line-height: 28px;
}
.intro,
.state,
.next {
  margin: 0;
  color: var(--ink-2);
}
.times {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  border: 0;
}
.times legend {
  margin-bottom: 6px;
  font-size: 13px;
  font-weight: 600;
}
.time-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.time {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
}
.time-input {
  height: 40px;
  padding: 0 12px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-control);
  background: var(--surface);
  color: var(--ink);
  font: 400 14px var(--font-ui);
}
.time-input[aria-invalid='true'],
.zone select[aria-invalid='true'] {
  border-color: var(--danger);
}
.time .error {
  flex-basis: 100%;
}
.error {
  font-size: 12px;
  font-weight: 500;
  color: var(--danger);
}
.hint {
  font-size: 12px;
  color: var(--ink-2);
}
.zone {
  max-width: 360px;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
}
.saved {
  margin: 0;
  font-weight: 600;
  color: var(--know);
}
</style>
