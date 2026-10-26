<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import { searchFilters } from '@tresso/core'
import { searchSchema, type SearchValues } from '@/forms/search'
import AppIcon from '@/components/AppIcon.vue'
import KeyShortcut from '@/components/KeyShortcut.vue'

const props = withDefaults(defineProps<{ query?: string; autofocus?: boolean }>(), { query: '', autofocus: false })

const router = useRouter()
const { defineField, handleSubmit, errors, resetForm, setFieldValue } = useForm<SearchValues>({
  validationSchema: toTypedSchema(searchSchema),
  initialValues: { q: props.query },
})
const [q] = defineField('q')
const input = ref<HTMLInputElement | null>(null)
const value = computed(() => q.value ?? '')
const filters = computed(() => searchFilters(value.value))

watch(
  () => props.query,
  (query) => resetForm({ values: { q: query } }),
)

// An empty search does nothing; the schema keeps it from submitting.
const submit = handleSubmit((values) => void router.push({ name: 'search', query: { q: values.q } }))

function clear(): void {
  setFieldValue('q', '', false)
  input.value?.focus()
}

function escape(): void {
  if (value.value !== '') {
    setFieldValue('q', '', false)
    return
  }
  input.value?.blur()
}

// "/" jumps to search, unless the user is typing somewhere.
function shortcut(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null
  const typing = target !== null && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  if (!typing && event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault()
    input.value?.focus()
    input.value?.select()
  }
}

onMounted(() => {
  window.addEventListener('keydown', shortcut)
  if (props.autofocus) {
    input.value?.focus()
  }
})
onBeforeUnmount(() => window.removeEventListener('keydown', shortcut))
</script>

<template>
  <form class="search" role="search" novalidate @submit.prevent="submit">
    <AppIcon name="search" :size="18" />
    <label for="mail-search" class="visually-hidden">Search mail</label>
    <input
      id="mail-search"
      ref="input"
      v-model="q"
      :aria-invalid="value !== '' && errors.q ? 'true' : undefined"
      :aria-describedby="value !== '' && errors.q ? 'mail-search-error' : undefined"
      type="search"
      placeholder="Search mail"
      autocomplete="off"
      enterkeyhint="search"
      aria-keyshortcuts="/"
      @keydown.esc.prevent="escape"
    />
    <span v-for="filter in filters" :key="filter.raw" class="filter">{{ filter.raw }}</span>
    <button v-if="value !== ''" type="button" class="clear" aria-label="Clear search" @click="clear">
      <AppIcon name="close" :size="16" />
    </button>
    <KeyShortcut v-else class="key" aria-hidden="true" keys="/" />
    <span v-if="value !== '' && errors.q" id="mail-search-error" class="visually-hidden" role="alert">{{ errors.q }}</span>
  </form>
</template>

<style scoped>
.search {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 44px;
  padding: 0 6px 0 12px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-control);
  background: var(--surface);
  color: var(--ink-2);
}
.search:has(input[aria-invalid='true']) {
  border-color: var(--danger);
}
.search:focus-within {
  border: 2px solid var(--focus);
  padding: 0 5px 0 11px;
}
input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--ink);
  font: 400 15px var(--font-ui);
}
input::-webkit-search-cancel-button {
  display: none;
}
.filter,
.key {
  flex-shrink: 0;
  color: var(--ink-2);
}
.filter {
  max-width: 30%;
  overflow: hidden;
  text-overflow: ellipsis;
}
.clear {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--ink-2);
  cursor: pointer;
}
.clear:hover {
  background: var(--ground);
}
@media (max-width: 520px) {
  .filter {
    display: none;
  }
}
</style>
