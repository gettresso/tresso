// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { compileStyle, parse } from 'vue/compiler-sfc'

/**
 * Vue's scoped styles take `:global(A) B` as plain `A`: everything after `:global(...)` is dropped, so a rule meant
 * for one element lands on the whole document (once it hid the whole desktop app). These tests compile the real style
 * blocks the way the build does.
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

/** Every `:global(...)` in a style, with what follows it; nested brackets are counted. */
function globals(css: string): { inside: string; after: string }[] {
  const found: { inside: string; after: string }[] = []
  let at = css.indexOf(':global(')
  while (at >= 0) {
    let end = at + ':global('.length
    let depth = 1
    while (depth > 0 && end < css.length) {
      depth += css[end] === '(' ? 1 : css[end] === ')' ? -1 : 0
      end += 1
    }
    found.push({ inside: css.slice(at + ':global('.length, end - 1), after: css.slice(end, end + 40) })
    at = css.indexOf(':global(', end)
  }
  return found
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
  it('never put a selector after :global(...), which Vue would drop', () => {
    const wrong = vueFiles(src).flatMap((file) => {
      const { descriptor } = parse(readFileSync(file, 'utf8'), { filename: file })
      return descriptor.styles
        .filter((style) => style.scoped)
        .flatMap((style) => globals(style.content))
        .filter(({ after }) => /^\s*[^\s{,]/.test(after))
        .map(({ inside, after }) => `${relative(src, file)}: :global(${inside})${after.split('{')[0]}`)
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
