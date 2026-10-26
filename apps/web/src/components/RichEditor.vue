<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'

const props = defineProps<{ placeholder?: string }>()
const html = defineModel<string>({ required: true })
const emit = defineEmits<{ submit: [] }>()

const editor = useEditor({
  content: html.value,
  extensions: [
    StarterKit.configure({ link: false }),
    Link.configure({ openOnClick: false, autolink: true, protocols: ['mailto'], HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' } }),
    Placeholder.configure({ placeholder: props.placeholder ?? 'Write your message' }),
  ],
  editorProps: {
    attributes: { class: 'prose', 'aria-label': 'Message', role: 'textbox', 'aria-multiline': 'true' },
    handleKeyDown: (_view, event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        emit('submit')
        return true
      }
      return false
    },
  },
  onUpdate: ({ editor: e }) => {
    html.value = e.getHTML()
  },
})

watch(html, (value) => {
  if (editor.value && value !== editor.value.getHTML()) {
    editor.value.commands.setContent(value, { emitUpdate: false })
  }
})

const linking = ref(false)
const linkHref = ref('')
const linkInput = ref<HTMLInputElement | null>(null)
const linkError = ref<string | null>(null)

async function startLink(): Promise<void> {
  linkHref.value = (editor.value?.getAttributes('link').href as string | undefined) ?? ''
  linkError.value = null
  linking.value = true
  await nextTick()
  linkInput.value?.focus()
}

function applyLink(): void {
  const href = linkHref.value.trim()
  if (href === '') {
    editor.value?.chain().focus().extendMarkRange('link').unsetLink().run()
    linking.value = false
    return
  }
  if (!/^(https?:\/\/|mailto:)/i.test(href)) {
    linkError.value = 'Use a web address (https://...) or mailto:.'
    return
  }
  editor.value?.chain().focus().extendMarkRange('link').setLink({ href }).run()
  linking.value = false
}

defineExpose({ focus: () => editor.value?.commands.focus('start') })
onBeforeUnmount(() => editor.value?.destroy())

/** The modifier the toolbar's tips name: ⌘ on a Mac, Ctrl elsewhere. */
const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'
</script>

<template>
  <div class="editor">
    <div v-if="editor" class="toolbar" role="toolbar" aria-label="Formatting">
      <button type="button" :aria-pressed="editor.isActive('bold')" :title="`Bold (${mod}+B)`" @click="editor.chain().focus().toggleBold().run()"><b>B</b></button>
      <button type="button" :aria-pressed="editor.isActive('italic')" :title="`Italic (${mod}+I)`" @click="editor.chain().focus().toggleItalic().run()"><i>I</i></button>
      <button type="button" :aria-pressed="editor.isActive('bulletList')" title="Bulleted list" @click="editor.chain().focus().toggleBulletList().run()">• List</button>
      <button type="button" :aria-pressed="editor.isActive('orderedList')" title="Numbered list" @click="editor.chain().focus().toggleOrderedList().run()">1. List</button>
      <button type="button" :aria-pressed="editor.isActive('blockquote')" title="Quote" @click="editor.chain().focus().toggleBlockquote().run()">Quote</button>
      <button type="button" :aria-pressed="editor.isActive('link')" title="Link" @click="startLink">Link</button>
      <form v-if="linking" class="link" @submit.prevent="applyLink">
        <input ref="linkInput" v-model="linkHref" type="url" placeholder="https://" aria-label="Link address" @keydown.esc.prevent="linking = false" />
        <button type="submit">Apply</button>
        <small v-if="linkError" class="error">{{ linkError }}</small>
      </form>
    </div>
    <EditorContent :editor="editor" class="content" />
  </div>
</template>

<style scoped>
.editor {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  padding: 6px 0;
}
.toolbar button {
  height: 28px;
  padding: 0 8px;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--ink-2);
  font-size: 13px;
  cursor: pointer;
}
.toolbar button[aria-pressed='true'],
.toolbar button:hover {
  background: var(--ground);
  color: var(--ink);
}
.link {
  display: flex;
  align-items: center;
  gap: 4px;
}
.link input {
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-control);
  background: var(--surface);
  color: var(--ink);
  font: inherit;
  font-size: 13px;
}
.link .error {
  color: var(--danger);
  font-size: 12px;
}
.content {
  flex: 1;
  min-height: 160px;
  overflow-y: auto;
}
.content :deep(.prose) {
  min-height: 160px;
  outline: none;
  font-size: 15px;
  line-height: 24px;
}
.content :deep(.prose p) {
  margin: 0 0 8px;
}
.content :deep(.prose blockquote) {
  margin: 8px 0;
  padding-left: 12px;
  border-left: 3px solid var(--line-strong);
  color: var(--ink-2);
}
.content :deep(.prose p.is-editor-empty:first-child::before) {
  content: attr(data-placeholder);
  float: left;
  height: 0;
  color: var(--ink-3);
  pointer-events: none;
}
</style>
