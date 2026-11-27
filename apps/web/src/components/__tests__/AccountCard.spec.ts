import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { NO_UNSUBSCRIBE_ON_IMAP, type MailAccount } from '@tresso/core'
import AccountCard from '../AccountCard.vue'

/** Today at 13:01 local time, so the row says "Synced 13:01" in any zone the tests run in. */
const syncedToday = new Date(new Date().setHours(13, 1, 0, 0)).toISOString()

function account(provider: string, changes: Partial<MailAccount> = {}): MailAccount {
  const servers = provider === 'imap'
  return {
    id: 'work',
    emailAddress: 'kim@company.example',
    displayName: 'Kim Visser',
    provider,
    status: 'active',
    statusDetail: null,
    username: servers ? 'kim@company.example' : null,
    imap: servers ? { host: 'imap.company.example', port: 993, security: 'tls' } : null,
    smtp: servers ? { host: 'smtp.company.example', port: 465, security: 'tls' } : null,
    calendarUrl: null,
    calendarStatus: 'active',
    calendarStatusDetail: null,
    lastSyncedAt: syncedToday,
    createdAt: '2026-10-01T08:00:00Z',
    defaultSignatureId: null,
    ...changes,
  }
}

describe('AccountCard', () => {
  const requests: { method: string; path: string; body: unknown }[] = []
  const assign = vi.fn<(url: string) => void>()
  let patchStatus = 200
  let deleteStatus = 204
  /** Set to hold the next PATCH until it is let go, to press things while it runs. */
  let hold: Promise<void> | null = null
  let wrapper: VueWrapper | null = null

  beforeEach(() => {
    sessionStorage.setItem('auth.tokens', JSON.stringify({ accessToken: 'token', refreshToken: null, expiresAt: Date.now() + 3_600_000 }))
    setActivePinia(createPinia())
    requests.length = 0
    patchStatus = 200
    deleteStatus = 204
    hold = null
    assign.mockReset()
    vi.stubGlobal('location', { ...window.location, assign })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input))
        const method = init?.method ?? 'GET'
        const body = init?.body ? JSON.parse(String(init.body)) : undefined
        requests.push({ method, path: url.pathname, body })
        if (url.pathname === '/api/v1/provider-authorizations') {
          return Response.json({ authorizationUrl: 'https://login.microsoft.example/authorize?state=s', provider: 'microsoft', expiresAt: '2026-10-19T08:15:00+00:00' }, { status: 201 })
        }
        if (method === 'PATCH') {
          if (hold) await hold
          return patchStatus === 200 ? Response.json({ ...account('microsoft'), ...body }) : Response.json({ detail: 'The server refused the change.' }, { status: patchStatus })
        }
        return deleteStatus === 204 ? new Response(null, { status: 204 }) : Response.json({ detail: 'The account could not be removed.' }, { status: deleteStatus })
      }),
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    wrapper?.unmount()
    wrapper = null
    vi.unstubAllGlobals()
    sessionStorage.clear()
    document.body.innerHTML = ''
  })

  function row(value: MailAccount): VueWrapper {
    wrapper = mount(AccountCard, { props: { account: value }, attachTo: document.body })
    return wrapper
  }

  function moreButton(w: VueWrapper) {
    return w.get('button[aria-haspopup="menu"]')
  }

  /** Opens the More menu and gives its items (the menu is on the body). */
  async function openMenu(w: VueWrapper): Promise<HTMLButtonElement[]> {
    await moreButton(w).trigger('click')
    await flushPromises()
    return [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
  }

  async function choose(w: VueWrapper, label: string): Promise<void> {
    const item = (await openMenu(w)).find((button) => button.textContent?.trim() === label)
    expect(item, `menu item ${label}`).toBeDefined()
    item!.click()
    await flushPromises()
  }

  describe('the six states of the board', () => {
    it('normal: a closed row with the mark, name, address, synced time and a More button for the address', () => {
      const w = row(account('microsoft'))

      const item = w.get('[role="listitem"]')
      expect(item.attributes('id')).toBe('account-work')
      expect(item.attributes('tabindex')).toBe('-1')
      expect(w.get('.provider-mark').classes()).toContain('microsoft')
      expect(w.get('.title').text()).toBe('Kim Visser')
      expect(w.get('.line').text()).toBe('kim@company.example')
      expect(w.get('.meta').text()).toBe('Synced 13:01')
      expect(moreButton(w).attributes('aria-label')).toBe('More for kim@company.example')
      // No pills, no attention line, no form, none of the old sentences.
      expect(w.find('.paused').exists()).toBe(false)
      expect(w.find('.attention').exists()).toBe(false)
      expect(w.find('form').exists()).toBe(false)
      expect(w.text()).not.toContain('Active')
      expect(w.text()).not.toContain('Tresso never sees the password')
    })

    it('says "Getting mail" before the first sync', () => {
      const w = row(account('gmail', { lastSyncedAt: null }))

      expect(w.get('.meta').text()).toBe('Getting mail')
    })

    it('needs attention: calendar access is off, with Allow, which asks the provider for just the calendars', async () => {
      const w = row(account('microsoft', { calendarStatus: 'not_granted' }))

      const line = w.get('.attention')
      expect(line.attributes('role')).toBe('status')
      expect(line.classes()).toContain('warning')
      expect(line.get('.text').text()).toBe('Calendar access is off')
      expect(w.get('.meta').text()).toBe('Synced 13:01')

      await line.get('button').trigger('click')
      await flushPromises()

      expect(line.get('button').text()).toBe('Allow')
      expect(requests).toEqual([{ method: 'POST', path: '/api/v1/provider-authorizations', body: { provider: 'microsoft', features: ['calendar'], mailAccountId: 'work' } }])
      expect(assign).toHaveBeenCalledWith('https://login.microsoft.example/authorize?state=s')
    })

    it('editing: Rename puts the name in a field, focused, with Cancel at once and Save once the name differs', async () => {
      const w = row(account('microsoft'))
      await choose(w, 'Rename')

      const field = w.get<HTMLInputElement>('input[aria-label="Display name"]')
      expect(document.activeElement).toBe(field.element)
      expect(field.element.value).toBe('Kim Visser')
      expect(w.text()).toContain('Recipients see: Kim Visser <kim@company.example>')
      // The More button and the meta make room for the field.
      expect(w.find('button[aria-haspopup="menu"]').exists()).toBe(false)
      expect(w.find('.meta').exists()).toBe(false)
      expect(w.findAll('button').map((b) => b.text())).toEqual(['Cancel'])

      await field.setValue('Kim Visser, Company')

      expect(w.text()).toContain('Recipients see: Kim Visser, Company <kim@company.example>')
      expect(w.findAll('button').map((b) => b.text())).toEqual(['Save', 'Cancel'])

      await field.setValue('Kim Visser')
      expect(w.findAll('button').map((b) => b.text())).toEqual(['Cancel'])
      // Spaces around the same name are no change either.
      await field.setValue('  Kim Visser ')
      expect(w.findAll('button').map((b) => b.text())).toEqual(['Cancel'])
    })

    it('menu open: Rename, Sign in again, Pause syncing, then Remove account in red under a rule', async () => {
      const w = row(account('microsoft'))

      const items = await openMenu(w)

      expect(moreButton(w).attributes('aria-expanded')).toBe('true')
      expect(items.map((item) => item.textContent?.trim())).toEqual(['Rename', 'Sign in again', 'Pause syncing', 'Remove account'])
      expect(items[3]!.classList.contains('danger')).toBe(true)
      expect(document.body.querySelector('[role="menu"] [role="separator"]')).not.toBeNull()
      expect(document.body.querySelector('[role="menu"]')!.getAttribute('aria-label')).toBe('More for kim@company.example')
    })

    it('paused: a grey Paused pill and no synced time; the menu resumes', async () => {
      const w = row(account('microsoft', { status: 'paused' }))

      expect(w.get('.meta').text()).toBe('Paused')
      expect(w.find('.meta').text()).not.toContain('Synced')
      expect(w.find('.attention').exists()).toBe(false)

      await choose(w, 'Resume syncing')

      expect(requests).toEqual([{ method: 'PATCH', path: '/api/v1/mail-accounts/work', body: { status: 'active' } }])
      expect(w.get('.visually-hidden[role="status"]').text()).toBe('Syncing resumed.')
      expect(document.activeElement).toBe(moreButton(w).element)
    })

    it('sign-in expired: one red line with Sign in again, and when it last synced', async () => {
      const w = row(account('microsoft', { status: 'auth_failed', statusDetail: 'invalid_grant', lastSyncedAt: '2026-10-17T12:20:00Z' }))

      const line = w.get('.attention')
      expect(line.classes()).toContain('danger')
      expect(line.attributes('role')).toBe('status')
      expect(line.get('.text').text()).toBe('Sign-in expired. New mail is not arriving.')
      expect(w.get('.meta').text()).toMatch(/^Last synced /)

      await line.get('button').trigger('click')
      await flushPromises()

      expect(line.get('button').text()).toBe('Sign in again')
      expect(requests).toEqual([{ method: 'POST', path: '/api/v1/provider-authorizations', body: { provider: 'microsoft', features: ['mail'], mailAccountId: 'work' } }])
    })
  })

  describe('the one attention line', () => {
    it('shows only the mail problem when the calendars need the user too', () => {
      const w = row(account('gmail', { status: 'auth_failed', calendarStatus: 'not_granted' }))

      expect(w.findAll('.attention')).toHaveLength(1)
      expect(w.get('.attention .text').text()).toBe('Sign-in expired. New mail is not arriving.')
    })

    it('says so honestly for a mail server that refuses the password, and opens the server settings', async () => {
      const w = row(account('imap', { status: 'auth_failed', statusDetail: 'Login refused' }))

      const line = w.get('.attention')
      expect(line.get('.text').text()).toBe('The server refused the password. New mail is not arriving.')
      expect(line.get('button').text()).toBe('Server settings')
      await line.get('button').trigger('click')
      await flushPromises()

      expect(w.find('.server').exists()).toBe(true)
      expect(w.get('.detail').text()).toBe('The server said: Login refused')
      expect(w.get('.server').text()).not.toContain('The server said')
      expect(document.activeElement?.closest('.server')).not.toBeNull()
    })

    it('says why under the line, as text, for a provider account too', () => {
      const detail = 'Google refused the calendars of this account (forbidden). Your organization may not allow Tresso to use calendars.'
      const w = row(account('gmail', { calendarStatus: 'error', calendarStatusDetail: detail }))

      expect(w.get('.attention .text').text()).toBe('Calendars are not syncing')
      expect(w.get('.detail').text()).toBe(detail)
      expect(w.get('.detail').attributes('dir')).toBe('auto')

      const markup = row(account('gmail', { status: 'error', statusDetail: '<b>refused</b>' }))
      expect(markup.get('.detail').text()).toBe('The server said: <b>refused</b>')
      expect(markup.find('.detail b').exists()).toBe(false)
    })

    it("leaves a server account's calendar reason to its open server settings, and keeps what the mail server said", async () => {
      const detail = 'The calendar server refused the username or password.'
      const calendar = row(account('imap', { calendarStatus: 'auth_failed', calendarStatusDetail: detail }))
      expect(calendar.get('.detail').text()).toBe(detail)
      await calendar.get('.attention button').trigger('click')
      await flushPromises()

      expect(calendar.find('.detail').exists()).toBe(false)
      expect(calendar.get('.server').text().split(detail)).toHaveLength(2)
      calendar.unmount()

      const mail = row(account('imap', { status: 'auth_failed', statusDetail: 'Login refused', calendarStatus: 'auth_failed', calendarStatusDetail: detail }))
      await mail.get('.attention button').trigger('click')
      await flushPromises()
      expect(mail.get('.detail').text()).toBe('The server said: Login refused')
    })

    it('says no why without a detail, and none without an attention line', () => {
      expect(row(account('gmail', { status: 'auth_failed' })).find('.detail').exists()).toBe(false)
      expect(row(account('gmail', { statusDetail: 'an old message', calendarStatusDetail: 'another' })).find('.detail').exists()).toBe(false)
    })

    it('names its button with the account for a screen reader, after the visible words', () => {
      expect(row(account('gmail', { calendarStatus: 'not_granted' })).get('.attention button').attributes('aria-label')).toBe('Allow calendar access for kim@company.example')
      expect(row(account('gmail', { status: 'auth_failed' })).get('.attention button').attributes('aria-label')).toBe('Sign in again for kim@company.example')
      expect(row(account('imap', { status: 'error' })).get('.attention button').attributes('aria-label')).toBe('Server settings for kim@company.example')
    })

    it('says syncing failed for an account whose sync breaks', () => {
      expect(row(account('imap', { status: 'error' })).get('.attention .text').text()).toBe('Syncing failed. New mail is not arriving.')
    })

    it('stays quiet for calendars that are fine or not offered', () => {
      expect(row(account('gmail', { calendarStatus: 'unsupported' })).find('.attention').exists()).toBe(false)
    })
  })

  describe('the More menu per kind of account', () => {
    it('offers Server settings instead of Sign in again for a mail-server account, and the form under the row', async () => {
      const w = row(account('imap'))

      const items = await openMenu(w)
      expect(items.map((item) => item.textContent?.trim())).toEqual(['Rename', 'Server settings', 'Pause syncing', 'Remove account'])
      items[1]!.click()
      await flushPromises()

      const server = w.get('.server')
      expect(server.find('input[type="password"]').exists()).toBe(true)
      expect(server.text()).toContain(NO_UNSUBSCRIBE_ON_IMAP)

      await server.findAll('button').find((b) => b.text() === 'Close')!.trigger('click')
      await flushPromises()
      expect(w.find('.server').exists()).toBe(false)
      expect(document.activeElement).toBe(moreButton(w).element)
    })

    it('signs a provider account in again from the menu', async () => {
      const w = row(account('gmail'))
      await choose(w, 'Sign in again')

      expect(requests).toEqual([{ method: 'POST', path: '/api/v1/provider-authorizations', body: { provider: 'google', features: ['mail'], mailAccountId: 'work' } }])
    })

    it('pauses syncing', async () => {
      const w = row(account('gmail'))
      await choose(w, 'Pause syncing')

      expect(requests).toEqual([{ method: 'PATCH', path: '/api/v1/mail-accounts/work', body: { status: 'paused' } }])
    })

    it('offers no pause while the mail does not arrive, as before', async () => {
      const items = await openMenu(row(account('gmail', { status: 'error' })))

      expect(items.map((item) => item.textContent?.trim())).toEqual(['Rename', 'Sign in again', 'Remove account'])
    })

    it('asks before it removes an account, and keeps it on Keep it', async () => {
      const w = row(account('microsoft'))
      await choose(w, 'Remove account')

      const confirm = w.get('[role="alertdialog"]')
      expect(confirm.text()).toContain('Remove kim@company.example?')
      expect(confirm.text()).toContain('Tresso also deletes its access to your Microsoft account.')
      expect(document.activeElement?.textContent?.trim()).toBe('Keep it')
      expect(requests).toEqual([])

      await confirm.findAll('button').find((b) => b.text() === 'Keep it')!.trigger('click')
      await flushPromises()
      expect(w.find('[role="alertdialog"]').exists()).toBe(false)
      expect(document.activeElement).toBe(moreButton(w).element)

      await choose(w, 'Remove account')
      await w.get('[role="alertdialog"]').findAll('button').find((b) => b.text() === 'Remove account')!.trigger('click')
      await flushPromises()
      expect(requests).toEqual([{ method: 'DELETE', path: '/api/v1/mail-accounts/work', body: undefined }])
    })
  })

  describe('rename', () => {
    async function renaming(): Promise<{ w: VueWrapper; field: ReturnType<VueWrapper['get']> }> {
      const w = row(account('microsoft'))
      await choose(w, 'Rename')
      return { w, field: w.get('input[aria-label="Display name"]') }
    }

    it('saves on Enter and returns to the row with the focus on More', async () => {
      const { w, field } = await renaming()
      await field.setValue('Kim at work')
      await field.trigger('keydown', { key: 'Enter' })
      await flushPromises()

      expect(requests).toEqual([{ method: 'PATCH', path: '/api/v1/mail-accounts/work', body: { displayName: 'Kim at work' } }])
      expect(w.find('input[aria-label="Display name"]').exists()).toBe(false)
      expect(document.activeElement).toBe(moreButton(w).element)
    })

    it('saves with Save too', async () => {
      const { w, field } = await renaming()
      await field.setValue('Kim at work')
      await w.findAll('button').find((b) => b.text() === 'Save')!.trigger('click')
      await flushPromises()

      expect(requests.filter((r) => r.method === 'PATCH')[0]?.body).toEqual({ displayName: 'Kim at work' })
    })

    it('cancels on Escape without saving, and gives the focus back to More', async () => {
      const { w, field } = await renaming()
      await field.setValue('Something else')
      await field.trigger('keydown', { key: 'Escape' })
      await flushPromises()

      expect(requests).toEqual([])
      expect(w.get('.title').text()).toBe('Kim Visser')
      expect(document.activeElement).toBe(moreButton(w).element)
    })

    it('refuses an empty name with the usual message', async () => {
      const { w, field } = await renaming()
      await field.setValue('   ')
      await field.trigger('keydown', { key: 'Enter' })
      await flushPromises()

      expect(requests).toEqual([])
      expect(field.attributes('aria-invalid')).toBe('true')
      expect(w.text()).toContain('Enter the name people see.')
    })

    it('says why saving failed and stays in the field', async () => {
      patchStatus = 500
      const { w, field } = await renaming()
      await field.setValue('Kim at work')
      await field.trigger('keydown', { key: 'Enter' })
      await flushPromises()

      expect(w.text()).toContain('The server refused the change.')
      expect(w.find('input[aria-label="Display name"]').exists()).toBe(true)
    })

    it('gives the focus back to the field, with the name kept, when saving from Save fails', async () => {
      patchStatus = 500
      const { w, field } = await renaming()
      await field.setValue('Kim at work')
      const save = w.findAll('button').find((b) => b.text() === 'Save')!
      ;(save.element as HTMLButtonElement).focus()
      await save.trigger('click')
      await flushPromises()

      expect(w.text()).toContain('The server refused the change.')
      expect(document.activeElement).toBe(field.element)
      expect((field.element as HTMLInputElement).value).toBe('Kim at work')
    })

    it('saves nothing for the same name with spaces around it, and returns to the row', async () => {
      const { w, field } = await renaming()
      await field.setValue('  Kim Visser  ')
      await field.trigger('keydown', { key: 'Enter' })
      await flushPromises()

      expect(requests).toEqual([])
      expect(w.find('input[aria-label="Display name"]').exists()).toBe(false)
      expect(document.activeElement).toBe(moreButton(w).element)
    })

    it('leaves without typing through Cancel, for a pointer', async () => {
      const { w } = await renaming()
      await w.findAll('button').find((b) => b.text() === 'Cancel')!.trigger('click')
      await flushPromises()

      expect(requests).toEqual([])
      expect(w.get('.title').text()).toBe('Kim Visser')
      expect(document.activeElement).toBe(moreButton(w).element)
    })
  })

  describe('while a request runs', () => {
    it('starts nothing else from the menu: no second pause, no rename', async () => {
      let release!: () => void
      hold = new Promise((resolve) => (release = resolve))
      const w = row(account('gmail'))
      await choose(w, 'Pause syncing')
      await choose(w, 'Pause syncing')
      await choose(w, 'Rename')

      expect(requests.filter((r) => r.method === 'PATCH')).toHaveLength(1)
      expect(w.find('input[aria-label="Display name"]').exists()).toBe(false)
      // The swallowed choice hands the focus back to More, not to the page.
      expect(document.activeElement).toBe(moreButton(w).element)

      release()
      await flushPromises()
      expect(w.get('.visually-hidden[role="status"]').text()).toBe('Syncing paused.')
      await choose(w, 'Rename')
      expect(w.find('input[aria-label="Display name"]').exists()).toBe(true)
    })
  })

  describe('failures', () => {
    it('says why pausing failed', async () => {
      patchStatus = 500
      const w = row(account('gmail'))
      await choose(w, 'Pause syncing')

      expect(w.get('p.form-error[role="alert"]').text()).toBe('The server refused the change.')
      expect(w.get('.visually-hidden[role="status"]').text()).toBe('')
    })

    it('says why removing failed, and keeps the question open', async () => {
      deleteStatus = 500
      const w = row(account('gmail'))
      await choose(w, 'Remove account')
      await w.get('[role="alertdialog"]').findAll('button').find((b) => b.text() === 'Remove account')!.trigger('click')
      await flushPromises()

      expect(w.get('p.form-error[role="alert"]').text()).toBe('The account could not be removed.')
      expect(w.find('[role="alertdialog"]').exists()).toBe(true)
    })
  })

  describe('the synced time', () => {
    it('reads the clock again when the page becomes visible, so last night reads as yesterday', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(2026, 10, 27, 15, 0))
      const w = row(account('gmail', { lastSyncedAt: new Date(2026, 10, 27, 13, 1).toISOString() }))
      expect(w.get('.meta').text()).toBe('Synced 13:01')

      vi.setSystemTime(new Date(2026, 10, 28, 9, 0))
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
      await w.vm.$nextTick()

      expect(w.get('.meta').text()).toBe('Synced Fri 13:01')
    })

    it('stops listening once the row is gone', () => {
      const removed = vi.spyOn(document, 'removeEventListener')
      const w = row(account('gmail'))
      w.unmount()
      wrapper = null

      expect(removed.mock.calls.some(([type]) => type === 'visibilitychange')).toBe(true)
      removed.mockRestore()
    })
  })

  it('takes the mark from the provider type, never from the name or address', () => {
    const dressedUp = row(account('imap', { displayName: 'Google', emailAddress: 'kim@gmail.com' }))
    expect(dressedUp.get('.provider-mark').classes()).toContain('mail')
    dressedUp.unmount()

    const gmail = row(account('gmail', { displayName: 'Microsoft', emailAddress: 'kim@outlook.com' }))
    expect(gmail.get('.provider-mark').classes()).toContain('google')
  })
})
