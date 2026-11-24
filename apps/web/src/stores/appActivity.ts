import { ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { appActivityPath, type AppActivityApp, type AppActivityEntry, type AppActivityPage, type AppActivityQuery } from '@tresso/core'
import { useAuthStore } from '@/stores/auth'

/** The filters of the activity log page; what is left out is every one. */
export type AppActivityFilters = Omit<AppActivityQuery, 'cursor' | 'limit'>

/**
 * The activity log of apps and AI assistants (GET /api/v1/app-activity), read a page at a time with the filters of the
 * page. Not part of the synced copy. An answer that comes after the filters changed, or after another user signed in
 * (desktop), is dropped.
 */
export const useAppActivityStore = defineStore('appActivity', () => {
  const auth = useAuthStore()

  const entries = ref<AppActivityEntry[]>([])
  const apps = ref<AppActivityApp[]>([])
  const nextCursor = ref<string | null>(null)
  /** The log holds nothing at all, whatever the filters (from the last page read). */
  const empty = ref(false)
  let asked = 0

  /** The first page for these filters, in place of what was shown. */
  async function load(filters: AppActivityFilters): Promise<void> {
    const ticket = ++asked
    const generation = auth.generation
    const page = await auth.api<AppActivityPage>(appActivityPath(filters))
    if (ticket !== asked || generation !== auth.generation) return
    entries.value = page.items
    apps.value = page.apps
    nextCursor.value = page.nextCursor
    empty.value = page.empty
  }

  /** The next page for the same filters, after what is shown. */
  async function more(filters: AppActivityFilters): Promise<void> {
    if (nextCursor.value === null) return
    const ticket = ++asked
    const generation = auth.generation
    const page = await auth.api<AppActivityPage>(appActivityPath({ ...filters, cursor: nextCursor.value }))
    if (ticket !== asked || generation !== auth.generation) return
    entries.value = [...entries.value, ...page.items]
    apps.value = page.apps
    nextCursor.value = page.nextCursor
  }

  /** The newest entries of one app, for its recent activity; kept apart from the log page. */
  async function recent(app: string, limit = 6): Promise<AppActivityEntry[]> {
    return (await auth.api<AppActivityPage>(appActivityPath({ app, limit }))).items
  }

  /**
   * When each app was last active, by its key, from the newest entries of the log. An app without an entry among them
   * is not in the answer.
   */
  async function lastActive(): Promise<Record<string, string>> {
    const page = await auth.api<AppActivityPage>(appActivityPath({ limit: 100 }))
    const last: Record<string, string> = {}
    for (const entry of page.items) {
      last[entry.app.key] ??= entry.occurredAt
    }
    return last
  }

  // The desktop app signs another user in without a reload: nothing of the previous one may show meanwhile.
  watch(
    () => auth.generation,
    () => {
      asked++
      entries.value = []
      apps.value = []
      nextCursor.value = null
      empty.value = false
    },
  )

  return { entries, apps, nextCursor, empty, load, more, recent, lastActive }
})
