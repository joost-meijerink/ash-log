// WikiClient against a fake fetch. Responses are shaped like the real API
// (formatversion=2) and partly built from stored fixtures. Never hits the network.

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fixtureJson, fixturePages, fixtureText } from './__fixtures__/load'
import { decodeEnvText, parseEnvText } from './env'
import { ROOT } from './paths'
import { API_URL, BATCH_SIZE, WIKI_ORIGIN, WikiClient, WikiError, userAgentProblem } from './wiki'

const UA = 'AshLog-test/0.1 (test@ash-log.test)'

interface Call {
  url: URL
  headers: Record<string, string>
}

type Handler = (url: URL, call: number) => Response | Promise<Response>

/** Every URL any client in this file requested, checked in afterAll. */
const allUrls: string[] = []

function fakeFetch(handler: Handler) {
  const calls: Call[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const url = new URL(href)
    calls.push({ url, headers: { ...((init?.headers ?? {}) as Record<string, string>) } })
    allUrls.push(href)
    return handler(url, calls.length)
  }) as typeof fetch
  return { fetchImpl, calls }
}

function client(handler: Handler, extra: { maxRetries?: number; log?: (m: string) => void } = {}) {
  const fake = fakeFetch(handler)
  const wiki = new WikiClient({ userAgent: UA, delayMs: 0, fetchImpl: fake.fetchImpl, ...extra })
  return { wiki, calls: fake.calls }
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } })
}

const titlesOf = (url: URL) => (url.searchParams.get('titles') ?? '').split('|')

/** Lets pending promise callbacks and real I/O run until the client is sleeping on a (fake) timer. */
async function untilSleeping(): Promise<void> {
  for (let i = 0; i < 50 && vi.getTimerCount() === 0; i++) await new Promise((r) => setImmediate(r))
  expect(vi.getTimerCount()).toBe(1)
}

afterAll(() => {
  expect(allUrls.length).toBeGreaterThan(0)
  for (const href of allUrls) {
    expect(href).not.toMatch(/[?&]action=(edit|bucket)\b/)
  }
})

describe('WikiClient: constructor', () => {
  it('rejects a User-Agent without contact details', () => {
    expect(() => new WikiClient({ userAgent: '' })).toThrow(WikiError)
    expect(() => new WikiClient({ userAgent: 'AshLog/0.1' })).toThrow(/no contact details/)
  })

  it('accepts an e-mail address or a URL as contact', () => {
    expect(() => new WikiClient({ userAgent: 'AshLog/0.1 (test@ash-log.test)' })).not.toThrow()
    expect(() => new WikiClient({ userAgent: 'AshLog/0.1 (https://github.com/someone/ash-log)' })).not.toThrow()
    expect(() => new WikiClient({ userAgent: 'AshLog/1.0 (https://my-example.org; mail@examples.com)' })).not.toThrow()
  })

  it('rejects the placeholder from .env.example and other example domains', () => {
    expect(() => new WikiClient({ userAgent: 'AshLog/1.0 (your-email@example.com)' })).toThrow(/example address from \.env\.example/)
    for (const agent of ['AshLog/1.0 (me@EXAMPLE.ORG)', 'AshLog/1.0 (https://example.net/contact)', 'AshLog/1.0 (me@mail.example)', 'AshLog/1.0 (https://www.example.com; a@example.com)']) {
      expect(userAgentProblem(agent), agent).toBe('example')
    }
  })

  it('rejects the WIKI_USER_AGENT that .env.example ships with', async () => {
    const example = parseEnvText(decodeEnvText(await readFile(join(ROOT, '.env.example'))))
    expect(example.WIKI_USER_AGENT).toBeTruthy()
    expect(userAgentProblem(example.WIKI_USER_AGENT!)).toBe('example')
  })

  it('accepts a real contact next to an example one', () => {
    expect(userAgentProblem('AshLog/1.0 (https://github.com/someone/ash-log; your-email@example.com)')).toBeNull()
  })

  it('says what is missing', () => {
    expect(userAgentProblem('')).toBe('missing')
    expect(userAgentProblem('AshLog/1.0 (no contact)')).toBe('missing')
    expect(userAgentProblem('AshLog/1.0 (me@home.nl)')).toBeNull()
  })
})

