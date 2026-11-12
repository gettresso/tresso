import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { describeSync, type PullProgress, type SyncFacts } from '@tresso/core'
import SyncStatusLine from '../SyncStatusLine.vue'

const NOW = Date.UTC(2026, 10, 12, 14, 30)
const time = (at: number) => new Date(at).toISOString().slice(11, 16)

function status(change: Partial<SyncFacts>) {
  const facts: SyncFacts = { copy: 'open', confirmed: true, afterUpdate: false, pull: null, origin: null, error: null, stream: 'live', wasLive: true, online: true, lastSyncedAt: NOW - 28 * 60_000, now: NOW, ...change }
  return describeSync(facts, time)
}

function pull(change: Partial<PullProgress>): PullProgress {
  return { from: 0, cursor: 0, latest: null, items: 0, pages: 0, hasMore: null, ...change }
}

function line(change: Partial<SyncFacts>) {
  const wrapper = mount(SyncStatusLine, { props: { status: status(change) } })
  return {
    wrapper,
    text: wrapper.find('.line').exists() ? wrapper.get('.line').text() : '',
    loader: wrapper.find('.logo-loader').exists(),
    progress: wrapper.find('.progress').exists() ? wrapper.get('.fill').attributes('style') : null,
    announced: wrapper.get('[role="status"]').text(),
  }
}

describe('SyncStatusLine', () => {
  it('shows each state of the sync in its own words', () => {
    const states: [Partial<SyncFacts>, string, boolean][] = [
      [{ copy: 'opening' }, 'Opening your mail…', true],
      [{ confirmed: false, stream: 'off' }, 'Showing mail kept on this device', false],
      [{ pull: pull({}), origin: 0, lastSyncedAt: null }, 'Getting your mail…', true],
      [{ afterUpdate: true, pull: pull({}), origin: 0 }, 'Updating your mail on this device after the update…', true],
      [{ pull: pull({ from: 100, cursor: 600, latest: 13_000, pages: 1, hasMore: true }), origin: 100 }, 'Catching up: 12,400 changes to go', true],
      [{}, 'Up to date', false],
      [{ stream: 'connecting', wasLive: false }, 'Connecting…', true],
      [{ stream: 'retrying' }, 'Reconnecting… Last synced 14:02', true],
      [{ online: false, stream: 'retrying' }, 'Offline. Last synced 14:02', false],
      [{ online: false, stream: 'live' }, 'Up to date', false],
      [{ pull: pull({ from: 100, cursor: 100 }), origin: 100, lastSyncedAt: null }, 'Checking for new mail…', false],
      [{ pull: pull({ from: 100, cursor: 100 }), origin: 100 }, 'Up to date', false],
      [{ error: 'Bad gateway' }, 'Sync stopped. Last synced 14:02', false],
      [{ stream: 'off' }, 'Last synced 14:02', false],
    ]
    for (const [facts, text, loader] of states) {
      const shown = line(facts)
      expect({ text: shown.text, loader: shown.loader }).toEqual({ text, loader })
    }
  })

  it('draws a thin progress line only when the fraction is known', () => {
    expect(line({ pull: pull({ cursor: 620, latest: 1000, pages: 2, hasMore: true }), origin: 0, lastSyncedAt: null })).toMatchObject({ text: 'Getting your mail, 62%', progress: 'transform: scaleX(0.62);' })
    expect(line({ pull: pull({ cursor: 600, items: 40, pages: 1, hasMore: true }), origin: 0 }).progress).toBeNull()
    expect(line({}).progress).toBeNull()
  })

  it('announces politely, by the quarter, not every percent', () => {
    const at = (cursor: number) => line({ pull: pull({ cursor, latest: 1000, pages: 1, hasMore: true }), origin: 0, lastSyncedAt: null }).announced
    expect(at(510)).toBe('Getting your mail, 50%')
    expect(at(620)).toBe('Getting your mail, 50%')
    expect(at(760)).toBe('Getting your mail, 75%')
    expect(line({}).wrapper.get('[role="status"]').attributes('aria-live')).toBe('polite')
  })

  it('marks a live copy and a stopped sync apart', () => {
    expect(line({}).wrapper.classes()).toContain('on')
    expect(line({ error: 'Bad gateway' }).wrapper.classes()).toContain('problem')
  })

  it('shows nothing but keeps the live region while no copy is open', () => {
    const closed = line({ copy: 'closed' })
    expect(closed.text).toBe('')
    expect(closed.announced).toBe('')
  })
})
