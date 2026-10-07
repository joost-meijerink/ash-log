// Listeners on real loopback sockets with free ports: http and https on one port, switching
// certificates, closing with requests in flight. Certificates from tls.ts (node:crypto, no
// openssl) in a temp dir, so this runs on macOS, Windows and Linux. Never binds 5199.

import { mkdtemp, rm } from 'node:fs/promises'
import { Agent as HttpAgent, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TLSSocket } from 'node:tls'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Listeners, TLS_HANDSHAKE_BYTE } from './live.ts'
import { LocalTls, type TlsMaterial } from './tls.ts'

interface Reply {
  status: number
  headers: IncomingMessage['headers']
  text: string
  reused: boolean
  subjectAltName?: string
}

let dir: string
let material: TlsMaterial
let listeners: Listeners | undefined
let logs: string[] = []

/** Echoes protocol, method, path and body length; /slow waits for `release`. */
let release: () => void = () => {}
let slowStarted: () => void = () => {}
function handler(req: IncomingMessage, res: ServerResponse) {
  let length = 0
  req.on('data', (c: Buffer) => (length += c.length))
  req.on('end', async () => {
    if (req.url === '/slow') {
      slowStarted()
      await new Promise<void>((r) => (release = r))
    }
    const protocol = (req.socket as TLSSocket).encrypted ? 'https' : 'http'
    res.end(`${protocol} ${req.method} ${req.url} ${length}`)
  })
}

/** `ca: null` trusts only the system's roots (not Ash Log's CA). */
function call(
  port: number,
  path: string,
  opts: { secure?: boolean; method?: string; body?: string; agent?: HttpAgent | HttpsAgent | false; ca?: string | null } = {},
): Promise<Reply> {
  const secure = opts.secure ?? false
  const send = secure ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    const req = send(
      {
        host: '127.0.0.1',
        port,
        path,
        method: opts.method ?? 'GET',
        agent: opts.agent ?? false,
        ...(secure ? { servername: 'localhost', ...(opts.ca === null ? {} : { ca: opts.ca ?? material.caPem }) } : {}),
      },
      (res) => {
        const subjectAltName = secure ? ((res.socket as TLSSocket).getPeerCertificate().subjectaltname ?? '') : undefined
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8'), reused: req.reusedSocket, subjectAltName }),
        )
      },
    )
    req.on('error', reject)
    if (opts.body !== undefined) req.write(opts.body)
    req.end()
  })
}

async function start(withTls = true): Promise<number> {
  listeners = new Listeners(handler, {
    port: 0,
    loopbackHosts: ['127.0.0.1'],
    log: (l) => logs.push(l),
    ...(withTls ? { tls: { key: material.key, cert: material.cert } } : {}),
  })
  await listeners.start()
  return listeners.port
}

