// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import AppHeader from '@/components/AppHeader.vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { api } from '@/lib/api'
import type { PairingCode, ServerDevice, ServerStatus } from '@/lib/types'
import { LIVE_POLL_MS, PHONE_STORAGE_KEY, useServerStore, VERIFY_DELAY_MS } from '@/stores/server'
import LiveControl from './LiveControl.vue'
import LiveDialog from './LiveDialog.vue'

vi.mock('@/lib/api', () => ({
  api: {
    data: vi.fn(),
    progress: vi.fn(),
    saveProgress: vi.fn(async (p: unknown) => p),
    saveOverrides: vi.fn(),
    startSync: vi.fn(),
    syncStatus: vi.fn(),
    serverStatus: vi.fn(),
    setLive: vi.fn(),
    createPairing: vi.fn(),
    certificateQr: vi.fn(),
    revokeDevice: vi.fn(),
    stopServer: vi.fn(),
  },
}))

const LOCAL_URL = 'https://MacBook-Pro-van-Joost.local:5199'
const IP_URL = 'https://192.168.1.20:5199'
const CERT_URL = 'http://MacBook-Pro-van-Joost.local:5199/certificaat'
const certificateQr = {
  url: CERT_URL,
  qrSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 25 25"><path d="M0 0h7v7H0z"/></svg>',
}

function status(partial: Partial<ServerStatus> = {}): ServerStatus {
  return { mode: 'app', platform: 'mac', local: true, live: false, port: 5199, urls: [], devices: [], ...partial }
}

const phone: ServerDevice = {
  id: 'd1',
  name: 'iPhone (Safari)',
  pairedAt: '2026-09-28T10:00:00Z',
  lastSeenAt: new Date(Date.now() - 5 * 60_000).toISOString(),
}

function pairingCode(expiresInMs: number): PairingCode {
  return {
    code: '482913',
    url: `${LOCAL_URL}/koppel?code=482913`,
    qrSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 29 29"><path d="M0 0h7v7H0z"/></svg>',
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
  }
}

function withTooltips(component: unknown, props: Record<string, unknown> = {}) {
  return defineComponent({
    setup: () => () => h(TooltipProvider, null, { default: () => h(component as never, props) }),
  })
}

