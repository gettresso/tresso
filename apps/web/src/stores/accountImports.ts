import { ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { ImportFailure, ImportProviderHint, MailAccountImport, NewMailAccountImport, UpdateImportEntry } from '@tresso/core'
import { useAuthStore } from '@/stores/auth'

/**
 * Mail account import lists (/api/v1/mail-account-imports): addresses the user wants to add, made here or by an
 * assistant, which the user connects one by one. Read from the API each time (they are not in the synced copy); only
 * the signed-in user's own lists ever come back, and nothing of them stays once another user signs in.
 */
export const useAccountImportsStore = defineStore('accountImports', () => {
  const auth = useAuthStore()

  /** The user's lists that live, newest first, as last loaded. */
  const lists = ref<MailAccountImport[]>([])
  /** The list the page shows, as last read or changed. */
  const current = ref<MailAccountImport | null>(null)

  async function loadLists(): Promise<MailAccountImport[]> {
    const generation = auth.generation
    const loaded = await auth.api<MailAccountImport[]>('/api/v1/mail-account-imports')
    if (generation === auth.generation) lists.value = loaded
    return loaded
  }

  /** Reads a list; an answer that arrives after another user signed in is dropped. */
  async function load(id: string): Promise<MailAccountImport> {
    const generation = auth.generation
    const list = await auth.api<MailAccountImport>(`/api/v1/mail-account-imports/${encodeURIComponent(id)}`)
    if (generation === auth.generation) current.value = list
    return list
  }

  /** Makes a list of the addresses; the answer names those left out, and why. */
  async function create(addresses: { address: string; provider?: ImportProviderHint }[]): Promise<MailAccountImport> {
    const generation = auth.generation
    const body: NewMailAccountImport = { entries: addresses }
    const list = await auth.send<MailAccountImport>('POST', '/api/v1/mail-account-imports', body)
    if (generation === auth.generation) {
      current.value = list
      lists.value = [list, ...lists.value.filter((other) => other.id !== list.id)]
    }
    return list
  }

  async function mark(id: string, entryId: string, state: UpdateImportEntry['state'], failure?: ImportFailure): Promise<MailAccountImport> {
    const generation = auth.generation
    const body: UpdateImportEntry = { entryId, state }
    if (failure !== undefined) body.failure = failure
    const list = await auth.send<MailAccountImport>('POST', `/api/v1/mail-account-imports/${encodeURIComponent(id)}/entry-states`, body)
    if (generation === auth.generation && current.value?.id === id) current.value = list
    return list
  }

  /** The user checked the addresses of a list an app made and uses them. */
  async function confirm(id: string): Promise<MailAccountImport> {
    const generation = auth.generation
    const list = await auth.send<MailAccountImport>('POST', `/api/v1/mail-account-imports/${encodeURIComponent(id)}/confirmation`, {})
    if (generation === auth.generation && current.value?.id === id) current.value = list
    return list
  }

  async function remove(id: string): Promise<void> {
    await auth.send<void>('DELETE', `/api/v1/mail-account-imports/${encodeURIComponent(id)}`)
    lists.value = lists.value.filter((list) => list.id !== id)
    if (current.value?.id === id) current.value = null
  }

  // The desktop app signs another user in without a reload: nothing of the previous one may show meanwhile.
  watch(
    () => auth.generation,
    () => {
      lists.value = []
      current.value = null
    },
  )

  return { lists, current, loadLists, load, create, mark, confirm, remove }
})
