<script setup lang="ts">
import { ref, useId, watch } from 'vue'
import { isPlausibleAddress, parseAddresses, type Address } from '@tresso/core'
import type { Contact } from '@/mail/db'
import { useMailStore } from '@/stores/mail'

const props = defineProps<{ label: string; error?: string }>()
const recipients = defineModel<Address[]>({ required: true })

const mail = useMailStore()
const id = useId()
const text = ref('')
const suggestions = ref<Contact[]>([])
const active = ref(0)
const open = ref(false)

watch(text, async (value) => {
  if (value.trim() === '') {
    suggestions.value = []
    open.value = false
    return
  }
  const taken = new Set(recipients.value.map((r) => r.address.toLowerCase()))
  suggestions.value = (await mail.suggestContacts(value)).filter((contact) => !taken.has(contact.key))
  active.value = 0
  open.value = suggestions.value.length > 0
})

function add(addresses: Address[]): void {
  const taken = new Set(recipients.value.map((r) => r.address.toLowerCase()))
  const fresh = addresses.filter((a) => a.address.trim() !== '' && !taken.has(a.address.trim().toLowerCase()))
  if (fresh.length > 0) {
    recipients.value = [...recipients.value, ...fresh.map((a) => ({ address: a.address.trim(), name: a.name }))]
  }
  text.value = ''
  open.value = false
}

function commit(): void {
  if (open.value && suggestions.value[active.value]) {
    const contact = suggestions.value[active.value]!
    add([{ address: contact.address, name: contact.name }])
    return
  }
  if (text.value.trim() !== '') add(parseAddresses(text.value))
}

function remove(index: number): void {
  recipients.value = recipients.value.filter((_, i) => i !== index)
}

function keydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown' && open.value) {
    active.value = (active.value + 1) % suggestions.value.length
    event.preventDefault()
  } else if (event.key === 'ArrowUp' && open.value) {
    active.value = (active.value - 1 + suggestions.value.length) % suggestions.value.length
    event.preventDefault()
  } else if (event.key === 'Enter' || event.key === 'Tab' || event.key === ',' || event.key === ';') {
    if (text.value.trim() === '') return
    event.preventDefault()
    commit()
  } else if (event.key === 'Backspace' && text.value === '' && recipients.value.length > 0) {
    remove(recipients.value.length - 1)
  } else if (event.key === 'Escape') {
    open.value = false
  }
}

function paste(event: ClipboardEvent): void {
  const pasted = event.clipboardData?.getData('text') ?? ''
  if (/[,;\n]/.test(pasted)) {
    event.preventDefault()
    add(parseAddresses(pasted))
  }
}
</script>

<template>
  <div class="field-row" :class="{ invalid: props.error }">
    <label :for="id" class="label">{{ label }}</label>
    <div class="chips">
      <span v-for="(recipient, index) in recipients" :key="recipient.address" class="chip" :class="{ wrong: !isPlausibleAddress(recipient.address) }">
        <span :title="recipient.address">{{ recipient.name || recipient.address }}</span>
        <button type="button" class="remove" :aria-label="`Remove ${recipient.address}`" @click="remove(index)">×</button>
      </span>
      <div class="combo">
        <input
          :id="id"
          v-model="text"
          type="text"
          autocomplete="off"
          spellcheck="false"
          role="combobox"
          :aria-expanded="open"
          :aria-controls="`${id}-list`"
          :aria-activedescendant="open ? `${id}-option-${active}` : undefined"
          @keydown="keydown"
          @paste="paste"
          @blur="commit"
        />
        <ul v-if="open" :id="`${id}-list`" class="suggestions" role="listbox">
          <li
            v-for="(contact, index) in suggestions"
            :id="`${id}-option-${index}`"
            :key="contact.key"
            role="option"
            :aria-selected="index === active"
            @mousedown.prevent="add([{ address: contact.address, name: contact.name }])"
          >
            <span class="name">{{ contact.name || contact.address }}</span>
            <span v-if="contact.name" class="address">{{ contact.address }}</span>
          </li>
        </ul>
      </div>
    </div>
    <small v-if="props.error" class="error">{{ props.error }}</small>
  </div>
</template>

<style scoped>
.field-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  padding: 6px 0;
  border-bottom: 1px solid var(--line);
}
.label {
  width: 52px;
  color: var(--ink-2);
  font-size: 13px;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  padding: 2px 4px 2px 10px;
  border-radius: 999px;
  background: var(--ground);
  font-size: 13px;
}
.chip.wrong {
  background: var(--danger-soft);
  color: var(--danger);
}
.remove {
  border: 0;
  background: transparent;
  color: var(--ink-3);
  cursor: pointer;
  font-size: 15px;
  line-height: 1;
  padding: 0 4px;
}
.combo {
  position: relative;
  flex: 1;
  min-width: 140px;
}
.combo input {
  width: 100%;
  height: 30px;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--ink);
  font: inherit;
}
.suggestions {
  transform-origin: top left;
  animation: pop-in var(--motion-fast) var(--ease-out);
  position: absolute;
  z-index: 10;
  top: 100%;
  left: 0;
  min-width: 260px;
  margin: 4px 0 0;
  padding: 4px;
  list-style: none;
  border-radius: var(--radius-card);
  background: var(--surface);
  box-shadow: var(--raised);
}
.suggestions li {
  display: flex;
  flex-direction: column;
  padding: 6px 10px;
  border-radius: var(--radius-control);
  cursor: pointer;
}
.suggestions li[aria-selected='true'] {
  background: var(--selected);
}
.name {
  font-weight: 500;
}
.address {
  font-size: 12px;
  color: var(--ink-2);
}
.invalid .label,
.error {
  color: var(--danger);
}
.error {
  width: 100%;
  padding-left: 62px;
  font-size: 12px;
}
</style>
