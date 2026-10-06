// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { loadedAssetUrls, registerServiceWorker, swDecision, type SwEnvironment } from './sw-register'

function fakeContainer(opts: { controlled?: boolean; registrations?: number } = {}) {
  const worker = { postMessage: vi.fn() }
  const unregister = vi.fn(async () => true)
  const listeners: Record<string, () => void> = {}
  const container = {
    controller: opts.controlled ? worker : null,
    register: vi.fn(async () => ({ scope: '/' })),
    getRegistrations: vi.fn(async () => Array.from({ length: opts.registrations ?? 0 }, () => ({ unregister }))),
    addEventListener: vi.fn((type: string, fn: () => void) => (listeners[type] = fn)),
  }
  const takeControl = () => {
    container.controller = worker
    listeners.controllerchange?.()
  }
  return { container: container as unknown as ServiceWorkerContainer, raw: container, worker, unregister, takeControl }
}

const phone = (container: ServiceWorkerContainer | undefined, over: Partial<SwEnvironment> = {}): SwEnvironment => ({
  prod: true,
  secure: true,
  hostname: 'MacBook-Pro-van-Joost.local',
  container,
  ...over,
})

describe('swDecision', () => {
  const { container } = fakeContainer()

  it('registers only in a production build, in a secure context, on a phone', () => {
    expect(swDecision(phone(container))).toBe('register')
    expect(swDecision(phone(container, { hostname: '192.168.1.20' }))).toBe('register')
  })

  it('never under the Vite dev server', () => {
    expect(swDecision(phone(container, { prod: false }))).toBe('skip')
  })

  it('never without a secure context (plain http from the network)', () => {
    expect(swDecision(phone(container, { secure: false }))).toBe('skip')
  })

  it('never without service worker support', () => {
    expect(swDecision(phone(undefined))).toBe('skip')
  })

  it('removes a worker on the Mac itself instead', () => {
    for (const hostname of ['localhost', '127.0.0.1', '[::1]']) expect(swDecision(phone(container, { hostname }))).toBe('unregister')
  })
})

describe('registerServiceWorker', () => {
  it('skips the dev server and insecure pages without touching the browser', async () => {
    const fake = fakeContainer()
    expect(await registerServiceWorker({ env: phone(fake.container, { prod: false }) })).toBeNull()
    expect(await registerServiceWorker({ env: phone(fake.container, { secure: false }) })).toBeNull()
    expect(fake.raw.register).not.toHaveBeenCalled()
    expect(fake.raw.getRegistrations).not.toHaveBeenCalled()
  })

  it('never registers in this test run (no production build, localhost)', async () => {
    const fake = fakeContainer()
    await registerServiceWorker({ env: { container: fake.container } })
    expect(fake.raw.register).not.toHaveBeenCalled()
  })

  it('unregisters a worker left behind on the Mac', async () => {
    const fake = fakeContainer({ registrations: 2 })
    expect(await registerServiceWorker({ env: phone(fake.container, { hostname: 'localhost' }) })).toBeNull()
    expect(fake.unregister).toHaveBeenCalledTimes(2)
    expect(fake.raw.register).not.toHaveBeenCalled()
  })

  it('registers /sw.js for the whole app and, once in control, lists the files already loaded', async () => {
    const fake = fakeContainer()
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      { name: `${location.origin}/assets/index-abc.js` },
      { name: `${location.origin}/assets/QuestsView-1.js` },
      { name: `${location.origin}/api/data` },
      { name: 'https://fonts.example/x.woff2' },
    ] as PerformanceEntryList)
    const loader = vi.fn(async () => ({}))
    const router = { getRoutes: () => [{ components: { default: loader } }, { components: { default: {} } }, { components: null }] }

    await registerServiceWorker({ env: phone(fake.container), router: router as never })
    expect(fake.raw.register).toHaveBeenCalledWith('/sw.js', { scope: '/', updateViaCache: 'none' })
    expect(fake.worker.postMessage).not.toHaveBeenCalled()

    fake.takeControl()
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(1))
    expect(fake.worker.postMessage).toHaveBeenCalledWith({
      type: 'cache',
      urls: [`${location.origin}/assets/index-abc.js`, `${location.origin}/assets/QuestsView-1.js`],
    })
  })

  it('never throws when registering fails', async () => {
    const fake = fakeContainer()
    fake.raw.register.mockRejectedValue(new Error('SecurityError'))
    await expect(registerServiceWorker({ env: phone(fake.container) })).resolves.toBeNull()
  })
})

describe('loadedAssetUrls', () => {
  it('keeps only same-origin build files, once each', () => {
    const origin = 'https://mac.local:5199'
    expect(
      loadedAssetUrls(
        [{ name: `${origin}/assets/a.js` }, { name: '/assets/a.js' }, { name: `${origin}/icons/x.png` }, { name: 'https://other.example/assets/b.js' }, { name: '::' }],
        origin,
      ),
    ).toEqual([`${origin}/assets/a.js`])
  })
})

describe('stripDeviceToken', () => {
  it('drops ?device= from the address the kept app opened at, and keeps the rest', async () => {
    const { createMemoryHistory, createRouter } = await import('vue-router')
    const { stripDeviceToken } = await import('./sw-register')
    const view = { render: () => null }
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', redirect: '/quests' },
        { path: '/quests', component: view },
      ],
    })
    await router.push('/?device=secret-token&q=rat#stap')
    expect(router.currentRoute.value.query.device).toBe('secret-token')
    await stripDeviceToken(router)
    expect(router.currentRoute.value.fullPath).toBe('/quests?q=rat#stap')

    await stripDeviceToken(router)
    expect(router.currentRoute.value.fullPath).toBe('/quests?q=rat#stap')
  })
})