describe('WikiClient: every request', () => {
  it('sends User-Agent and Api-User-Agent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ashenfall-wiki-'))
    try {
      const { wiki, calls } = client((url) => (url.pathname === '/api.php' ? json({ batchcomplete: true }) : new Response('x')))
      await wiki.api({ action: 'query', meta: 'siteinfo' })
      await wiki.raw('MediaWiki:Gadget-maps.js')
      await wiki.download('https://maps.runescape.wiki/dw/tiles/0/0_0.png', join(dir, 't.png'))
      expect(calls).toHaveLength(3)
      for (const call of calls) {
        expect(call.headers['User-Agent']).toBe(UA)
        expect(call.headers['Api-User-Agent']).toBe(UA)
      }
      expect(calls[0]!.headers.Accept).toBe('application/json')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('always sends format=json, formatversion=2 and maxlag=5 to api.php', async () => {
    const { wiki, calls } = client((url) => {
      if (url.searchParams.get('prop') === 'revisions') return json({ query: { pages: [] } })
      return json({ batchcomplete: true, query: { pages: [], allpages: [] } })
    })
    await wiki.api({ action: 'query', meta: 'siteinfo' })
    await wiki.queryAll({ list: 'allpages', apnamespace: 828 }, (d) => d.query.allpages)
    await wiki.pages(['Ratcatcher'])
    await wiki.revisions(['Ratcatcher'])
    await wiki.imageUrls(['Gold_Ore.png'])

    expect(calls).toHaveLength(5)
    for (const { url } of calls) {
      expect(`${url.origin}${url.pathname}`).toBe(API_URL)
      expect(url.searchParams.get('format')).toBe('json')
      expect(url.searchParams.get('formatversion')).toBe('2')
      expect(url.searchParams.get('maxlag')).toBe('5')
    }
  })

  it('never runs two requests at the same time, even without awaiting', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ashenfall-wiki-'))
    try {
      let inFlight = 0
      let maxInFlight = 0
      const events: string[] = []
      const { wiki, calls } = client(async (url, n) => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        events.push(`start ${n}`)
        await new Promise((r) => setTimeout(r, 5))
        events.push(`end ${n}`)
        inFlight--
        if (url.pathname === '/api.php') return json({ query: { pages: [] } })
        return new Response('body')
      })

      // Fired without awaiting in between.
      const pending = [
        wiki.api({ action: 'query', meta: 'siteinfo' }),
        wiki.raw('MediaWiki:Gadget-maps.js'),
        wiki.revisions(['A', 'B']),
        wiki.download('https://maps.runescape.wiki/dw/tiles/0/1_1.png', join(dir, 'tile.png')),
        wiki.api({ action: 'query', list: 'allpages' }),
      ]
      await Promise.all(pending)

      expect(maxInFlight).toBe(1)
      expect(events).toEqual(['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3', 'start 4', 'end 4', 'start 5', 'end 5'])
      // First in, first out.
      expect(calls.map((c) => c.url.searchParams.get('action') ?? c.url.hostname)).toEqual([
        'query',
        'raw',
        'query',
        'maps.runescape.wiki',
        'query',
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps the queue going after a failed request', async () => {
    const { wiki } = client((_url, n) => (n === 1 ? new Response('bad', { status: 400 }) : json({ batchcomplete: true })))
    const first = wiki.api({ action: 'query', meta: 'siteinfo' })
    const second = wiki.api({ action: 'query', meta: 'siteinfo' })
    await expect(first).rejects.toThrow(/HTTP 400/)
    await expect(second).resolves.toEqual({ batchcomplete: true })
  })

  it('throws a WikiError for API errors other than maxlag', async () => {
    const { wiki } = client(() => json({ error: { code: 'badvalue', info: 'Unrecognized value for parameter "list".' } }))
    await expect(wiki.api({ action: 'query', list: 'nope' })).rejects.toThrow(/Wiki API error badvalue/)
  })

  it('wraps a network failure after the last retry in a WikiError', async () => {
    const { wiki, calls } = client(
      () => {
        throw new TypeError('fetch failed')
      },
      { maxRetries: 0 },
    )
    const result = wiki.api({ action: 'query', meta: 'siteinfo' })
    await expect(result).rejects.toThrow(WikiError)
    await expect(result).rejects.toThrow(/Can't reach the wiki after 1 attempt: fetch failed/)
    expect(calls).toHaveLength(1)
  })
})

describe('WikiClient: backing off', () => {
  beforeEach(() => {
    // Only timers and the clock; setImmediate stays real so fetch bodies can resolve.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('retries a maxlag error after the Retry-After wait', async () => {
    const log = vi.fn()
    const { wiki, calls } = client(
      (_url, n) =>
        n === 1
          ? json(
              { error: { code: 'maxlag', info: 'Waiting for 10.0.0.1: 7 seconds lagged.', lag: 7 } },
              200,
              { 'Retry-After': '1', 'X-Database-Lag': '7' },
            )
          : json({ batchcomplete: true, query: { general: { sitename: 'RuneScape: Dragonwilds Wiki' } } }),
      { log },
    )

    const result = wiki.api({ action: 'query', meta: 'siteinfo' })
    await untilSleeping()
    expect(calls).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(999)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)

    await expect(result).resolves.toMatchObject({ query: { general: { sitename: 'RuneScape: Dragonwilds Wiki' } } })
    expect(calls).toHaveLength(2)
    expect(calls[1]!.url.href).toBe(calls[0]!.url.href)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('maxlag'))
  })

  it('retries HTTP 429 after the Retry-After wait', async () => {
    const { wiki, calls } = client((_url, n) =>
      n === 1 ? new Response('Too Many Requests', { status: 429, headers: { 'Retry-After': '2' } }) : new Response('raw text'),
    )

    const result = wiki.raw('MediaWiki:Gadget-maps.js')
    await untilSleeping()
    await vi.advanceTimersByTimeAsync(1999)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)

    await expect(result).resolves.toBe('raw text')
    expect(calls).toHaveLength(2)
  })

  it('gives up after maxRetries', async () => {
    const { wiki, calls } = client(() => new Response('slow down', { status: 429, headers: { 'Retry-After': '1' } }), { maxRetries: 1 })
    const result = wiki.api({ action: 'query', meta: 'siteinfo' })
    const settled = expect(result).rejects.toThrow(/Gave up after 2 attempts: HTTP 429/)
    await untilSleeping()
    await vi.advanceTimersByTimeAsync(1000)
    await settled
    expect(calls).toHaveLength(2)
  })

  it('retries when the connection drops while the body streams in', async () => {
    const log = vi.fn()
    const { wiki, calls } = client(
      (_url, n) => {
        if (n > 1) return json({ batchcomplete: true })
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"batchcomplete":'))
            controller.error(new TypeError('terminated'))
          },
        })
        return new Response(body, { headers: { 'content-type': 'application/json' } })
      },
      { log },
    )

    const result = wiki.api({ action: 'query', meta: 'siteinfo' })
    await untilSleeping()
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2000)

    await expect(result).resolves.toEqual({ batchcomplete: true })
    expect(calls).toHaveLength(2)
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^Network error, retrying in 2000 ms: terminated/))
  })

  it('retries a 200 whose body is not JSON (an HTML error page)', async () => {
    const log = vi.fn()
    const { wiki, calls } = client(
      (_url, n) => (n === 1 ? new Response('<html>Bad gateway</html>', { headers: { 'content-type': 'text/html' } }) : json({ batchcomplete: true })),
      { log },
    )

    const result = wiki.api({ action: 'query', meta: 'siteinfo' })
    await untilSleeping()
    await vi.advanceTimersByTimeAsync(4999)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)

    await expect(result).resolves.toEqual({ batchcomplete: true })
    expect(calls).toHaveLength(2)
    expect(log).toHaveBeenCalledWith('no valid JSON, waiting 5 s')
  })

  it('gives up on a body that never becomes JSON', async () => {
    const { wiki, calls } = client(() => new Response('<html>nope</html>'), { maxRetries: 1 })
    const result = wiki.api({ action: 'query', meta: 'siteinfo' })
    const settled = expect(result).rejects.toThrow(/No valid JSON from https:\/\/dragonwilds\.runescape\.wiki\/api\.php.* \(after 2 attempts\)/)
    await untilSleeping()
    await vi.advanceTimersByTimeAsync(5000)
    await settled
    expect(calls).toHaveLength(2)
  })

  it('does not retry a 404', async () => {
    const { wiki, calls } = client(() => new Response('Not Found', { status: 404 }))
    await expect(wiki.raw('Nope')).rejects.toThrow(/404 \(not found\)/)
    expect(calls).toHaveLength(1)
  })
})

