import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { CreatedPersonalAccessToken, PersonalAccessToken } from '@tresso/core'
import SettingsAccessTokensView from '../SettingsAccessTokensView.vue'

/** Form validation runs asynchronously; let it and the requests it starts finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await flushPromises()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

const SECRET = 'tresso_pat_Ab12Cd-secret-part-of-the-token-for-tests'

function token(id: string, name: string, extra: Partial<PersonalAccessToken> = {}): PersonalAccessToken {
  return {
    id,
    name,
    prefix: `tresso_pat_${id}`,
    scopes: ['mail:read', 'signatures:read'],
    createdAt: '2026-11-01T08:00:00+00:00',
    expiresAt: '2099-01-30T08:00:00+00:00',
    lastUsedAt: null,
    revokedAt: null,
    ...extra,
  }
}

describe('SettingsAccessTokensView', () => {
  const requests: { method: string; path: string; body: unknown }[] = []
  let stored: PersonalAccessToken[]

  beforeEach(() => {
    sessionStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'token', refreshToken: null, expiresAt: Date.now() + 3_600_000 }))
    setActivePinia(createPinia())
    requests.length = 0
    stored = [
      token('backup', 'Backup script', { lastUsedAt: '2026-11-02T10:00:00+00:00' }),
      token('old', 'Old export', { expiresAt: '2026-01-01T00:00:00+00:00' }),
      token('gone', 'Gone', { revokedAt: '2026-10-30T00:00:00+00:00' }),
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input))
        const method = init?.method ?? 'GET'
        const body = init?.body ? (JSON.parse(String(init.body)) as { name: string; scopes: string[]; expiresInDays: number }) : undefined
        requests.push({ method, path: url.pathname, body })
        if (method === 'DELETE') {
          const id = url.pathname.split('/').pop()
          stored = stored.map((t) => (t.id === id ? { ...t, revokedAt: '2026-11-03T09:00:00+00:00' } : t))
          return new Response(null, { status: 204 })
        }
        if (method === 'POST') {
          if (body?.name === 'Rejected') {
            return new Response(JSON.stringify({ detail: 'scopes[0]: no', violations: [{ propertyPath: 'scopes[0]', message: 'A personal access token cannot have this permission.' }] }), { status: 422 })
          }
          const created: CreatedPersonalAccessToken = { id: 'new', name: body!.name, prefix: 'tresso_pat_Ab12Cd', scopes: body!.scopes, createdAt: '2026-11-03T09:00:00+00:00', expiresAt: '2027-02-01T09:00:00+00:00', token: SECRET }
          return new Response(JSON.stringify(created), { status: 201 })
        }
        return new Response(JSON.stringify(stored))
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    sessionStorage.clear()
  })

  async function mountView() {
    const wrapper = mount(SettingsAccessTokensView, { attachTo: document.body })
    await settle()
    return wrapper
  }

  it('lists the tokens with their permissions, validity and last use, without a secret', async () => {
    const wrapper = await mountView()

    const rows = wrapper.findAll('.token')
    expect(rows).toHaveLength(3)
    expect(rows[0]!.text()).toContain('Backup script')
    expect(rows[0]!.text()).toContain('tresso_pat_backup')
    expect(rows[0]!.text()).toContain('Read mail, See signatures')
    expect(rows[0]!.text()).toContain('Expires')
    expect(rows[0]!.text()).toContain('Last used')
    expect(rows[1]!.text()).toContain('Expired')
    expect(rows[1]!.text()).toContain('Never used')
    expect(rows[2]!.text()).toContain('Revoked')
    expect(rows.map((row) => row.find('button').exists())).toEqual([true, false, false])
  })

  it('says so when there are no tokens', async () => {
    stored = []
    const wrapper = await mountView()

    expect(wrapper.text()).toContain('No access tokens yet.')
  })

  it('creates a token in a dialog and shows its secret once, with a copy button', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const wrapper = await mountView()

    await wrapper.get('button.new').trigger('click')
    await settle()
    const dialog = wrapper.get('dialog')
    await dialog.get('input:not([type])').setValue('Calendar export')
    await dialog.get('input[value="calendar:read"]').setValue(true)
    await dialog.get('input[value="30"]').setValue(true)
    await dialog.get('form').trigger('submit')
    await settle()

    expect(requests[requests.length - 1]).toEqual({ method: 'POST', path: '/api/v1/personal-access-tokens', body: { name: 'Calendar export', scopes: ['calendar:read'], expiresInDays: 30 } })
    expect(wrapper.get('dialog').text()).toContain('This is the only time you see this token.')
    expect((wrapper.get('#new-token-secret').element as HTMLInputElement).value).toBe(SECRET)

    await wrapper.get('dialog .secret button').trigger('click')
    await settle()
    expect(writeText).toHaveBeenCalledWith(SECRET)
    expect(wrapper.get('dialog .secret button').text()).toBe('Copied')

    const done = wrapper.get('dialog').findAll('button').find((button) => button.text() === 'Done')!
    await done.trigger('click')
    await settle()
    expect(wrapper.find('dialog').exists()).toBe(false)
    expect(wrapper.html()).not.toContain(SECRET)
    expect(wrapper.findAll('.token')[0]!.text()).toContain('Calendar export')
  })

  it('asks for a name and at least one permission before sending anything', async () => {
    const wrapper = await mountView()

    await wrapper.get('button.new').trigger('click')
    await settle()
    await wrapper.get('dialog form').trigger('submit')
    await settle()

    expect(requests.filter((r) => r.method === 'POST')).toEqual([])
    expect(wrapper.get('dialog').text()).toContain('Give the token a name.')
    expect(wrapper.get('dialog').text()).toContain('Choose at least one permission.')
  })

  it('shows what the API refuses next to the permissions', async () => {
    const wrapper = await mountView()

    await wrapper.get('button.new').trigger('click')
    await settle()
    await wrapper.get('dialog input:not([type])').setValue('Rejected')
    await wrapper.get('dialog input[value="mail:read"]').setValue(true)
    await wrapper.get('dialog form').trigger('submit')
    await settle()

    expect(wrapper.get('dialog').text()).toContain('A personal access token cannot have this permission.')
    expect(wrapper.find('#new-token-secret').exists()).toBe(false)
  })

  it('revokes a token only after confirming', async () => {
    const wrapper = await mountView()

    await wrapper.get('.token button').trigger('click')
    expect(requests.filter((r) => r.method === 'DELETE')).toEqual([])
    expect(wrapper.get('[role="alertdialog"]').text()).toContain('Revoke Backup script?')

    const keep = wrapper.get('[role="alertdialog"]').findAll('button').find((button) => button.text() === 'Keep it')!
    await keep.trigger('click')
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false)

    await wrapper.get('.token button').trigger('click')
    const confirm = wrapper.get('[role="alertdialog"]').findAll('button').find((button) => button.text() === 'Revoke token')!
    await confirm.trigger('click')
    await settle()

    expect(requests.filter((r) => r.method === 'DELETE')).toEqual([{ method: 'DELETE', path: '/api/v1/personal-access-tokens/backup', body: undefined }])
    expect(wrapper.findAll('.token')[0]!.text()).toContain('Revoked')
  })
})