describe('one port, two protocols', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ashenfall-live-'))
    material = await new LocalTls({ dir: join(dir, 'tls') }).ensure({ dns: ['studio.local', 'localhost'], ips: ['127.0.0.1'] })
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  afterEach(async () => {
    release()
    await listeners?.close(1000)
    listeners = undefined
    logs = []
  })

  it('knows a TLS handshake by its first byte', () => {
    expect(TLS_HANDSHAKE_BYTE).toBe(0x16)
  })

  it('answers plain http and https on the same port, bodies and keep-alive included', async () => {
    const port = await start()
    const plainAgent = new HttpAgent({ keepAlive: true, maxSockets: 1 })
    const secureAgent = new HttpsAgent({ keepAlive: true, maxSockets: 1 })
    try {
      const big = 'x'.repeat(300_000)
      const a = await call(port, '/a', { agent: plainAgent })
      const b = await call(port, '/b', { agent: plainAgent, method: 'POST', body: big })
      const c = await call(port, '/c?q=1', { agent: plainAgent })
      expect([a.text, b.text, c.text]).toEqual(['http GET /a 0', 'http POST /b 300000', 'http GET /c?q=1 0'])
      expect([a.reused, b.reused, c.reused]).toEqual([false, true, true])

      const d = await call(port, '/a', { secure: true, agent: secureAgent })
      const e = await call(port, '/b', { secure: true, agent: secureAgent, method: 'PUT', body: big })
      const f = await call(port, '/c', { secure: true, agent: secureAgent })
      expect([d.text, e.text, f.text]).toEqual(['https GET /a 0', 'https PUT /b 300000', 'https GET /c 0'])
      expect([d.reused, e.reused, f.reused]).toEqual([false, true, true])
      expect(d.subjectAltName).toBe('DNS:studio.local, DNS:localhost, IP Address:127.0.0.1')

      // Both side by side, one after the other on fresh connections.
      const mixed = await Promise.all([call(port, '/1'), call(port, '/2', { secure: true }), call(port, '/3'), call(port, '/4', { secure: true })])
      expect(mixed.map((r) => r.text)).toEqual(['http GET /1 0', 'https GET /2 0', 'http GET /3 0', 'https GET /4 0'])
    } finally {
      plainAgent.destroy()
      secureAgent.destroy()
    }
  })

  it('refuses a certificate the client does not trust (it really is TLS)', async () => {
    const port = await start()
    await expect(call(port, '/', { secure: true, ca: null })).rejects.toThrow(/certificate/i)
    expect((await call(port, '/')).status).toBe(200)
  })

  it('closes TLS connections while there is no certificate, and says so once', async () => {
    const port = await start(false)
    expect(listeners!.secureReady).toBe(false)
    await expect(call(port, '/', { secure: true })).rejects.toThrow()
    await expect(call(port, '/', { secure: true })).rejects.toThrow()
    expect(logs.filter((l) => l.includes('no certificate'))).toHaveLength(1)
    expect((await call(port, '/x')).text).toBe('http GET /x 0')

    listeners!.setTls({ key: material.key, cert: material.cert })
    expect(listeners!.secureReady).toBe(true)
    expect((await call(port, '/y', { secure: true })).text).toBe('https GET /y 0')
  })

  it('uses a new certificate for new connections at once', async () => {
    const port = await start()
    const other = await new LocalTls({ dir: join(dir, 'tls-other') }).ensure({ dns: ['other.local', 'localhost'], ips: ['127.0.0.1', '10.0.0.9'] })
    expect((await call(port, '/', { secure: true })).subjectAltName).toContain('studio.local')
    listeners!.setTls({ key: other.key, cert: other.cert })
    const after = await call(port, '/', { secure: true, ca: other.caPem })
    expect(after.subjectAltName).toBe('DNS:other.local, DNS:localhost, IP Address:127.0.0.1, IP Address:10.0.0.9')
  })

  it('survives connections that close or send nothing before the protocol is known', async () => {
    const port = await start()
    await new Promise<void>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => socket.end())
      socket.on('close', () => resolve())
      socket.on('error', reject)
    })
    await new Promise<void>((resolve) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.write(Buffer.from([TLS_HANDSHAKE_BYTE, 0x03]))
        socket.destroy()
        resolve()
      })
    })
    expect((await call(port, '/ok')).text).toBe('http GET /ok 0')
    expect((await call(port, '/ok', { secure: true })).text).toBe('https GET /ok 0')
  })

  for (const secure of [false, true]) {
    it(`lets a running ${secure ? 'https' : 'http'} request finish on close, then refuses connections`, async () => {
      const port = await start()
      const started = new Promise<void>((r) => (slowStarted = r))
      const slow = call(port, '/slow', { secure })
      await started
      let closed = false
      const closing = listeners!.close(3000).then(() => (closed = true))
      await new Promise((r) => setTimeout(r, 50))
      expect(closed).toBe(false)
      release()
      const reply = await slow
      expect(reply.status).toBe(200)
      expect(reply.text).toBe(`${secure ? 'https' : 'http'} GET /slow 0`)
      await closing
      await expect(call(port, '/', { secure })).rejects.toThrow(/ECONNREFUSED/)
      listeners = undefined
    })
  }

  it('closes idle keep-alive connections at once', async () => {
    const port = await start()
    const plainAgent = new HttpAgent({ keepAlive: true })
    const secureAgent = new HttpsAgent({ keepAlive: true })
    try {
      await call(port, '/', { agent: plainAgent })
      await call(port, '/', { secure: true, agent: secureAgent })
      const t0 = Date.now()
      await listeners!.close(3000)
      expect(Date.now() - t0).toBeLessThan(1000)
      listeners = undefined
    } finally {
      plainAgent.destroy()
      secureAgent.destroy()
    }
  })

  it('answers a garbage first byte with 400 and keeps serving', async () => {
    const port = await start()
    const reply = await new Promise<string>((resolve, reject) => {
      let got = ''
      const socket = connect(port, '127.0.0.1', () => socket.write(Buffer.from([0x00, 0xff, 0x13, 0x0d, 0x0a, 0x0d, 0x0a])))
      socket.on('data', (c: Buffer) => (got += c.toString('latin1')))
      socket.on('close', () => resolve(got))
      socket.on('error', reject)
    })
    expect(reply).toMatch(/^HTTP\/1\.1 400/)
    expect((await call(port, '/ok')).text).toBe('http GET /ok 0')
  })

  /**
   * Opens a connection, sends a request line, then one header byte every 50 ms until the
   * server answers; resolves with what came back when it closes. Once connected, errors only
   * end the connection: the server may reset it while a trickled byte is on its way (an RST
   * after the 408, which Windows sends more readily than macOS).
   */
  function trickle(port: number, secure: boolean): Promise<{ text: string; ms: number }> {
    return new Promise((resolve, reject) => {
      const t0 = Date.now()
      let got = ''
      let timer: ReturnType<typeof setInterval> | undefined
      const begin = (socket: import('node:net').Socket) => {
        socket.off('error', reject)
        socket.on('error', () => {})
        socket.write('GET / HTTP/1.1\r\nHost: localhost\r\nX-Slow: ')
        timer = setInterval(() => {
          if (!got && socket.writable) socket.write('x')
        }, 50)
        socket.on('data', (c: Buffer) => {
          got += c.toString('latin1')
          clearInterval(timer)
        })
        socket.on('close', () => {
          clearInterval(timer)
          resolve({ text: got, ms: Date.now() - t0 })
        })
      }
      if (!secure) {
        const socket = connect(port, '127.0.0.1', () => begin(socket))
        socket.on('error', reject)
        return
      }
      void import('node:tls').then(({ connect: tlsConnect }) => {
        const socket = tlsConnect({ port, host: '127.0.0.1', servername: 'localhost', ca: material.caPem }, () => begin(socket))
        socket.on('error', reject)
      })
    })
  }

  for (const secure of [false, true]) {
    it(`cuts off a client that trickles its ${secure ? 'https' : 'http'} headers (slowloris)`, async () => {
      listeners = new Listeners(handler, {
        port: 0,
        loopbackHosts: ['127.0.0.1'],
        tls: { key: material.key, cert: material.cert },
        timeouts: { headersMs: 300, requestMs: 600, checkMs: 100 },
      })
      await listeners.start()
      const { text, ms } = await trickle(listeners.port, secure)
      // The server answers 408 and closes. On Windows the client sometimes sees only the reset
      // that follows (the 408 is discarded with the unread bytes), which still cuts it off.
      if (process.platform === 'win32' && text === '') expect(ms).toBeGreaterThanOrEqual(250)
      else expect(text).toMatch(/^HTTP\/1\.1 408/)
      expect(ms).toBeLessThan(3000)
      expect((await call(listeners.port, '/ok', { secure })).text).toBe(`${secure ? 'https' : 'http'} GET /ok 0`)
    })
  }

  it('drops a connection that never says anything', async () => {
    listeners = new Listeners(handler, { port: 0, loopbackHosts: ['127.0.0.1'], timeouts: { sniffMs: 200 } })
    await listeners.start()
    const port = listeners.port
    const ms = await new Promise<number>((resolve, reject) => {
      const t0 = Date.now()
      const socket = connect(port, '127.0.0.1')
      socket.on('close', () => resolve(Date.now() - t0))
      socket.on('error', reject)
    })
    expect(ms).toBeGreaterThanOrEqual(150)
    expect(ms).toBeLessThan(3000)
  })

  it('does not log a failed handshake from this Mac', async () => {
    const port = await start()
    await expect(call(port, '/', { secure: true, ca: null })).rejects.toThrow()
    await new Promise((r) => setTimeout(r, 100))
    expect(logs.filter((l) => l.startsWith('Secure connection'))).toEqual([])
  })
})
