// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { h } from 'vue'
import ConfirmDialog from './ConfirmDialog.vue'
import LocationText from './LocationText.vue'
import RelativeTime from './RelativeTime.vue'
import ParchmentPanel from './ParchmentPanel.vue'
import PowerBadge from './PowerBadge.vue'
import ProgressBar from './ProgressBar.vue'
import StatusBadge from './StatusBadge.vue'
import ToggleChip from './ToggleChip.vue'
import WikiIcon from './WikiIcon.vue'
import WikiLink from './WikiLink.vue'

describe('ProgressBar', () => {
  it('clamps the value and exposes it as a percentage', () => {
    const over = mount(ProgressBar, { props: { value: 1.7, label: 'Stappen' } })
    expect(over.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('100')
    expect(over.get('[role="progressbar"]').attributes('aria-label')).toBe('Stappen')
    const nan = mount(ProgressBar, { props: { value: Number.NaN, showPercent: true } })
    expect(nan.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('0')
    expect(nan.text()).toContain('0%')
  })

  it('prefers detail over the percentage', () => {
    const w = mount(ProgressBar, { props: { value: 0.375, detail: '3 / 8', showPercent: true } })
    expect(w.text()).toContain('3 / 8')
    expect(w.text()).not.toContain('38%')
  })
})

describe('badges', () => {
  it('shows the Dutch quest state', () => {
    expect(mount(StatusBadge, { props: { state: 'active' } }).text()).toBe('Bezig')
    expect(mount(StatusBadge, { props: { state: 'done' } }).text()).toBe('Voltooid')
  })

  it('shows PL with a readable name', () => {
    const w = mount(PowerBadge, { props: { power: 4 } })
    expect(w.attributes('title')).toBe('Power level 4')
    expect(w.text()).toContain('PL 4')
  })

  it('picks the parchment tone inside a panel', () => {
    const w = mount(ParchmentPanel, { slots: { default: () => h(StatusBadge, { state: 'open' }) } })
    expect(w.get('[data-slot="badge"]').attributes('data-tone')).toBe('parchment')
  })
})

describe('WikiLink', () => {
  it('links a page title to the wiki in a new tab', () => {
    const w = mount(WikiLink, { props: { page: "Black Knight's Fortress" } })
    const a = w.get('a')
    expect(a.attributes('href')).toBe("https://dragonwilds.runescape.wiki/w/Black_Knight's_Fortress")
    expect(a.attributes('target')).toBe('_blank')
    expect(a.attributes('rel')).toContain('noopener')
    expect(w.text()).toContain("Black Knight's Fortress")
  })

  it('grows the one-line link to a 44px hit area', () => {
    const cls = mount(WikiLink, { props: { page: 'Ratcatcher' } }).get('a').classes()
    expect(cls).toContain('relative')
    expect(cls).toContain('before:absolute')
    expect(cls).toContain('before:-inset-y-[11px]')
  })

  it('marks a page title as English, but leaves slot text to the caller', () => {
    const titled = mount(WikiLink, { props: { page: 'Ratcatcher' } })
    expect(titled.get('[lang="en"]').text()).toBe('Ratcatcher')
    const slotted = mount(WikiLink, { props: { page: 'Ratcatcher' }, slots: { default: 'Op de wiki' } })
    expect(slotted.find('[lang="en"]').exists()).toBe(false)
    expect(mount(WikiLink).text()).toContain('Op de wiki')
  })

  it('uses href as is when given', () => {
    const w = mount(WikiLink, { props: { href: 'https://dragonwilds.runescape.wiki/w/Ratcatcher' }, slots: { default: 'Op de wiki' } })
    expect(w.get('a').attributes('href')).toBe('https://dragonwilds.runescape.wiki/w/Ratcatcher')
  })
})

describe('WikiIcon', () => {
  it('loads from /wiki-img/icons and falls back when the image fails', async () => {
    const w = mount(WikiIcon, { props: { file: 'File:Gold Ore.png', alt: 'Gold' } })
    expect(w.get('img').attributes('src')).toBe('/wiki-img/icons/Gold_Ore.png')
    await w.get('img').trigger('error')
    expect(w.find('img').exists()).toBe(false)
    expect(w.get('svg').attributes('aria-label')).toBe('Gold')
    await w.setProps({ file: 'Silver_Ore.png' })
    expect(w.get('img').attributes('src')).toBe('/wiki-img/icons/Silver_Ore.png')
  })

  it('shows the fallback without a file', () => {
    const w = mount(WikiIcon, { props: { file: undefined } })
    expect(w.find('img').exists()).toBe(false)
    expect(w.get('svg').attributes('aria-hidden')).toBe('true')
  })
})

describe('ToggleChip', () => {
  it('reports aria-pressed and emits the flipped state', async () => {
    const w = mount(ToggleChip, { props: { pressed: false, count: 12 }, slots: { default: 'Chests' } })
    expect(w.attributes('aria-pressed')).toBe('false')
    await w.trigger('click')
    expect(w.emitted('update:pressed')).toEqual([[true]])
  })
})

describe('LocationText', () => {
  it('is English wiki text by default, Dutch when asked', () => {
    expect(mount(LocationText, { slots: { default: 'Fellhollow' } }).attributes('lang')).toBe('en')
    expect(mount(LocationText, { props: { lang: 'nl' }, slots: { default: 'Overige' } }).attributes('lang')).toBe('nl')
  })
})

describe('RelativeTime', () => {
  it('has a compact form for tight spots', () => {
    const value = new Date(Date.now() - 5 * 60_000).toISOString()
    expect(mount(RelativeTime, { props: { value } }).text()).toBe('5 min geleden')
    const short = mount(RelativeTime, { props: { value, short: true } })
    expect(short.text()).toBe('5 min')
    expect(short.attributes('title')).toBeTruthy()
  })
})

describe('ConfirmDialog', () => {
  it('shows details from the slot and emits confirm once confirmed', async () => {
    document.body.innerHTML = ''
    const w = mount(ConfirmDialog, {
      props: { open: true, title: 'Opruimen?', description: '2 vinkjes gaan weg.', confirmLabel: 'Opruimen' },
      slots: { default: () => h('p', { class: 'details' }, 'Queststappen 2') },
      attachTo: document.body,
    })
    await flushPromises()
    const dialog = document.body.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('2 vinkjes gaan weg.')
    expect(dialog.querySelector('.details')?.textContent).toBe('Queststappen 2')
    ;[...dialog.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Opruimen')!.click()
    await flushPromises()
    expect(w.emitted('confirm')).toHaveLength(1)
    expect(w.emitted('update:open')).toEqual([[false]])
    w.unmount()
  })
})