const dialog = () => document.body.querySelector<HTMLElement>('[data-live-dialog]')
function buttonIn(root: ParentNode, text: string): HTMLButtonElement {
  const button = [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
  if (!button) throw new Error(`No button "${text}"`)
  return button
}

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  document.body.innerHTML = ''
  for (const fn of Object.values(api)) vi.mocked(fn as () => unknown).mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('live control in the header', () => {
  async function mountHeader() {
    const page = { render: () => h('p', 'quests') }
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/quests', component: page }] })
    await router.push('/quests')
    const w = mount(withTooltips(AppHeader), { global: { plugins: [router] }, attachTo: document.body })
    await flushPromises()
    return w
  }

  it('shows on the Mac itself under the app server', async () => {
    vi.mocked(api.serverStatus).mockResolvedValue(status())
    const w = await mountHeader()
    const control = w.get('[data-slot="live-control"]')
    expect(control.attributes('aria-label')).toBe('Live op wifi: uit')
    expect(control.find('[data-slot="live-dot"]').exists()).toBe(false)
    // The label is for wide screens; below that the icon and the accessible name carry it.
    expect(control.text()).toBe('Live')
    expect(control.get('span.xl\\:inline').classes()).toContain('hidden')
    w.unmount()
  })

  it('marks live mode with a gold dot', async () => {
    vi.mocked(api.serverStatus).mockResolvedValue(status({ live: true, urls: [LOCAL_URL] }))
    const w = await mountHeader()
    const control = w.get('[data-slot="live-control"]')
    expect(control.attributes('aria-label')).toBe('Live op wifi: aan')
    expect(control.find('[data-slot="live-dot"]').exists()).toBe(true)
    w.unmount()
  })

  it.each([
    ['under npm run dev', () => vi.mocked(api.serverStatus).mockResolvedValue(status({ mode: 'dev' }))],
    ['on the phone', () => vi.mocked(api.serverStatus).mockResolvedValue(status({ local: false, live: true, devices: undefined }))],
    ['when the server has no status endpoint', () => vi.mocked(api.serverStatus).mockRejectedValue(new Error('HTTP 404'))],
  ])('is not there %s', async (_, arrange) => {
    arrange()
    const w = await mountHeader()
    expect(w.find('[data-slot="live-control"]').exists()).toBe(false)
    w.unmount()
  })
})

describe('live dialog', () => {
  async function mountDialog(state: Partial<ServerStatus> = {}) {
    const server = useServerStore()
    server.status = status(state)
    const w = mount(withTooltips(LiveDialog, { open: true }), { attachTo: document.body })
    await flushPromises()
    return { w, server, d: dialog()! }
  }

  it('off: the switch with its explanation, and the paired devices', async () => {
    const { w, d } = await mountDialog({ devices: [phone] })
    const sw = d.querySelector<HTMLElement>('[role="switch"]')!
    expect(sw.getAttribute('aria-checked')).toBe('false')
    expect(d.querySelector('label')!.textContent).toContain('Live op wifi')
    const hint = document.getElementById(sw.getAttribute('aria-describedby')!)!
    expect(hint.textContent).toContain('Je telefoon kan het logboek openen zolang dit aan staat. Deze Mac gaat dan niet vanzelf slapen. Na een herstart staat het weer uit.')
    expect(d.textContent).toContain('Open het logboek ook op je telefoon, via hetzelfde wifi-netwerk als deze Mac.')
    expect(d.querySelector('[data-slot="live-url"]')).toBeNull()
    expect(d.textContent).not.toContain('Koppel een apparaat')

    const device = d.querySelector('[data-slot="live-device"]')!
    expect(device.textContent).toContain('iPhone (Safari)')
    expect(device.textContent).toContain('Gekoppeld op 28 sep')
    expect(device.textContent).toContain('laatst gezien 5 min geleden')
    w.unmount()
  })

  it('live without a code: the addresses (.local first, also from an older server) and the pair button', async () => {
    const { w, d } = await mountDialog({ platform: undefined, live: true, urls: [IP_URL, LOCAL_URL] })
    expect(d.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('true')
    expect([...d.querySelectorAll('[data-slot="live-url"]')].map((li) => li.textContent?.trim())).toEqual([LOCAL_URL, IP_URL])
    expect(d.querySelectorAll('[data-slot="live-url"] button[aria-label="Kopieer adres"]')).toHaveLength(2)
    expect(d.textContent).toContain('Nog geen apparaten gekoppeld.')
    expect(d.querySelector('[data-live-pairing]')).toBeNull()

    vi.mocked(api.createPairing).mockResolvedValueOnce(pairingCode(600_000))
    buttonIn(d, 'Koppel een apparaat').click()
    await flushPromises()
    expect(api.createPairing).toHaveBeenCalledTimes(1)
    expect(d.querySelector('[data-live-pairing]')).not.toBeNull()
    w.unmount()
  })

  it('with a code: the QR code, the digits, the countdown and the steps', async () => {
    const { w, server, d } = await mountDialog({ live: true, urls: [LOCAL_URL, IP_URL] })
    server.pairing = pairingCode(600_000)
    await flushPromises()

    const panel = d.querySelector<HTMLElement>('[data-live-pairing]')!
    const img = panel.querySelector('img')!
    expect(img.getAttribute('src')).toMatch(/^data:image\/svg\+xml;charset=utf-8,%3Csvg/)
    expect(img.getAttribute('alt')).toBe('QR-code om je iPhone te koppelen')
    expect(Number(img.getAttribute('width'))).toBeGreaterThanOrEqual(220)
    const digits = panel.querySelector('[data-slot="live-code"]')!
    expect(digits.textContent?.trim()).toBe('482 913')
    expect(digits.getAttribute('aria-label')).toBe('Code 4 8 2 9 1 3')
    expect(panel.querySelector('[data-slot="live-countdown"]')!.textContent).toContain('Nog 10:00 geldig')
    expect(panel.textContent).toContain('Scan de code met de camera van je iPhone.')
    expect(panel.textContent).toContain('Deel > Zet op beginscherm')
    expect(panel.textContent).toContain(`Open ${LOCAL_URL} in Safari op je iPhone en typ de code.`)

    vi.mocked(api.createPairing).mockResolvedValueOnce({ ...pairingCode(600_000), code: '111222' })
    buttonIn(panel, 'Nieuwe code').click()
    await flushPromises()
    expect(d.querySelector('[data-slot="live-code"]')!.textContent?.trim()).toBe('111 222')
    w.unmount()
  })

  it('an expired code says so and offers a new one', async () => {
    const { w, server, d } = await mountDialog({ live: true, urls: [LOCAL_URL] })
    server.pairing = pairingCode(-1000)
    await flushPromises()
    const panel = d.querySelector<HTMLElement>('[data-live-pairing]')!
    expect(panel.textContent).toContain('Deze code is verlopen.')
    expect(panel.textContent).toContain('Verlopen')
    expect(buttonIn(panel, 'Nieuwe code').dataset.variant).toBe('default')
    w.unmount()
  })

  it('shows the Dutch error when switching fails', async () => {
    vi.mocked(api.setLive).mockRejectedValueOnce(new Error('Poort 5199 is al in gebruik door een ander programma'))
    const { w, d } = await mountDialog()
    d.querySelector<HTMLElement>('[role="switch"]')!.click()
    await flushPromises()
    expect(api.setLive).toHaveBeenCalledWith(true)
    const alert = d.querySelector('[role="alert"]')!
    expect(alert.textContent).toContain('Poort 5199 is al in gebruik door een ander programma')
    expect(d.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('false')
    w.unmount()
  })

  it('tells which phone just paired', async () => {
    const { w, server, d } = await mountDialog({ live: true, urls: [LOCAL_URL] })
    vi.mocked(api.createPairing).mockResolvedValueOnce(pairingCode(600_000))
    await server.createPairing()
    vi.mocked(api.serverStatus).mockResolvedValueOnce(status({ live: true, urls: [LOCAL_URL], devices: [phone] }))
    await server.load()
    await flushPromises()
    expect(d.querySelector('[data-live-pairing]')).toBeNull()
    expect(d.querySelector('[role="status"]')!.textContent).toContain('iPhone (Safari) is gekoppeld.')
    expect(buttonIn(d, 'Nog een apparaat koppelen')).toBeTruthy()
    w.unmount()
  })

  it('unpairs a device only after the confirm', async () => {
    const { w, d } = await mountDialog({ devices: [phone] })
    vi.mocked(api.revokeDevice).mockResolvedValueOnce(status({ devices: [] }))
    d.querySelector<HTMLElement>('button[aria-label="Ontkoppel iPhone (Safari)"]')!.click()
    await flushPromises()
    expect(api.revokeDevice).not.toHaveBeenCalled()

    const confirm = [...document.body.querySelectorAll<HTMLElement>('[role="dialog"]')].find((el) =>
      el.textContent?.includes('iPhone (Safari) ontkoppelen?'),
    )!
    buttonIn(confirm, 'Ontkoppel').click()
    await flushPromises()
    expect(api.revokeDevice).toHaveBeenCalledWith('d1')
    expect(dialog()!.textContent).toContain('Nog geen apparaten gekoppeld.')
    w.unmount()
  })
})

describe('live dialog: certificate and pairing steps', () => {
  async function mountDialog(state: Partial<ServerStatus> = {}) {
    const server = useServerStore()
    server.status = status(state)
    const w = mount(withTooltips(LiveDialog, { open: true }), { attachTo: document.body })
    await flushPromises()
    return { w, server, d: dialog()! }
  }
  const live = (partial: Partial<ServerStatus> = {}) => ({ live: true, urls: [LOCAL_URL, IP_URL], certificateUrl: CERT_URL, ...partial })
  const step = (d: ParentNode, name: 'certificate' | 'pair') => d.querySelector<HTMLElement>(`[data-live-step="${name}"]`)!

  it('live: step 1 with the certificate QR, step 2 with the pair button', async () => {
    vi.mocked(api.certificateQr).mockResolvedValue(certificateQr)
    const { w, d } = await mountDialog(live())
    expect(api.certificateQr).toHaveBeenCalledTimes(1)
    expect(api.certificateQr).toHaveBeenCalledWith('iphone')

    const steps = [...d.querySelectorAll<HTMLElement>('[data-live-step]')]
    expect(steps.map((s) => s.dataset.liveStep)).toEqual(['certificate', 'pair'])
    expect(steps.map((s) => s.querySelector('h4')!.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'Stap 1: Certificaat installeren (eenmalig per apparaat)',
      'Stap 2: Koppelen',
    ])

    const cert = step(d, 'certificate').querySelector<HTMLElement>('[data-live-certificate]')!
    expect(cert.style.display).toBe('')
    const img = cert.querySelector('img')!
    expect(img.getAttribute('alt')).toBe('QR-code om het certificaat te installeren')
    expect(decodeURIComponent(img.getAttribute('src')!)).toBe(`data:image/svg+xml;charset=utf-8,${certificateQr.qrSvg}`)
    expect(cert.textContent).toContain('download het profiel')
    expect(cert.textContent).toContain('Profiel gedownload')
    expect(cert.textContent).toContain('Instellingen > Algemeen > Info > Instellingen voor certificaatvertrouwen')
    expect(cert.querySelector('[data-slot="live-certificate-url"]')!.textContent).toBe(CERT_URL)
    // Nothing to fold while there is no pairing code on screen.
    expect(d.querySelector('[data-slot="live-certificate-toggle"]')).toBeNull()

    const pair = step(d, 'pair')
    expect(pair.querySelector('[data-live-pairing]')).toBeNull()
    expect(buttonIn(pair, 'Koppel een apparaat')).toBeTruthy()
    w.unmount()
  })

  it('with a code: the pairing QR to the https address, step 1 folded away until asked for', async () => {
    vi.mocked(api.certificateQr).mockResolvedValue(certificateQr)
    const { w, d } = await mountDialog(live())
    vi.mocked(api.createPairing).mockResolvedValueOnce(pairingCode(600_000))
    buttonIn(step(d, 'pair'), 'Koppel een apparaat').click()
    await flushPromises()

    const panel = step(d, 'pair').querySelector<HTMLElement>('[data-live-pairing]')!
    expect(panel.querySelector('img')!.getAttribute('alt')).toBe('QR-code om je iPhone te koppelen')
    expect(panel.textContent).toContain(`Open ${LOCAL_URL} in Safari op je iPhone en typ de code.`)

    // One QR code on screen at a time.
    const cert = d.querySelector<HTMLElement>('[data-live-certificate]')!
    expect(cert.style.display).toBe('none')
    const toggle = d.querySelector<HTMLButtonElement>('[data-slot="live-certificate-toggle"]')!
    expect(toggle.textContent?.trim()).toBe('Toon QR-code')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.getAttribute('aria-controls')).toBe(cert.id)

    toggle.click()
    await flushPromises()
    expect(cert.style.display).toBe('')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.textContent?.trim()).toBe('Verberg QR-code')
    expect(cert.querySelector('img')!.getAttribute('alt')).toBe('QR-code om het certificaat te installeren')

    // A fresh code folds it again; the QR is not fetched again for the same address.
    vi.mocked(api.createPairing).mockResolvedValueOnce({ ...pairingCode(600_000), code: '111222' })
    buttonIn(panel, 'Nieuwe code').click()
    await flushPromises()
    expect(cert.style.display).toBe('none')
    expect(api.certificateQr).toHaveBeenCalledTimes(1)
    w.unmount()
  })

  it('tells how to repair a home-screen icon that stopped working', async () => {
    vi.mocked(api.certificateQr).mockResolvedValue(certificateQr)
    const { w, d } = await mountDialog(live({ devices: [phone] }))
    const note = d.querySelector('[data-slot="live-repair-note"]')!
    const text = note.textContent!.replace(/\s+/g, ' ')
    expect(text).toContain('Werkt het icoon op je beginscherm niet meer?')
    expect(text).toContain('omdat deze Mac een ander adres kreeg')
    expect(text).toContain('Koppel dat apparaat dan opnieuw met een nieuwe code en zet Ash Log weer op je beginscherm.')
    expect(text).toContain('Staat het certificaat er nog niet op? Doe dan eerst stap 1.')
    w.unmount()
  })

  it('has no such note without paired devices', async () => {
    vi.mocked(api.certificateQr).mockResolvedValue(certificateQr)
    const { w, d } = await mountDialog(live())
    expect(d.querySelector('[data-slot="live-repair-note"]')).toBeNull()
    w.unmount()
  })

  it('shows nothing new while live is off', async () => {
    // Even a stray certificate address outside live mode is ignored.
    const { w, d } = await mountDialog({ live: false, certificateUrl: CERT_URL, devices: [phone] })
    expect(d.querySelector('[data-live-step]')).toBeNull()
    expect(d.querySelector('[data-live-certificate]')).toBeNull()
    expect(d.querySelector('[data-slot="live-repair-note"]')).toBeNull()
    expect(d.querySelector('img')).toBeNull()
    expect(d.textContent).not.toContain('Certificaat')
    expect(api.certificateQr).not.toHaveBeenCalled()
    w.unmount()
  })

  it('fetches the certificate QR once live goes on while the dialog is open', async () => {
    // The check after the switch must not fire into a later test.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.mocked(api.certificateQr).mockResolvedValue(certificateQr)
    const { w, server, d } = await mountDialog()
    expect(api.certificateQr).not.toHaveBeenCalled()
    vi.mocked(api.setLive).mockResolvedValueOnce(status(live()))
    vi.mocked(api.serverStatus).mockResolvedValue(status(live()))
    await server.setLive(true)
    await flushPromises()
    expect(api.certificateQr).toHaveBeenCalledTimes(1)
    expect(d.querySelector('[data-live-certificate] img')).not.toBeNull()
    w.unmount()
  })

  it('says so when the certificate QR does not load, with a retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.mocked(api.certificateQr).mockRejectedValue(new Error('HTTP 500'))
    const { w, d } = await mountDialog(live())
    // Still trying: a quiet placeholder, no error yet.
    expect(d.querySelector('[data-live-certificate] [role="status"]')!.textContent).toContain('QR-code laden...')
    expect(step(d, 'certificate').querySelector('[role="alert"]')).toBeNull()
    await vi.advanceTimersByTimeAsync(VERIFY_DELAY_MS * 2)

    const alert = step(d, 'certificate').querySelector('[role="alert"]')!
    expect(alert.textContent).toContain('De QR-code voor het certificaat laden lukt niet: HTTP 500')
    // The address still works by hand.
    expect(d.querySelector('[data-slot="live-certificate-url"]')!.textContent).toBe(CERT_URL)

    vi.mocked(api.certificateQr).mockResolvedValueOnce(certificateQr)
    buttonIn(alert, 'Opnieuw').click()
    await flushPromises()
    expect(step(d, 'certificate').querySelector('[role="alert"]')).toBeNull()
    expect(d.querySelector('[data-live-certificate] img')).not.toBeNull()
    w.unmount()
  })
})

