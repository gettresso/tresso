// node --test 'scripts/*.test.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { whatsNew } from './release-notes.mjs'

test('features, fixes and speed-ups make the section, in that order', () => {
  const notes = whatsNew([
    'fix(web): stop every key while the payment screen shows',
    'chore(deps): bump vite',
    'feat(api): add billing per organization',
    'perf(sync): fetch large folders in fewer rounds',
    'ci(ci): pin runners',
    'feat(api)!: drop the old token endpoint',
  ])
  assert.equal(
    notes,
    "## What's new\n\n" +
      '- **New:** Add billing per organization\n' +
      '- **New:** Drop the old token endpoint\n' +
      '- **Fixed:** Stop every key while the payment screen shows\n' +
      '- **Faster:** Fetch large folders in fewer rounds\n',
  )
})

test('a release without user-facing commits has no section', () => {
  assert.equal(whatsNew(['chore(deps): bump vite', 'docs(docs): typo', '']), null)
})

test('a subject that only looks like a feature is left out', () => {
  assert.equal(whatsNew(['feature(web): not a type', 'feat(web) no colon', 'Feat(web): wrong case']), null)
})