describe('WikiClient: queries', () => {
  it('raw() reads index.php?action=raw', async () => {
    const gadget = fixtureText('map/gadget-maps.js')
    const { wiki, calls } = client(() => new Response(gadget, { headers: { 'content-type': 'text/javascript' } }))
    await expect(wiki.raw('MediaWiki:Gadget-maps.js')).resolves.toBe(gadget)
    const url = calls[0]!.url
    expect(`${url.origin}${url.pathname}`).toBe(`${WIKI_ORIGIN}/index.php`)
    expect(url.searchParams.get('title')).toBe('MediaWiki:Gadget-maps.js')
    expect(url.searchParams.get('action')).toBe('raw')
  })

  it('queryAll() follows continue until done', async () => {
    const all = fixtureJson('map/allpages.json').query.allpages as { title: string }[]
    const half = Math.ceil(all.length / 2)
    const { wiki, calls } = client((url) => {
      if (!url.searchParams.has('apcontinue')) {
        return json({ batchcomplete: true, continue: { apcontinue: 'Map/Next', continue: '-||' }, query: { allpages: all.slice(0, half) } })
      }
      return json({ batchcomplete: true, query: { allpages: all.slice(half) } })
    })

    const pages = await wiki.queryAll({ list: 'allpages', apnamespace: 828, apprefix: 'Map/', aplimit: 'max' }, (d) => d.query.allpages)

    expect(pages).toEqual(all)
    expect(calls).toHaveLength(2)
    expect(calls[0]!.url.searchParams.get('action')).toBe('query')
    expect(calls[1]!.url.searchParams.get('apcontinue')).toBe('Map/Next')
    expect(calls[1]!.url.searchParams.get('continue')).toBe('-||')
    expect(calls[1]!.url.searchParams.get('apprefix')).toBe('Map/')
  })

  it('pages() batches 50 titles per request', async () => {
    const titles = Array.from({ length: 120 }, (_, i) => `Module:Map/Point ${i}.json`)
    const { wiki, calls } = client((url) =>
      json({
        batchcomplete: true,
        query: {
          pages: titlesOf(url).map((title) => {
            const i = Number(/\d+/.exec(title)![0])
            return { ns: 828, title, revisions: [{ revid: 1000 + i, slots: { main: { contentmodel: 'json', content: `[{"x":${i},"y":0}]` } } }] }
          }),
        },
      }),
    )

    const { pages, missing } = await wiki.pages([...titles, titles[0]!])

    expect(calls.map((c) => titlesOf(c.url).length)).toEqual([BATCH_SIZE, BATCH_SIZE, 20])
    expect(calls[0]!.url.searchParams.get('prop')).toBe('revisions')
    expect(calls[0]!.url.searchParams.get('rvprop')).toBe('content|ids')
    expect(calls[0]!.url.searchParams.get('rvslots')).toBe('main')
    expect(calls[0]!.url.searchParams.get('redirects')).toBe('1')
    expect(pages.size).toBe(120)
    expect(missing).toEqual([])
    expect(pages.get('Module:Map/Point 119.json')).toEqual({ title: 'Module:Map/Point 119.json', revid: 1119, content: '[{"x":119,"y":0}]' })
  })

  it('pages() maps normalized and redirected titles back to the requested title', async () => {
    const fixture = new Map(fixturePages('quests/pages.json').map((p) => [p.title, p]))
    const ratcatcher = fixture.get('Ratcatcher')!
    const dragonSlayer = fixture.get('Dragon Slayer')!
    const { wiki } = client(() =>
      json({
        batchcomplete: true,
        query: {
          normalized: [{ fromencoded: false, from: 'ratcatcher', to: 'Ratcatcher' }, { fromencoded: false, from: 'Dragon_slayer', to: 'Dragon slayer' }],
          redirects: [{ from: 'Dragon slayer', to: 'Dragon Slayer' }],
          pages: [
            { ns: 0, title: 'Nope', missing: true },
            { ns: 0, title: 'Ratcatcher', revisions: [{ revid: ratcatcher.revid, slots: { main: { content: ratcatcher.content } } }] },
            { ns: 0, title: 'Dragon Slayer', revisions: [{ revid: dragonSlayer.revid, slots: { main: { content: dragonSlayer.content } } }] },
          ],
        },
      }),
    )

    const { pages, missing } = await wiki.pages(['ratcatcher', 'Dragon_slayer', 'Nope'])

    expect(missing).toEqual(['Nope'])
    expect(pages.get('ratcatcher')).toEqual(ratcatcher)
    expect(pages.get('Dragon_slayer')).toEqual({ title: 'Dragon Slayer', revid: dragonSlayer.revid, content: dragonSlayer.content })
    expect(pages.get('Dragon_slayer')!.content).toContain('{{Quest details')
  })

  it('revisions() returns the latest revision id per requested title', async () => {
    const { wiki, calls } = client(() =>
      json({
        batchcomplete: true,
        query: {
          normalized: [{ fromencoded: false, from: 'Module:Map/Gold_Ore_Node.json', to: 'Module:Map/Gold Ore Node.json' }],
          pages: [
            { pageid: 1, ns: 828, title: 'Module:Map/Gold Ore Node.json', contentmodel: 'json', lastrevid: 4242, length: 10 },
            { ns: 828, title: 'Module:Map/Gone.json', missing: true },
          ],
        },
      }),
    )

    const revs = await wiki.revisions(['Module:Map/Gold_Ore_Node.json', 'Module:Map/Gone.json'])

    expect([...revs]).toEqual([['Module:Map/Gold_Ore_Node.json', 4242]])
    expect(calls[0]!.url.searchParams.get('prop')).toBe('info')
    expect(calls[0]!.url.searchParams.get('redirects')).toBe('1')
  })

  it('imageUrls() resolves file names in batches of 50', async () => {
    const names = Array.from({ length: 60 }, (_, i) => `Icon_${i}.png`)
    const { wiki, calls } = client((url) => {
      const titles = titlesOf(url)
      return json({
        batchcomplete: true,
        query: {
          normalized: titles.map((t) => ({ fromencoded: false, from: t, to: t.replace(/_/g, ' ') })),
          pages: titles.map((t) => {
            const title = t.replace(/_/g, ' ')
            if (t === 'File:Icon_7.png') return { ns: 6, title, missing: true, known: false }
            return { ns: 6, title, imagerepository: 'local', imageinfo: [{ url: `https://dragonwilds.runescape.wiki/images/${t.slice(5)}?abc` }] }
          }),
        },
      })
    })

    const urls = await wiki.imageUrls(names)

    expect(calls.map((c) => titlesOf(c.url).length)).toEqual([50, 10])
    expect(titlesOf(calls[0]!.url)[0]).toBe('File:Icon_0.png')
    expect(calls[0]!.url.searchParams.get('prop')).toBe('imageinfo')
    expect(calls[0]!.url.searchParams.get('iiprop')).toBe('url')
    expect(urls.size).toBe(59)
    expect(urls.has('Icon_7.png')).toBe(false)
    expect(urls.get('Icon_0.png')).toBe('https://dragonwilds.runescape.wiki/images/Icon_0.png?abc')
    expect(calls[0]!.url.searchParams.has('iiurlwidth')).toBe(false)
  })

  it('imageUrls() with a width prefers the thumbnail URL and falls back to the original', async () => {
    const images = 'https://dragonwilds.runescape.wiki/images/'
    const { wiki, calls } = client((url) => {
      const width = url.searchParams.get('iiurlwidth')
      const titles = titlesOf(url)
      return json({
        batchcomplete: true,
        query: {
          normalized: titles.map((t) => ({ fromencoded: false, from: t, to: t.replace(/_/g, ' ') })),
          pages: titles.map((t) => {
            const file = t.slice('File:'.length)
            const info: Record<string, unknown> = { url: `${images}${file}`, descriptionurl: '' }
            // Big.png is wider than the width; Small.png is not (MediaWiki answers with the original); Odd.png has no thumbnail.
            if (width && file === 'Big.png') Object.assign(info, { thumburl: `${images}thumb/${file}/${width}px-${file}`, thumbwidth: 64, thumbheight: 80 })
            if (width && file === 'Small.png') Object.assign(info, { thumburl: `${images}${file}`, thumbwidth: 32, thumbheight: 32 })
            return { ns: 6, title: t.replace(/_/g, ' '), imagerepository: 'local', imageinfo: [info] }
          }),
        },
      })
    })

    const thumbs = await wiki.imageUrls(['Big.png', 'Small.png', 'Odd.png'], { width: 64 })
    expect(calls[0]!.url.searchParams.get('iiprop')).toBe('url')
    expect(calls[0]!.url.searchParams.get('iiurlwidth')).toBe('64')
    expect([...thumbs]).toEqual([
      ['Big.png', `${images}thumb/Big.png/64px-Big.png`],
      ['Small.png', `${images}Small.png`],
      ['Odd.png', `${images}Odd.png`],
    ])

    const originals = await wiki.imageUrls(['Big.png'])
    expect(calls[1]!.url.searchParams.has('iiurlwidth')).toBe(false)
    expect(originals.get('Big.png')).toBe(`${images}Big.png`)
  })

  it('imageUrls() keeps the original of an SVG, whose thumbnail is a PNG', async () => {
    const images = 'https://dragonwilds.runescape.wiki/images/'
    const infoOf: Record<string, { url: string; thumburl: string }> = {
      // Stored as 'Rune.svg', the PNG thumbnail would be served as SVG and never show.
      'File:Rune.svg': { url: `${images}Rune.svg?1a`, thumburl: `${images}thumb/Rune.svg/64px-Rune.svg.png?1a` },
      'File:Photo.jpeg': { url: `${images}Photo.jpeg?2b`, thumburl: `${images}thumb/Photo.jpeg/64px-Photo.jpg?2b` },
      'File:Ore.png': { url: `${images}Ore.png?3c`, thumburl: `${images}thumb/Ore.png/64px-Ore.png?3c` },
      // 'Old icon.png' redirects to an SVG: stored as '.png', the PNG thumbnail is the right pick.
      'File:New icon.svg': { url: `${images}New_icon.svg?4d`, thumburl: `${images}thumb/New_icon.svg/64px-New_icon.svg.png?4d` },
    }
    const { wiki } = client((url) => {
      const titles = titlesOf(url)
      const normalized = titles.filter((t) => t.includes('_')).map((t) => ({ fromencoded: false, from: t, to: t.replace(/_/g, ' ') }))
      const canonical = titles.map((t) => t.replace(/_/g, ' ')).map((t) => (t === 'File:Old icon.png' ? 'File:New icon.svg' : t))
      return json({
        batchcomplete: true,
        query: {
          normalized,
          redirects: [{ from: 'File:Old icon.png', to: 'File:New icon.svg' }],
          pages: [...new Set(canonical)].map((title) => ({ ns: 6, title, imagerepository: 'local', imageinfo: [infoOf[title]] })),
        },
      })
    })

    const urls = await wiki.imageUrls(['Rune.svg', 'Photo.jpeg', 'Ore.png', 'Old_icon.png'], { width: 64 })
    expect([...urls]).toEqual([
      ['Rune.svg', `${images}Rune.svg?1a`],
      ['Photo.jpeg', `${images}thumb/Photo.jpeg/64px-Photo.jpg?2b`],
      ['Ore.png', `${images}thumb/Ore.png/64px-Ore.png?3c`],
      ['Old_icon.png', `${images}thumb/New_icon.svg/64px-New_icon.svg.png?4d`],
    ])
  })
})

describe('WikiClient: download', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ashenfall-wiki-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes the file and creates missing directories', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const { wiki, calls } = client(() => new Response(png, { headers: { 'content-type': 'image/png' } }))
    const dest = join(dir, '4', '1_16.png')

    await expect(wiki.download('https://maps.runescape.wiki/dw/tiles/4/1_16.png', dest)).resolves.toBe(true)

    expect(new Uint8Array(await readFile(dest))).toEqual(png)
    expect(calls[0]!.headers.Accept).toBe('*/*')
  })

  it('returns false on 404 and writes nothing', async () => {
    const { wiki } = client(() => new Response('Not Found', { status: 404 }))
    const dest = join(dir, '5', '0_0.png')
    await expect(wiki.download('https://maps.runescape.wiki/dw/tiles/5/0_0.png', dest)).resolves.toBe(false)
    await expect(stat(dest)).rejects.toThrow()
  })
})