describe('live dialog: iPhone or Android', () => {
  async function mountDialog(state: Partial<ServerStatus> = {}) {
    const server = useServerStore()
    server.status = status(state)
    const w = mount(withTooltips(LiveDialog, { open: true }), { attachTo: document.body })
    await flushPromises()
    return { w, server, d: dialog()! }
  }
  const live = (partial: Partial<ServerStatus> = {}) => ({ live: true, urls: [LOCAL_URL, IP_URL], certificateUrl: CERT_URL, ...partial })
  const chip = (d: ParentNode, kind: string) => d.querySelector<HTMLButtonElement>(`[data-slot="live-phone"] [data-phone="${kind}"]`)!
  const IP_CERT_URL = 'http://192.168.1.20:5199/certificaat'

  it('starts with the iPhone steps; a tap on Android swaps both steps and both QR codes', async () => {
    vi.mocked(api.certificateQr).mockResolvedValueOnce(certificateQr).mockResolvedValueOnce({ ...certificateQr, url: IP_CERT_URL })
    const { w, server, d } = await mountDialog(live())
    const group = d.querySelector<HTMLElement>('[data-slot="live-phone"]')!
    expect(group.getAttribute('role')).toBe('group')
    expect(document.getElementById(group.getAttribute('aria-labelledby')!)!.textContent).toBe('Welke telefoon?')
    expect([...group.querySelectorAll('button')].map((b) => [b.textContent?.trim(), b.getAttribute('aria-pressed')])).toEqual([
      ['iPhone', 'true'],
      ['Android', 'false'],
    ])
    vi.mocked(api.createPairing).mockResolvedValueOnce(pairingCode(600_000))
    await server.createPairing()
    expect(api.createPairing).toHaveBeenLastCalledWith('iphone')

    vi.mocked(api.createPairing).mockResolvedValueOnce({ ...pairingCode(600_000), code: '777888', url: `${IP_URL}/koppel?code=777888` })
    chip(d, 'android').click()
    await flushPromises()
    expect(chip(d, 'android').getAttribute('aria-pressed')).toBe('true')
    expect(chip(d, 'iphone').getAttribute('aria-pressed')).toBe('false')
    expect(localStorage.getItem(PHONE_STORAGE_KEY)).toBe('android')

    // Step 1: the Android route, the QR fetched again for Android.
    expect(api.certificateQr).toHaveBeenLastCalledWith('android')
    expect(api.certificateQr).toHaveBeenCalledTimes(2)
    const certSteps = d.querySelector('[data-slot="live-certificate-steps"]')!.textContent!
    expect(certSteps).toContain('Certificaat downloaden')
    expect(certSteps).toContain(
      'Open Instellingen > Beveiliging en privacy > Meer beveiligingsinstellingen > Versleuteling en inloggegevens > Certificaat installeren > CA-certificaat.',
    )
    expect(certSteps).toContain('Tik op Toch installeren en kies ash-log-ca.crt uit je Downloads.')
    expect(certSteps).not.toContain('Profiel')
    expect(d.querySelector('[data-live-certificate]')!.textContent).toContain('Zoek in Instellingen op CA-certificaat.')
    expect(d.querySelector('[data-slot="live-certificate-url"]')!.textContent).toBe(IP_CERT_URL)
    expect(d.querySelector('[data-live-certificate]')!.textContent).toContain('in Chrome op je telefoon.')

    // Step 2: a fresh code for Android replaced the iPhone one.
    expect(api.createPairing).toHaveBeenLastCalledWith('android')
    const panel = d.querySelector<HTMLElement>('[data-live-pairing]')!
    expect(panel.querySelector('[data-slot="live-code"]')!.textContent?.trim()).toBe('777 888')
    expect(panel.querySelector('img')!.getAttribute('alt')).toBe('QR-code om je telefoon te koppelen')
    const pairSteps = panel.querySelector('[data-slot="live-pair-steps"]')!.textContent!
    expect(pairSteps).toContain('Open de link in Chrome.')
    expect(pairSteps).toContain('Tik in Chrome op de drie puntjes > Toevoegen aan startscherm.')
    expect(pairSteps).not.toContain('Safari')
    expect(panel.querySelector('[data-slot="live-pairing-url"]')!.textContent).toContain(`Open ${IP_URL} in Chrome op je telefoon en typ de code.`)
    w.unmount()
  })

  it('remembers the phone in this browser', async () => {
    localStorage.setItem(PHONE_STORAGE_KEY, 'android')
    vi.mocked(api.certificateQr).mockResolvedValue({ ...certificateQr, url: IP_CERT_URL })
    const { w, d } = await mountDialog(live())
    expect(chip(d, 'android').getAttribute('aria-pressed')).toBe('true')
    expect(api.certificateQr).toHaveBeenCalledWith('android')
    w.unmount()
  })

  it('tells how to put the logbook on the home screen of the phone that paired', async () => {
    const android: ServerDevice = { id: 'd2', name: 'Android-telefoon (Chrome)', pairedAt: '2026-09-28T10:00:00Z' }
    vi.mocked(api.certificateQr).mockResolvedValue(certificateQr)
    const { w, server, d } = await mountDialog(live())
    vi.mocked(api.createPairing).mockResolvedValueOnce(pairingCode(600_000))
    await server.createPairing()
    vi.mocked(api.serverStatus).mockResolvedValueOnce(status(live({ devices: [android] })))
    await server.load()
    await flushPromises()
    // The iPhone was chosen, but an Android phone paired: its own steps.
    const notice = d.querySelector('[data-live-step="pair"] [role="status"]')!.textContent!
    expect(notice).toContain('Android-telefoon (Chrome) is gekoppeld.')
    expect(notice).toContain('tik in Chrome op de drie puntjes > Toevoegen aan startscherm')
    w.unmount()
  })

  it('on a Windows pc: says pc and how to let the phone through the firewall', async () => {
    vi.mocked(api.certificateQr).mockResolvedValue({ ...certificateQr, url: IP_CERT_URL })
    const { w, d } = await mountDialog(live({ platform: 'windows' }))
    expect(d.textContent).toContain('via hetzelfde wifi-netwerk als deze pc.')
    expect(d.textContent).toContain('Deze pc gaat dan niet vanzelf slapen.')
    expect(d.textContent).not.toMatch(/\bMac\b/)
    const firewall = d.querySelector('[data-slot="live-firewall"]')!.textContent
    expect(firewall).toContain('Sta Node.js toe als Windows Firewall erom vraagt')
    // Microsoft's own label (nl-NL) under Netwerkprofieltype, so the README and the dialog agree.
    expect(firewall).toContain('Privénetwerk (Instellingen > Netwerk en internet > Wi-Fi > je netwerk)')
    w.unmount()
  })

  it('without a known platform says computer, and shows no firewall note on a Mac', async () => {
    vi.mocked(api.certificateQr).mockResolvedValue(certificateQr)
    const unknown = await mountDialog(live({ platform: undefined }))
    expect(unknown.d.textContent).toContain('via hetzelfde wifi-netwerk als deze computer.')
    expect(unknown.d.querySelector('[data-slot="live-firewall"]')).toBeNull()
    unknown.w.unmount()
    document.body.innerHTML = ''
    const mac = await mountDialog(live())
    expect(mac.d.textContent).toContain('via hetzelfde wifi-netwerk als deze Mac.')
    expect(mac.d.querySelector('[data-slot="live-firewall"]')).toBeNull()
    mac.w.unmount()
  })
})

describe('live control polling', () => {
  it('refreshes the status every few seconds while the dialog is open', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const server = useServerStore()
    server.status = status()
    vi.mocked(api.serverStatus).mockResolvedValue(status())
    const w = mount(withTooltips(LiveControl), { attachTo: document.body })
    await flushPromises()
    expect(api.serverStatus).not.toHaveBeenCalled()

    await w.get('[data-slot="live-control"]').trigger('click')
    await flushPromises()
    expect(api.serverStatus).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(LIVE_POLL_MS * 2)
    expect(api.serverStatus).toHaveBeenCalledTimes(3)

    // Closing stops it and forgets the code on screen.
    server.pairing = pairingCode(600_000)
    ;(dialog()!.querySelector('[data-slot="dialog-close"]') as HTMLElement).click()
    await flushPromises()
    await vi.advanceTimersByTimeAsync(LIVE_POLL_MS * 3)
    expect(api.serverStatus).toHaveBeenCalledTimes(3)
    expect(server.pairing).toBeNull()
    w.unmount()
  })
})
