import { ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { SearchHit, SearchResults } from '@tresso/core'
import { ApiError, errorMessage } from '@/api/errors'
import { useAuthStore } from '@/stores/auth'

const PER_PAGE = 20

/**
 * Mail search through the API (the local copy has no bodies to search). Results of later pages are appended, so "show
 * more" keeps what is on screen.
 */
export const useSearchStore = defineStore('search', () => {
  const auth = useAuthStore()

  const query = ref('')
  const hits = ref<SearchHit[]>([])
  const totalHits = ref(0)
  const page = ref(0)
  const totalPages = ref(0)
  const loading = ref(false)
  const error = ref<string | null>(null)
  let request = 0

  async function run(next: string): Promise<void> {
    query.value = next.trim()
    hits.value = []
    totalHits.value = 0
    page.value = 0
    totalPages.value = 0
    error.value = null
    if (query.value === '') {
      return
    }
    await load(1)
  }

  async function more(): Promise<void> {
    if (loading.value || page.value >= totalPages.value) {
      return
    }
    await load(page.value + 1)
  }

  async function load(pageNumber: number): Promise<void> {
    const current = ++request
    loading.value = true
    try {
      const params = new URLSearchParams({
        q: query.value,
        page: String(pageNumber),
        perPage: String(PER_PAGE),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      })
      const results = await auth.api<SearchResults>(`/api/v1/search?${params}`)
      // A newer search replaced this one while it ran.
      if (current !== request) {
        return
      }
      hits.value = pageNumber === 1 ? results.messages : [...hits.value, ...results.messages]
      totalHits.value = results.totalHits
      totalPages.value = results.totalPages
      page.value = results.page
    } catch (e) {
      if (current === request) {
        error.value = e instanceof ApiError ? (e.violations.q ?? e.message) : errorMessage(e)
      }
    } finally {
      if (current === request) {
        loading.value = false
      }
    }
  }

  // The desktop app signs another user in without a reload: nothing of the previous one may show meanwhile. A search
  // still under way is dropped with it.
  watch(
    () => auth.generation,
    () => {
      request++
      query.value = ''
      hits.value = []
      totalHits.value = 0
      page.value = 0
      totalPages.value = 0
      loading.value = false
      error.value = null
    },
  )

  return { query, hits, totalHits, page, totalPages, loading, error, run, more }
})
