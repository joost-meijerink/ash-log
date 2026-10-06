// Smoke test for the app server (server/app.ts), for CI on Windows, macOS and Linux.
//
// Starts the real server as `npm run app:serve` would (Node with tsx's loader, one process) on
// a free port, with its machine-local state (paired devices, certificate, pid file) in a temp
// folder via ASH_LOG_LOCAL_DIR, never in .local. Then checks:
// - /api/health answers, and /api/server says live is off;
// - only loopback listens: the computer's own LAN addresses refuse the connection;
// - reading data creates neither data/progress.json nor data/overrides.json;
// - POST /api/server/stop ends the process cleanly (exit code 0, pid file removed).
// Starts no browser and no sync, switches nothing on, never touches port 5199.
//
// Usage: node .github/scripts/smoke-app.mjs   (after npm ci; no build needed)

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { request } from 'node:http'
import { createRequire } from 'node:module'
import { connect, createServer } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const RESERVED_PORT = 5199
const START_TIMEOUT_MS = 90_000
const STOP_TIMEOUT_MS = 20_000

const steps = []
const ok = (line) => {
  steps.push(line)
  console.log(`ok   ${line}`)
}

/** A free TCP port on loopback, never the real app's 5199. */
async function freePort() {
  for (;;) {
    const port = await new Promise((done, fail) => {
      const probe = createServer()
      probe.once('error', fail)
      probe.listen(0, '127.0.0.1', () => {
        const { port } = probe.address()
        probe.close(() => done(port))
      })
    })
    if (port !== RESERVED_PORT) return port
  }
}

/** One HTTP request to the server on loopback, with the Host header the server expects. */
function call(port, method, path, body) {
  return new Promise((done, fail) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        agent: false,
        timeout: 10_000,
        headers: { host: `127.0.0.1:${port}`, ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) },
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json
          try {
            json = JSON.parse(text)
          } catch {
            json = undefined
          }
          done({ status: res.statusCode, json, text })
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error(`${method} ${path}: geen antwoord`)))
    req.on('error', fail)
    req.end(payload)
  })
}

/** 'refused' when nothing listens on address:port, 'open' when something accepts. */
function probe(address, port) {
  return new Promise((done) => {
    const socket = connect({ host: address, port, timeout: 3000 })
    socket.once('connect', () => {
      socket.destroy()
      done('open')
    })
    socket.once('timeout', () => {
      socket.destroy()
      done('timeout')
    })
    socket.once('error', (err) => done(err.code === 'ECONNREFUSED' ? 'refused' : `error ${err.code}`))
  })
}

/** This computer's own non-loopback IPv4 addresses. */
function ownAddresses() {
  const out = []
  for (const list of Object.values(networkInterfaces())) {
    for (const info of list ?? []) if (info.family === 'IPv4' && !info.internal && !info.address.startsWith('169.254.')) out.push(info.address)
  }
  return [...new Set(out)]
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** Like sleep, for a Promise.race deadline: does not keep the script alive once the race is won. */
const raceTimeout = (ms) => new Promise((r) => setTimeout(r, ms).unref())

function fileState(path) {
  try {
    const info = statSync(path)
    return `${info.size}:${info.mtimeMs}`
  } catch {
    return 'missing'
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function main() {
  const port = await freePort()
  const localDir = mkdtempSync(join(tmpdir(), 'ash-log-smoke-'))
  const userFiles = [join(ROOT, 'data', 'progress.json'), join(ROOT, 'data', 'overrides.json')]
  const before = userFiles.map(fileState)

  const loader = pathToFileURL(createRequire(join(ROOT, 'package.json')).resolve('tsx')).href
  const output = []
  const child = spawn(process.execPath, ['--import', loader, join(ROOT, 'server', 'app.ts')], {
    cwd: ROOT,
    env: { ...process.env, APP_PORT: String(port), ASH_LOG_LOCAL_DIR: localDir },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.on('data', (c) => output.push(c.toString('utf8')))
  child.stderr.on('data', (c) => output.push(c.toString('utf8')))
  const exited = new Promise((done) => child.once('exit', (code, signal) => done({ code, signal })))
  let exitInfo = null
  void exited.then((info) => (exitInfo = info))

  try {
    // 1. It starts and answers on loopback.
    const deadline = Date.now() + START_TIMEOUT_MS
    let health = null
    while (Date.now() < deadline) {
      if (exitInfo) throw new Error(`server stopte tijdens het starten (code ${exitInfo.code}, signaal ${exitInfo.signal})`)
      health = await call(port, 'GET', '/api/health').catch(() => null)
      if (health?.status === 200) break
      await sleep(250)
    }
    assert(health?.status === 200 && health.json?.ok === true && health.json?.mode === 'app', `geen gezonde server op poort ${port}: ${health?.status} ${health?.text}`)
    ok(`GET /api/health op 127.0.0.1:${port}`)

    // 2. Live is off at start.
    const server = await call(port, 'GET', '/api/server')
    assert(server.status === 200, `GET /api/server gaf ${server.status}`)
    assert(server.json.live === false && server.json.local === true && Array.isArray(server.json.urls) && server.json.urls.length === 0, `live staat niet uit: ${server.text}`)
    ok('live staat uit bij de start')

    // 3. Only loopback listens: the LAN addresses refuse.
    const addresses = ownAddresses()
    if (!addresses.length) ok('geen LAN-adres op deze machine, alleen-loopback niet extra gecontroleerd')
    for (const address of addresses) {
      const result = await probe(address, port)
      assert(result !== 'open', `${address}:${port} neemt verbindingen aan terwijl live uit staat`)
      ok(`${address}:${port} weigert (${result})`)
    }

    // 4. Reading creates no per-user files.
    assert((await call(port, 'GET', '/api/data')).status === 200, 'GET /api/data mislukt')
    assert((await call(port, 'GET', '/api/progress')).status === 200, 'GET /api/progress mislukt')
    const after = userFiles.map(fileState)
    assert(JSON.stringify(before) === JSON.stringify(after), `lezen veranderde progress.json of overrides.json: ${before} -> ${after}`)
    ok(`lezen laat progress.json en overrides.json met rust (${after.join(', ')})`)

    // 5. A clean stop on request.
    const stop = await call(port, 'POST', '/api/server/stop', {})
    assert(stop.status === 202, `POST /api/server/stop gaf ${stop.status}: ${stop.text}`)
    const result = await Promise.race([exited, raceTimeout(STOP_TIMEOUT_MS).then(() => null)])
    assert(result, `server stopte niet binnen ${STOP_TIMEOUT_MS / 1000} s`)
    assert(result.code === 0, `server stopte met code ${result.code} (signaal ${result.signal})`)
    assert(!existsSync(join(localDir, 'server.pid')), 'pid-bestand bleef staan')
    ok('POST /api/server/stop: netjes gestopt, code 0, pid-bestand weg')
  } catch (err) {
    console.error(`FOUT ${err.message}`)
    console.error('--- serveruitvoer ---')
    console.error(output.join('') || '(niets)')
    if (!exitInfo) child.kill()
    process.exitCode = 1
  } finally {
    if (!exitInfo) {
      await Promise.race([exited, raceTimeout(5000)])
      if (!exitInfo) child.kill('SIGKILL')
    }
    rmSync(localDir, { recursive: true, force: true })
  }
  if (!process.exitCode) {
    console.log('--- serveruitvoer ---')
    console.log(output.join('').trimEnd())
    console.log(`\nRooktest geslaagd: ${steps.length} stappen`)
  }
}

await main()
