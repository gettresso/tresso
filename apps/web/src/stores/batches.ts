import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { batchTimeLabel, type BatchSchedule, type BatchScheduleRequest } from '@tresso/core'
import { errorMessage } from '@/api/errors'
import { useAuthStore } from '@/stores/auth'

/** Once the next batch went out, the schedule is asked for again a little later, so it names the one after. */
const AFTER_BATCH_MS = 5_000
/** A reload that failed is tried again after this, doubling per failure in a row up to the cap. */
const RETRY_FIRST_MS = 30_000
const RETRY_CAP_MS = 600_000

/**
 * When the user's batches go out (GET and PUT /api/v1/batch-delivery). Screens that show the next batch time load it
 * once; it is loaded again when that time has passed.
 */
export const useBatchesStore = defineStore('batches', () => {
  const auth = useAuthStore()

  const schedule = ref<BatchSchedule | null>(null)
  const error = ref<string | null>(null)
  let loading: Promise<void> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  /** Reloads that failed in a row, for the wait before the next try. */
  let failures = 0

  /** The next batch in the reader's words, e.g. "13:00" or "Wed 09:00"; null until the schedule is known. */
  const nextBatchLabel = computed(() => (schedule.value === null ? null : batchTimeLabel(Date.parse(schedule.value.nextBatchAt))))

  /** The batch times in words, e.g. "09:00, 13:00 and 16:00"; null until the schedule is known. */
  const timesLabel = computed(() => {
    const times = schedule.value?.times ?? []
    if (times.length <= 1) {
      return times[0] ?? null
    }

    return `${times.slice(0, -1).join(', ')} and ${times[times.length - 1]}`
  })

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function take(next: BatchSchedule): void {
    schedule.value = next
    error.value = null
    failures = 0
    clearTimer()
    const wait = Date.parse(next.nextBatchAt) - Date.now() + AFTER_BATCH_MS
    timer = Number.isFinite(wait) ? setTimeout(() => void reload(), Math.max(wait, AFTER_BATCH_MS)) : null
  }

  /**
   * Asks for the schedule again; a failure is kept in `error`, not thrown. While a schedule is known (and so on
   * screen), a failed reload is tried again after a growing wait, so the next batch time does not stay in the past.
   */
  async function reload(): Promise<void> {
    try {
      take(await auth.api<BatchSchedule>('/api/v1/batch-delivery'))
    } catch (e) {
      error.value = errorMessage(e)
      if (schedule.value !== null && auth.isAuthenticated) {
        clearTimer()
        timer = setTimeout(() => void reload(), Math.min(RETRY_FIRST_MS * 2 ** failures, RETRY_CAP_MS))
        failures += 1
      }
    }
  }

  /** Whether the schedule names a batch that went out a while ago, so it no longer says when the next one comes. */
  function outdated(known: BatchSchedule): boolean {
    return Date.parse(known.nextBatchAt) + AFTER_BATCH_MS < Date.now()
  }

  /**
   * Loads the schedule unless it is known and current (or on its way); a failure is kept in `error`, not thrown.
   * Screens call it on every navigation, which also retries a load or reload that failed.
   */
  function load(): Promise<void> {
    if (schedule.value !== null && !outdated(schedule.value)) {
      return Promise.resolve()
    }
    loading ??= reload().finally(() => {
      loading = null
    })

    return loading
  }

  /** Stores new batch times; throws what the server refused (with its violations). */
  async function save(request: BatchScheduleRequest): Promise<BatchSchedule> {
    const saved = await auth.send<BatchSchedule>('PUT', '/api/v1/batch-delivery', request)
    take(saved)

    return saved
  }

  function clear(): void {
    clearTimer()
    failures = 0
    schedule.value = null
    error.value = null
  }

  watch(
    () => auth.isAuthenticated,
    (authenticated) => {
      if (!authenticated) {
        clear()
      }
    },
  )

  return { schedule, error, nextBatchLabel, timesLabel, load, reload, save, clear }
})
