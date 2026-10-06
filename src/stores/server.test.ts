import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { api } from '@/lib/api'
import type { PairingCode, ServerDevice, ServerStatus } from '@/lib/types'
import { sortUrls, useServerStore, VERIFY_DELAY_MS } from './server'

vi.mock('@/lib/api', () => ({
  api: {
    serverStatus: vi.fn(),
    setLive: vi.fn(),
    createPairing: vi.fn(),
    certificateQr: vi.fn(),
    revokeDevice: vi.fn(),
    stopServer: vi.fn(),
  },
}))

const URLS = ['http://192.168.1.20:5199', 'http://MacBook-Pro-van-Joost.local:5199']

function status(partial: Partial<ServerStatus> = {}): ServerStatus {
  return { mode: 'app', local: true, live: false, port: 5199, urls: [], devices: [], ...partial }
}

const phone: ServerDevice = { id: 'd1', name: 'iPhone (Safari)', pairedAt: '2026-09-28T10:00:00Z' }
const code: PairingCode = {
  code: '123456',
  url: 'http://MacBook-Pro-van-Joost.local:5199/koppel?code=123456',
  qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  expiresAt: '2026-09-28T10:10:00Z',
}

/** A promise the test resolves by hand, to hold a request in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.mocked(api.serverStatus).mockReset()
  vi.mocked(api.setLive).mockReset()
  vi.mocked(api.createPairing).mockReset()
  vi.mocked(api.revokeDevice).mockReset()
  vi.mocked(api.certificateQr).mockReset()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('sortUrls', () => {
  it('puts the .local name first and keeps the rest in order', () => {
    expect(sortUrls([...URLS, 'http://10.0.0.5:5199', 'not a url'])).toEqual([
      'http://MacBook-Pro-van-Joost.local:5199',
      'http://192.168.1.20:5199',
      'http://10.0.0.5:5199',
      'not a url',
    ])
  })
})

describe('server store: status', () => {
  it('lets only the Mac itself under the app server manage live mode', async () => {
    const store = useServerStore()
    expect(store.canManage).toBe(false)

    vi.mocked(api.serverStatus).mockResolvedValueOnce(status({ mode: 'dev', live: false }))
    await store.load()
    expect(store.canManage).toBe(false)

    vi.mocked(api.serverStatus).mockResolvedValueOnce(status({ local: false, devices: undefined }))
    await store.load()
    expect(store.canManage).toBe(false)
    expect(store.devices).toEqual([])

    vi.mocked(api.serverStatus).mockResolvedValueOnce(status({ live: true, urls: URLS, devices: [phone] }))
    await store.load()
    expect(store.canManage).toBe(true)
    expect(store.live).toBe(true)
    expect(store.urls[0]).toBe('http://MacBook-Pro-van-Joost.local:5199')
    expect(store.devices).toEqual([phone])
  })

  it('keeps the last status when a refresh fails', async () => {
    const store = useServerStore()
    vi.mocked(api.serverStatus).mockResolvedValueOnce(status({ live: true }))
    await store.load()
    vi.mocked(api.serverStatus).mockRejectedValueOnce(new Error('Failed to fetch'))
    expect(await store.load()).toBe(false)
    expect(store.error).toBe('Failed to fetch')
    expect(store.live).toBe(true)
  })

  it('survives an api without the server endpoint (older middleware)', async () => {
    const store = useServerStore()
    vi.mocked(api.serverStatus).mockRejectedValueOnce(new Error('HTTP 404'))
    await store.load()
    expect(store.status).toBeNull()
    expect(store.canManage).toBe(false)
  })
})

describe('server store: live switch', () => {
  it('shows where the switch is going while the server switches', async () => {
    const store = useServerStore()
    const reply = deferred<ServerStatus>()
    vi.mocked(api.setLive).mockReturnValueOnce(reply.promise)

    const done = store.setLive(true)
    expect(store.switchingTo).toBe(true)
    expect(store.switching).toBe(true)
    // A second click while switching does nothing.
    await store.setLive(false)
    expect(api.setLive).toHaveBeenCalledTimes(1)

    reply.resolve(status({ live: true, urls: URLS }))
    await done
    expect(store.switching).toBe(false)
    expect(store.live).toBe(true)
    expect(api.setLive).toHaveBeenCalledWith(true)
  })

  it("shows the server's Dutch error when switching fails", async () => {
    const store = useServerStore()
    vi.mocked(api.setLive).mockRejectedValueOnce(new Error('Poort 5199 is al in gebruik'))
    await store.setLive(true)
    expect(store.liveError).toBe('Poort 5199 is al in gebruik')
    expect(store.live).toBe(false)
    expect(store.switching).toBe(false)
  })

  it('ignores a status that was under way when the switch started', async () => {
    const store = useServerStore()
    const slow = deferred<ServerStatus>()
    vi.mocked(api.serverStatus).mockReturnValueOnce(slow.promise)
    const loading = store.load()

    vi.mocked(api.setLive).mockResolvedValueOnce(status({ live: true, urls: URLS }))
    await store.setLive(true)
    slow.resolve(status({ live: false }))
    expect(await loading).toBe(false)
    expect(store.live).toBe(true)
  })

  it('checks after the switch that live really stuck', async () => {
    const store = useServerStore()
    vi.mocked(api.setLive).mockResolvedValueOnce(status({ live: true, urls: URLS }))
    await store.setLive(true)
    expect(store.liveError).toBeNull()

    // The listeners are swapping: the first check fails, the retry sees live is off after all.
    vi.mocked(api.serverStatus).mockRejectedValueOnce(new Error('Failed to fetch'))
    vi.mocked(api.serverStatus).mockResolvedValueOnce(status({ live: false }))
    await vi.advanceTimersByTimeAsync(VERIFY_DELAY_MS)
    expect(store.liveError).toBeNull()
    await vi.advanceTimersByTimeAsync(VERIFY_DELAY_MS)
    expect(store.live).toBe(false)
    expect(store.liveError).toBe('Live aanzetten is niet gelukt. Probeer het nog eens.')
  })

  it('stays quiet when the check agrees', async () => {
    const store = useServerStore()
    vi.mocked(api.setLive).mockResolvedValueOnce(status({ live: true, urls: URLS }))
    vi.mocked(api.serverStatus).mockResolvedValue(status({ live: true, urls: URLS }))
    await store.setLive(true)
    await vi.advanceTimersByTimeAsync(VERIFY_DELAY_MS)
    expect(api.serverStatus).toHaveBeenCalledTimes(1)
    expect(store.liveError).toBeNull()
  })
})

describe('server store: pairing and devices', () => {
  async function liveStore(devices: ServerDevice[] = []) {
    const store = useServerStore()
    vi.mocked(api.serverStatus).mockResolvedValueOnce(status({ live: true, urls: URLS, devices }))
    await store.load()
    return store
  }

  it('shows the code, and the device that paired with it once it shows up', async () => {
    const store = await liveStore()
    vi.mocked(api.createPairing).mockResolvedValueOnce(code)
    await store.createPairing()
    expect(store.pairing).toEqual(code)

    // Nothing new yet: the code stays.
    vi.mocked(api.serverStatus).mockResolvedValueOnce(status({ live: true, urls: URLS, devices: [] }))
    await store.load()
    expect(store.pairing).toEqual(code)

    vi.mocked(api.serverStatus).mockResolvedValueOnce(status({ live: true, urls: URLS, devices: [phone] }))
    await store.load()
    expect(store.pairing).toBeNull()
    expect(store.pairedDevice).toEqual(phone)
  })

  it('does not take an earlier device for a new pairing', async () => {
    const store = await liveStore([phone])
    vi.mocked(api.createPairing).mockResolvedValueOnce(code)
    await store.createPairing()
    vi.mocked(api.serverStatus).mockResolvedValueOnce(status({ live: true, urls: URLS, devices: [phone] }))
    await store.load()
    expect(store.pairing).toEqual(code)
    expect(store.pairedDevice).toBeNull()
  })

  it('drops the code when live goes off', async () => {
    const store = await liveStore()
    vi.mocked(api.createPairing).mockResolvedValueOnce(code)
    await store.createPairing()
    vi.mocked(api.setLive).mockResolvedValueOnce(status({ live: false }))
    await store.setLive(false)
    expect(store.pairing).toBeNull()
  })

  it('reports a failed code request', async () => {
    const store = await liveStore()
    vi.mocked(api.createPairing).mockRejectedValueOnce(new Error('Zet eerst Live op wifi aan'))
    await store.createPairing()
    expect(store.pairing).toBeNull()
    expect(store.pairingError).toBe('Zet eerst Live op wifi aan')
    expect(store.pairingBusy).toBe(false)
  })

  it('unpairs a device, or says why not', async () => {
    const store = await liveStore([phone])
    vi.mocked(api.revokeDevice).mockResolvedValueOnce(status({ live: true, urls: URLS, devices: [] }))
    await store.revoke('d1')
    expect(api.revokeDevice).toHaveBeenCalledWith('d1')
    expect(store.devices).toEqual([])
    expect(store.revoking).toBeNull()

    vi.mocked(api.revokeDevice).mockRejectedValueOnce(new Error('Onbekend apparaat'))
    await store.revoke('d9')
    expect(store.deviceError).toBe('Onbekend apparaat')
  })
})

describe('server store: certificate QR', () => {
  const CERT_URL = 'http://MacBook-Pro-van-Joost.local:5199/certificaat'
  const qr = { url: CERT_URL, qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' }

  async function storeWith(partial: Partial<ServerStatus>) {
    const store = useServerStore()
    vi.mocked(api.serverStatus).mockResolvedValueOnce(status(partial))
    await store.load()
    return store
  }

  it('fetches it only while live with a certificate address, and once per address', async () => {
    let store = await storeWith({ live: false, certificateUrl: CERT_URL })
    expect(store.certificateUrl).toBeNull()
    await store.loadCertificate()
    expect(api.certificateQr).not.toHaveBeenCalled()

    setActivePinia(createPinia())
    store = await storeWith({ live: true, urls: URLS })
    await store.loadCertificate()
    expect(api.certificateQr).not.toHaveBeenCalled()

    setActivePinia(createPinia())
    store = await storeWith({ live: true, urls: URLS, certificateUrl: CERT_URL })
    vi.mocked(api.certificateQr).mockResolvedValue(qr)
    await store.loadCertificate()
    expect(store.certificate).toEqual(qr)
    expect(store.certificateBusy).toBe(false)
    await store.loadCertificate()
    expect(api.certificateQr).toHaveBeenCalledTimes(1)

    // Another address (the Mac got a new name): a new QR.
    vi.mocked(api.serverStatus).mockResolvedValueOnce(status({ live: true, urls: URLS, certificateUrl: 'http://Mac.local:5199/certificaat' }))
    await store.load()
    await store.loadCertificate()
    expect(api.certificateQr).toHaveBeenCalledTimes(2)
  })

  it('asks only once while a request is on its way', async () => {
    const store = await storeWith({ live: true, certificateUrl: CERT_URL })
    const reply = deferred<typeof qr>()
    vi.mocked(api.certificateQr).mockReturnValueOnce(reply.promise)
    const first = store.loadCertificate()
    expect(store.certificateBusy).toBe(true)
    await store.loadCertificate()
    expect(api.certificateQr).toHaveBeenCalledTimes(1)
    reply.resolve(qr)
    await first
    expect(store.certificate).toEqual(qr)
  })

  it('tries again while the listeners swap, and reports only the last failure', async () => {
    const store = await storeWith({ live: true, certificateUrl: CERT_URL })
    vi.mocked(api.certificateQr).mockRejectedValueOnce(new Error('Failed to fetch')).mockResolvedValueOnce(qr)
    const done = store.loadCertificate()
    await vi.advanceTimersByTimeAsync(0)
    expect(store.certificateError).toBeNull()
    expect(store.certificateBusy).toBe(true)
    await vi.advanceTimersByTimeAsync(VERIFY_DELAY_MS)
    await done
    expect(store.certificate).toEqual(qr)
    expect(store.certificateError).toBeNull()

    setActivePinia(createPinia())
    const other = await storeWith({ live: true, certificateUrl: CERT_URL })
    vi.mocked(api.certificateQr).mockReset().mockRejectedValue(new Error('HTTP 500'))
    const failing = other.loadCertificate()
    await vi.advanceTimersByTimeAsync(VERIFY_DELAY_MS * 2)
    await failing
    expect(api.certificateQr).toHaveBeenCalledTimes(3)
    expect(other.certificateError).toBe('HTTP 500')
    expect(other.certificateBusy).toBe(false)

    // A retry for the same address goes out again.
    vi.mocked(api.certificateQr).mockResolvedValueOnce(qr)
    await other.loadCertificate()
    expect(other.certificate).toEqual(qr)
    expect(other.certificateError).toBeNull()
  })

  it('forgets it when live goes off, also a request on its way', async () => {
    const store = await storeWith({ live: true, certificateUrl: CERT_URL })
    vi.mocked(api.certificateQr).mockResolvedValueOnce(qr)
    await store.loadCertificate()
    vi.mocked(api.setLive).mockResolvedValueOnce(status({ live: false }))
    await store.setLive(false)
    expect(store.certificate).toBeNull()

    vi.mocked(api.serverStatus).mockResolvedValueOnce(status({ live: true, certificateUrl: CERT_URL }))
    await store.load()
    const reply = deferred<typeof qr>()
    vi.mocked(api.certificateQr).mockReturnValueOnce(reply.promise)
    const pending = store.loadCertificate()
    vi.mocked(api.serverStatus).mockResolvedValueOnce(status({ live: false }))
    await store.load()
    reply.resolve(qr)
    await pending
    expect(store.certificate).toBeNull()
    expect(store.certificateBusy).toBe(false)
  })
})

describe('server store: address order', () => {
  it('keeps the order of a server that names its platform, puts .local first for an older one', async () => {
    const store = useServerStore()
    const ipFirst = ['http://192.168.1.20:5199', 'http://desktop-ab12cd.local:5199']
    vi.mocked(api.serverStatus).mockResolvedValueOnce(status({ platform: 'windows', live: true, urls: ipFirst }))
    await store.load()
    expect(store.urls).toEqual(ipFirst)
    vi.mocked(api.serverStatus).mockResolvedValueOnce(status({ platform: 'mac', live: true, urls: [...URLS].reverse() }))
    await store.load()
    expect(store.urls).toEqual([...URLS].reverse())
    vi.mocked(api.serverStatus).mockResolvedValueOnce(status({ live: true, urls: URLS }))
    await store.load()
    expect(store.urls).toEqual(sortUrls(URLS))
    expect(store.urls[0]).toBe('http://MacBook-Pro-van-Joost.local:5199')
  })
})

describe('server store: iPhone or Android', () => {
  const CERT_URL = 'http://MacBook-Pro-van-Joost.local:5199/certificaat'
  const qr = { url: CERT_URL, qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' }
  const androidQr = { ...qr, url: 'http://192.168.1.20:5199/certificaat' }

  async function liveStore() {
    const store = useServerStore()
    vi.mocked(api.serverStatus).mockResolvedValueOnce(status({ live: true, urls: URLS, certificateUrl: CERT_URL }))
    await store.load()
    return store
  }

  it('asks for both QR codes for the chosen phone, an iPhone by default', async () => {
    const store = await liveStore()
    expect(store.phone).toBe('iphone')
    vi.mocked(api.certificateQr).mockResolvedValueOnce(qr)
    await store.loadCertificate()
    expect(api.certificateQr).toHaveBeenCalledWith('iphone')
    vi.mocked(api.createPairing).mockResolvedValueOnce(code)
    await store.createPairing()
    expect(api.createPairing).toHaveBeenCalledWith('iphone')
  })

  it('another phone drops the certificate QR and swaps a code on screen for a fresh one', async () => {
    const store = await liveStore()
    vi.mocked(api.certificateQr).mockResolvedValueOnce(qr)
    await store.loadCertificate()
    vi.mocked(api.createPairing).mockResolvedValueOnce(code)
    await store.createPairing()

    const fresh = { ...code, code: '654321', url: 'https://192.168.1.20:5199/koppel?code=654321' }
    vi.mocked(api.createPairing).mockResolvedValueOnce(fresh)
    store.setPhone('android')
    expect(store.phone).toBe('android')
    expect(store.certificate).toBeNull()
    // The old code (an address for the iPhone) is gone at once.
    expect(store.pairing).toBeNull()
    await vi.waitFor(() => expect(store.pairing).toEqual(fresh))
    expect(api.createPairing).toHaveBeenLastCalledWith('android')

    // The same address, but for another phone: asked for again.
    vi.mocked(api.certificateQr).mockResolvedValueOnce(androidQr)
    await store.loadCertificate()
    expect(api.certificateQr).toHaveBeenLastCalledWith('android')
    expect(store.certificate).toEqual(androidQr)
    await store.loadCertificate()
    expect(api.certificateQr).toHaveBeenCalledTimes(2)
  })

  it('the same phone again changes nothing, and without a code on screen none is made', async () => {
    const store = await liveStore()
    vi.mocked(api.certificateQr).mockResolvedValueOnce(qr)
    await store.loadCertificate()
    store.setPhone('iphone')
    expect(store.certificate).toEqual(qr)
    store.setPhone('android')
    expect(api.createPairing).not.toHaveBeenCalled()
  })

  it('names the computer after the platform the server reports', async () => {
    const store = useServerStore()
    expect(store.computer).toBe('computer')
    for (const [platform, noun] of [['mac', 'Mac'], ['windows', 'pc'], ['linux', 'computer'], ['other', 'computer']] as const) {
      vi.mocked(api.serverStatus).mockResolvedValueOnce(status({ platform }))
      await store.load()
      expect(store.computer, platform).toBe(noun)
    }
  })
})
