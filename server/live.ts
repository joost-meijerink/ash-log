// The app server's sockets. Off (the default at every start): loopback only, so only this
// computer can reach it. Live: every interface, so a phone on the same Wi-Fi can.
//
// One port for both protocols. Each listener is a plain TCP server that looks at the first
// byte of a connection: 0x16 starts a TLS handshake (the ClientHello) and goes to the https
// server, anything else to the http server. Both share the same request handler. So the
// computer keeps using http://localhost:<port> while phones use https://<name or address>:<port>.
//
// On Windows the first live switch makes Windows Defender Firewall ask whether Node.js may
// accept connections; only 'Private networks' needs a tick. Loopback never asks.

import { createServer as createHttpServer, type IncomingMessage, type RequestListener, type Server as HttpServer, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { createServer as createNetServer, type AddressInfo, type Server as NetServer, type Socket } from 'node:net'
import { computerNoun, serverPlatform } from '../src/lib/platform.ts'
import { isLoopback, normalizeAddress } from './net.ts'

export const LOOPBACK_HOSTS = ['127.0.0.1', '::1']
export const LIVE_HOSTS = ['0.0.0.0', '::']

/** First byte of a TLS record that carries a handshake message (the ClientHello). */
export const TLS_HANDSHAKE_BYTE = 0x16
/** A connection that sends nothing this long is dropped before it reaches http or https. */
export const SNIFF_TIMEOUT_MS = 10_000
export const TLS_HANDSHAKE_TIMEOUT_MS = 10_000
/** A connection without any traffic this long is closed. */
export const IDLE_TIMEOUT_MS = 2 * 60 * 1000
/**
 * Request headers must be complete this long after a request starts, the whole request body
 * within REQUEST_TIMEOUT_MS; otherwise 408 and the connection closes. Stops a client that
 * trickles its headers byte by byte (the idle timeout alone never fires for it).
 */
export const HEADERS_TIMEOUT_MS = 20_000
export const REQUEST_TIMEOUT_MS = 60_000
/** How often Node checks those two. */
const CONNECTIONS_CHECK_MS = 5_000
/** Failed handshakes are logged at most this often per address. */
const TLS_ERROR_LOG_MS = 10 * 60 * 1000

/** The port is taken by another program (EADDRINUSE). */
export class PortInUseError extends Error {
  constructor(
    readonly port: number,
    readonly host: string,
  ) {
    super(`Port ${port} is already in use (${host})`)
  }
}

export interface TlsCredentials {
  key: string
  cert: string
}

const isIpv6 = (host: string) => host.includes(':')
/** A missing IPv6 stack is not fatal: the server then runs on IPv4 alone. */
const IPV6_UNAVAILABLE = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EPROTONOSUPPORT'])

interface Bound {
  host: string
  server: NetServer
  sockets: Set<Socket>
}

/** One TCP connection, whichever protocol it speaks. */
interface Conn {
  /** Requests on it that have not finished. */
  inflight: number
  /** Its listener was retired: finish what runs, then close. */
  closing: boolean
}

/** A connection's four-tuple: the same for the TCP socket and the TLS socket on top of it. */
const tupleOf = (s: Socket) => `${s.localAddress}|${s.localPort}|${s.remoteAddress}|${s.remotePort}`

/** Overrides of the timeouts above, for tests. */
export interface ListenerTimeouts {
  sniffMs?: number
  headersMs?: number
  requestMs?: number
  checkMs?: number
}

/**
 * The http and https servers never listen themselves (the TCP listeners hand them their
 * sockets), and Node only starts the timer that enforces headersTimeout and requestTimeout
 * on 'listening'. Start it here, or a slow-trickling client could hold a connection forever.
 * The timer is unref'd; closeRequestTimers stops it.
 */
function startRequestTimers(server: HttpServer | HttpsServer, t: ListenerTimeouts) {
  server.timeout = IDLE_TIMEOUT_MS
  server.headersTimeout = t.headersMs ?? HEADERS_TIMEOUT_MS
  server.requestTimeout = t.requestMs ?? REQUEST_TIMEOUT_MS
  ;(server as { connectionsCheckingInterval?: number }).connectionsCheckingInterval = t.checkMs ?? CONNECTIONS_CHECK_MS
  server.emit('listening')
}

/** Stops the timer startRequestTimers started (close() on a server that never listened). */
function closeRequestTimers(server: HttpServer | HttpsServer) {
  server.close(() => {})
}

/**
 * Reads the first byte of a paused socket and puts it back, so the server it is handed to
 * reads the connection from the start. Calls back once, never when the socket ends first.
 */
export function sniffFirstByte(socket: Socket, onByte: (byte: number) => void): void {
  const attempt = () => {
    if (socket.destroyed) return
    const chunk = socket.read(1) as Buffer | null
    if (chunk === null) {
      if (!socket.readableEnded) socket.once('readable', attempt)
      return
    }
    socket.unshift(chunk)
    onByte(chunk[0]!)
  }
  attempt()
}

export interface ListenersOptions {
  /** 0 picks a free port on the first bind (tests); every other address then uses the same one. */
  port: number
  log?: (line: string) => void
  loopbackHosts?: string[]
  liveHosts?: string[]
  /** Server key and certificate. Without them, TLS connections are closed at once. */
  tls?: TlsCredentials
  timeouts?: ListenerTimeouts
  /** process.platform, for log lines that name the computer ('this Mac', 'this PC'). */
  platform?: string
}

export class Listeners {
  port: number
  live = false
  private bound: Bound[] = []
  /** Listeners that stopped accepting but still finish requests on open connections. */
  private retired = new Set<Bound>()
  private readonly handler: RequestListener
  private readonly plain: HttpServer
  private secure: HttpsServer | null = null
  private readonly conns = new Map<string, Conn>()
  private readonly log: (line: string) => void
  private readonly loopbackHosts: string[]
  private readonly liveHosts: string[]
  private switching: Promise<unknown> = Promise.resolve()
  private warnedNoTls = false
  private readonly tlsErrorsLogged = new Map<string, number>()
  private readonly timeouts: ListenerTimeouts
  /** 'Mac', 'PC' or 'computer'. */
  private readonly computer: string

  constructor(handler: RequestListener, opts: ListenersOptions) {
    this.handler = handler
    this.port = opts.port
    this.log = opts.log ?? (() => {})
    this.loopbackHosts = opts.loopbackHosts ?? LOOPBACK_HOSTS
    this.liveHosts = opts.liveHosts ?? LIVE_HOSTS
    this.timeouts = opts.timeouts ?? {}
    this.computer = computerNoun(serverPlatform(opts.platform ?? process.platform))
    this.plain = createHttpServer((req, res) => this.track(req, res))
    startRequestTimers(this.plain, this.timeouts)
    if (opts.tls) this.setTls(opts.tls)
  }

  /** TLS connections are accepted (a certificate is set). */
  get secureReady(): boolean {
    return this.secure !== null
  }

  /** Sets or replaces the server certificate. New connections use it at once. */
  setTls(credentials: TlsCredentials): void {
    if (this.secure) {
      this.secure.setSecureContext({ key: credentials.key, cert: credentials.cert })
      return
    }
    const secure = createHttpsServer(
      { key: credentials.key, cert: credentials.cert, minVersion: 'TLSv1.2', handshakeTimeout: TLS_HANDSHAKE_TIMEOUT_MS },
      (req, res) => this.track(req, res),
    )
    startRequestTimers(secure, this.timeouts)
    secure.on('tlsClientError', (err: NodeJS.ErrnoException, socket: Socket) => this.onTlsError(err, socket))
    this.secure = secure
  }

  /** Addresses listened on now, as host:port (for tests and logs). */
  addresses(): string[] {
    return this.bound.map((b) => {
      const info = b.server.address() as AddressInfo | null
      return info ? `${isIpv6(info.address) ? `[${info.address}]` : info.address}:${info.port}` : b.host
    })
  }

  /** Starts on loopback. Throws PortInUseError when another program holds the port. */
  async start(): Promise<void> {
    this.bound = await this.bindAll(this.loopbackHosts)
    this.live = false
  }

  /**
   * Switches between loopback only and every interface. On failure (the port is taken on the
   * network) it stays on, or returns to, loopback and returns the error message.
   */
  setLive(on: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
    const run = () => this.switchTo(on)
    const next = this.switching.then(run, run)
    this.switching = next.catch(() => {})
    return next
  }

  /**
   * The old sockets close first (on Linux a wildcard and a loopback bind on one port clash).
   * Rejects only when not even loopback can be bound again: the server is then unreachable.
   */
  private async switchTo(on: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
    if (on === this.live || this.bound.length === 0) return { ok: true }
    this.retire(this.bound)
    this.bound = []
    if (!on) {
      this.bound = await this.bindAll(this.loopbackHosts)
      this.live = false
      return { ok: true }
    }
    try {
      this.bound = await this.bindAll(this.liveHosts)
      this.live = true
      return { ok: true }
    } catch (err) {
      const message = err instanceof PortInUseError ? `Port ${this.port} is already in use on the network` : (err as Error).message
      this.log(`Couldn't turn on Live: ${message}. Ash Log stays on this ${this.computer} only.`)
      this.bound = await this.bindAll(this.loopbackHosts)
      this.live = false
      return { ok: false, error: message }
    }
  }

  /**
   * Stops listening and waits for open requests to finish, at most `timeoutMs`; then drops
   * whatever connection is left.
   */
  async close(timeoutMs = 5000): Promise<void> {
    await this.switching
    this.retire(this.bound)
    this.bound = []
    // Every retired listener still has to emit 'close' (it leaves the set when it does); a
    // TCP server does so once its last connection is gone.
    const all = [...this.retired]
    const closed = all.map((b) => new Promise<void>((r) => b.server.once('close', () => r())))
    const done = Promise.all(closed).then(() => true)
    const timer = new Promise<boolean>((r) => setTimeout(() => r(false), timeoutMs).unref())
    if (!(await Promise.race([done, timer]))) {
      for (const b of all) for (const socket of b.sockets) socket.destroy()
      await done
    }
    closeRequestTimers(this.plain)
    if (this.secure) closeRequestTimers(this.secure)
  }

  /**
   * Stops accepting on these listeners. Requests already running (such as the one that asked
   * for the switch) finish and their connection closes after them; idle connections close at
   * once, and connections from the network are dropped at once, so a phone cannot keep using
   * an open connection after live mode went off.
   */
  private retire(list: Bound[]) {
    for (const b of list) {
      if (!b.server.listening) continue
      this.retired.add(b)
      b.server.once('close', () => this.retired.delete(b))
      b.server.close()
      for (const socket of b.sockets) {
        const conn = this.conns.get(tupleOf(socket))
        if (!isLoopback(socket.remoteAddress) || !conn || conn.inflight === 0) socket.destroy()
        else conn.closing = true
      }
    }
  }

  /** Counts running requests per connection, so a retired listener knows which ones are idle. */
  private track(req: IncomingMessage, res: ServerResponse) {
    const conn = this.conns.get(tupleOf(req.socket))
    if (conn) {
      conn.inflight++
      if (conn.closing) res.setHeader('Connection', 'close')
      res.once('close', () => {
        conn.inflight--
        // end(), not destroy(): the response may still be on its way out.
        if (conn.closing && conn.inflight === 0) req.socket.end()
      })
    }
    this.handler(req, res)
  }

  private accept(bound: Bound, socket: Socket) {
    const key = tupleOf(socket)
    const conn: Conn = { inflight: 0, closing: false }
    bound.sockets.add(socket)
    this.conns.set(key, conn)
    socket.once('close', () => {
      bound.sockets.delete(socket)
      if (this.conns.get(key) === conn) this.conns.delete(key)
    })
    // A reset before the protocol is known must not crash the server; http and tls add their own handlers.
    socket.on('error', () => {})
    const onTimeout = () => socket.destroy()
    socket.setTimeout(this.timeouts.sniffMs ?? SNIFF_TIMEOUT_MS, onTimeout)
    sniffFirstByte(socket, (byte) => {
      socket.setTimeout(0)
      socket.off('timeout', onTimeout)
      if (byte !== TLS_HANDSHAKE_BYTE) {
        this.plain.emit('connection', socket)
      } else if (this.secure) {
        this.secure.emit('connection', socket)
      } else {
        if (!this.warnedNoTls) this.log('Refused an https connection: there is no certificate (yet)')
        this.warnedNoTls = true
        socket.destroy()
      }
    })
  }

  /**
   * A handshake that failed. A TLS alert (ERR_SSL_*) from a phone usually means it does not
   * trust the certificate yet: logged now and then per address. Resets and timeouts, and
   * anything from this computer, are not worth a line.
   */
  private onTlsError(err: NodeJS.ErrnoException, socket: Socket) {
    const remote = socket.remoteAddress
    socket.destroy()
    if (!remote || isLoopback(remote) || !String(err.code ?? '').startsWith('ERR_SSL_')) return
    const address = normalizeAddress(remote)
    const now = Date.now()
    if (now - (this.tlsErrorsLogged.get(address) ?? 0) < TLS_ERROR_LOG_MS) return
    if (this.tlsErrorsLogged.size > 100) this.tlsErrorsLogged.clear()
    this.tlsErrorsLogged.set(address, now)
    this.log(`Secure connection with ${address} failed (${err.code ?? err.message}). Does that device trust the Ash Log certificate yet?`)
  }

  private async bindAll(hosts: string[]): Promise<Bound[]> {
    const bound: Bound[] = []
    for (const host of hosts) {
      try {
        bound.push(await this.bind(host))
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? ''
        if (isIpv6(host) && IPV6_UNAVAILABLE.has(code)) {
          this.log(`No IPv6 on ${host}, carrying on with IPv4`)
          continue
        }
        for (const b of bound) b.server.close()
        if (code === 'EADDRINUSE') throw new PortInUseError(this.port, host)
        throw err
      }
    }
    return bound
  }

  private bind(host: string): Promise<Bound> {
    const sockets = new Set<Socket>()
    const server = createNetServer({ pauseOnConnect: true, noDelay: true })
    const bound: Bound = { host, server, sockets }
    server.on('connection', (socket: Socket) => this.accept(bound, socket))
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen({ port: this.port, host, ipv6Only: isIpv6(host) }, () => {
        server.off('error', reject)
        server.on('error', (err) => this.log(`Server error on ${host}: ${err.message}`))
        if (this.port === 0) this.port = (server.address() as AddressInfo).port
        resolve(bound)
      })
    })
  }
}
