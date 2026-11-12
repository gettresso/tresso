// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { compileStyle, parse } from 'vue/compiler-sfc'

/**
 * Vue's scoped styles take `:global(A) B` and `B :global(A)` as plain `A`: everything around `:global(...)` is dropped,
 * so a rule meant for one element lands on the whole document (once it hid the whole desktop app). These tests compile
 * the real style blocks the way the build does.
 */
const src = fileURLToPath(new URL('..', import.meta.url))

function vueFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name)
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' ? [] : vueFiles(path)
    }
    return entry.name.endsWith('.vue') ? [path] : []
  })
}

/** The selectors of a style's rules, each split on its top-level commas (`:is(a, b)` stays whole). */
function selectors(css: string): string[] {
  const heads = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{};]+)\{/g)].map((match) => match[1]!.trim())
  return heads
    .filter((head) => !head.startsWith('@'))
    .flatMap((head) => {
      const parts: string[] = []
      let depth = 0
      let start = 0
      for (let at = 0; at < head.length; at += 1) {
        depth += head[at] === '(' ? 1 : head[at] === ')' ? -1 : 0
        if (head[at] === ',' && depth === 0) {
          parts.push(head.slice(start, at).trim())
          start = at + 1
        }
      }
      return [...parts, head.slice(start).trim()]
    })
}

/**
 * A scoped selector Vue compiles as written: one with `:global(...)` (or `::v-global(...)`) must be nothing but that one
 * global, as Vue drops everything before and after it.
 */
function keptWhole(selector: string): boolean {
  if (!/:global\(|::v-global\(/.test(selector)) {
    return true
  }
  return /^(?::global|::v-global)\((?:[^()]|\([^()]*\))*\)$/.test(selector)
}

function compiled(file: string): { code: string; errors: string[] } {
  const { descriptor } = parse(readFileSync(file, 'utf8'), { filename: file })
  const results = descriptor.styles.map((style) => compileStyle({ source: style.content, filename: file, id: 'data-v-test', scoped: style.scoped }))
  return { code: results.map((result) => result.code).join('\n'), errors: results.flatMap((result) => result.errors.map((error) => `${file}: ${error.message}`)) }
}

/** The compiled rules as selector and declarations (rules inside @media included). */
function rules(css: string): { selector: string; body: string }[] {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap((match) =>
    match[1]!
      .split(',')
      .map((selector) => ({ selector: selector.trim(), body: match[2]! })),
  )
}

describe('scoped styles', () => {
  it('tell a whole global from one Vue would cut', () => {
    expect(keptWhole('.frame-shell .title')).toBe(true)
    expect(keptWhole(':global(.frame-capsule:has(> .rail-toggle))')).toBe(true)
    expect(keptWhole('::v-global(html.dark)')).toBe(true)
    // What follows is dropped: `html.frame-shell` alone once hid the whole app.
    expect(keptWhole(':global(html.frame-shell) .titlebar')).toBe(false)
    // What comes before is dropped too: `.x :global(.a)` compiles to `.a`.
    expect(keptWhole('.x :global(.a)')).toBe(false)
    expect(keptWhole('::v-global(.a) .b')).toBe(false)
    expect(keptWhole('.b ::v-global(.a)')).toBe(false)
    expect(selectors('.a, :global(.b) .c { x: 1 }\n@media (min-width: 1px) { .d:is(.e, .f) { y: 2 } }')).toEqual(['.a', ':global(.b) .c', '.d:is(.e, .f)'])
  })

  it('never put a selector before or after a :global(...), which Vue would drop', () => {
    const wrong = vueFiles(src).flatMap((file) => {
      const { descriptor } = parse(readFileSync(file, 'utf8'), { filename: file })
      return descriptor.styles
        .filter((style) => style.scoped)
        .flatMap((style) => selectors(style.content))
        .filter((selector) => !keptWhole(selector))
        .map((selector) => `${relative(src, file)}: ${selector}`)
    })
    expect(wrong).toEqual([])
  })

  it('compile the frame\'s rules onto elements, never hiding or clearing the whole document or the shell', () => {
    const errors: string[] = []
    const wholeDocument: string[] = []
    const unscoped: string[] = []
    for (const file of ['views/AppShell.vue', 'App.vue', 'components/MailboxSidebar.vue', 'components/ConversationList.vue', 'views/CalendarView.vue']) {
      const result = compiled(join(src, file))
      errors.push(...result.errors)
      for (const { selector, body } of rules(result.code)) {
        if (/^(html[^\s>+~]*|\.frame-shell[^\s>+~]*|body|#app)$/.test(selector) && /display:\s*none|background:\s*transparent/.test(body)) {
          wholeDocument.push(`${file}: ${selector}`)
        }
        // Each frame rule of the file reaches an element of the component (its scope attribute).
        if (selector.includes('frame-shell') && !selector.includes('[data-v-test]')) {
          unscoped.push(`${file}: ${selector}`)
        }
      }
    }
    expect(errors).toEqual([])
    expect(wholeDocument).toEqual([])
    expect(unscoped).toEqual([])
  })
})
