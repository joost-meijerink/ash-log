// Tests for the shell scripts the macOS app runs (start.sh, stop.sh, status.sh and the shared
// lib.sh). They run against a temporary project with a stand-in server
// (__fixtures__/server.mjs) on a free port, with the bare PATH a Dock app gets.
import { type ChildProcess, spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const DESKTOP_DIR = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(DESKTOP_DIR, '__fixtures__')
const BARE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

interface Result {
  code: number | null
  stdout: string
  stderr: string
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(check: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe.skipIf(process.platform !== 'darwin')('desktop launcher scripts', () => {
  let project: string
  let port: number
  let env: Record<string, string>
  const children: ChildProcess[] = []

  function run(script: string, extra: Record<string, string> = {}): Promise<Result> {
    return runShell([join(DESKTOP_DIR, script)], extra)
  }

  function runShell(args: string[], extra: Record<string, string> = {}): Promise<Result> {
    return new Promise((resolve) => {
      const child = spawn('/bin/sh', args, { env: { ...env, ...extra } })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
      child.on('close', (code) => resolve({ code, stdout, stderr }))
    })
  }

  const pidFile = () => join(project, '.local', 'server.pid')
  const serverPid = () => Number(readFileSync(pidFile(), 'utf8').trim())
  const log = () => readFileSync(join(project, '.local', 'server.log'), 'utf8')
  const health = () =>
    fetch(`http://127.0.0.1:${port}/api/health`).then(
      (r) => r.status,
      () => 0,
    )

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), 'ash-log-launcher-'))
    mkdirSync(join(project, 'server'))
    copyFileSync(join(FIXTURES, 'server.mjs'), join(project, 'server', 'app.mjs'))
    mkdirSync(join(project, 'src'))
    writeFileSync(join(project, 'src', 'main.ts'), '')
    mkdirSync(join(project, 'dist'))
    writeFileSync(join(project, 'dist', 'index.html'), '')
    const past = new Date(Date.now() - 60_000)
    utimesSync(join(project, 'src', 'main.ts'), past, past)
    port = await freePort()
    env = {
      PATH: BARE_PATH,
      HOME: project,
      ASHENFALL_PROJECT_DIR: project,
      ASHENFALL_PORT: String(port),
      ASHENFALL_NODE: process.execPath,
      ASHENFALL_SERVER_ENTRY: 'server/app.mjs',
      ASHENFALL_VITE: join(FIXTURES, 'vite.mjs'),
      FIXTURE_RECORD: join(project, 'stop-requests.jsonl'),
    }
  })

  afterEach(() => {
    if (existsSync(pidFile())) {
      const pid = serverPid()
      if (pid && isAlive(pid)) process.kill(pid, 'SIGKILL')
    }
    for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL')
    rmSync(project, { recursive: true, force: true })
  })

  it('starts the server once, reports it running and stops it cleanly', { timeout: 20_000 }, async () => {
    const first = await run('start.sh')
    expect(first).toMatchObject({ code: 0, stderr: '' })
    const pid = serverPid()
    expect(isAlive(pid)).toBe(true)
    expect(await health()).toBe(200)

    const again = await run('start.sh')
    expect(again.code).toBe(0)
    expect(serverPid()).toBe(pid)
    expect(log().match(/Starting the server/g)).toHaveLength(1)

    expect((await run('status.sh')).code).toBe(0)

    const stop = await run('stop.sh')
    expect(stop).toMatchObject({ code: 0, stderr: '' })
    await waitFor(() => !isAlive(pid))
    expect(existsSync(pidFile())).toBe(false)
    const requests = readFileSync(env.FIXTURE_RECORD, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as unknown)
    expect(requests).toEqual([{ method: 'POST', contentType: 'application/json', body: '{}' }])

    const status = await run('status.sh')
    expect(status.code).toBe(1)
    expect(status.stderr).toContain('not running anymore')
  })

  it('reports a server that exits right away, with its last message', { timeout: 20_000 }, async () => {
    const result = await run('start.sh', { FIXTURE_MODE: 'crash' })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('The server stopped right away: Port 1234 is already in use (fixture).')
    expect(result.stderr).toContain('.local/server.log')
    expect(existsSync(pidFile())).toBe(false)
  })

  it('refuses a port that another program holds', { timeout: 20_000 }, async () => {
    const other = createServer((_req, res) => res.writeHead(404).end())
    await new Promise<void>((r) => other.listen(port, '127.0.0.1', r))
    try {
      const result = await run('start.sh')
      expect(result.code).toBe(1)
      expect(result.stderr).toContain(`Port ${port} is already in use by node (pid ${process.pid})`)
      expect(existsSync(pidFile())).toBe(false)
    } finally {
      await new Promise((r) => other.close(r))
    }
  })

  it('does not take the dev server for the app server, and leaves it alone on stop', { timeout: 20_000 }, async () => {
    let stopRequests = 0
    const dev = createServer((req, res) => {
      if (req.url === '/api/server/stop') stopRequests++
      if (req.url === '/api/health') res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, mode: 'dev' }))
      else res.writeHead(409).end()
    })
    await new Promise<void>((r) => dev.listen(port, '127.0.0.1', r))
    try {
      const start = await run('start.sh')
      expect(start.code).toBe(1)
      expect(start.stderr).toContain(`Port ${port} is already in use by node (pid ${process.pid})`)
      expect((await run('status.sh')).code).toBe(1)
      expect(await run('stop.sh')).toMatchObject({ code: 0, stderr: '' })
      expect(stopRequests).toBe(0)
    } finally {
      await new Promise((r) => dev.close(r))
    }
  })

  it('builds the app when dist is missing or older than the sources', { timeout: 20_000 }, async () => {
    const buildCount = () => Number(readFileSync(join(project, 'dist', 'build-count'), 'utf8'))
    rmSync(join(project, 'dist'), { recursive: true })
    expect((await run('start.sh')).code).toBe(0)
    expect(buildCount()).toBe(1)
    expect((await run('stop.sh')).code).toBe(0)

    // Nothing changed: no build.
    const past = new Date(Date.now() - 30_000)
    utimesSync(join(project, 'dist', 'index.html'), past, past)
    expect((await run('start.sh')).code).toBe(0)
    expect(buildCount()).toBe(1)
    expect((await run('stop.sh')).code).toBe(0)

    // A source file changed after the last build.
    writeFileSync(join(project, 'src', 'main.ts'), 'export {}')
    expect((await run('start.sh')).code).toBe(0)
    expect(buildCount()).toBe(2)
  })

  it('does not rebuild for test files', { timeout: 20_000 }, async () => {
    const past = new Date(Date.now() - 30_000)
    utimesSync(join(project, 'dist', 'index.html'), past, past)
    writeFileSync(join(project, 'src', 'main.test.ts'), '')
    expect((await run('start.sh')).code).toBe(0)
    expect(existsSync(join(project, 'dist', 'build-count'))).toBe(false)
  })

  it('reports a failing build and does not start the server', { timeout: 20_000 }, async () => {
    rmSync(join(project, 'dist'), { recursive: true })
    const result = await run('start.sh', { FIXTURE_BUILD_FAIL: '1' })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Building the app failed')
    expect(log()).toContain('build failed (fixture)')
    expect(existsSync(pidFile())).toBe(false)
    expect(await health()).toBe(0)
  })

  it.skipIf(existsSync('/opt/homebrew/bin/node') || existsSync('/usr/local/bin/node'))(
    'explains what to do when node is gone',
    async () => {
      const result = await run('start.sh', { ASHENFALL_NODE: '/nowhere/bin/node' })
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('Node not found (expected at /nowhere/bin/node)')
      expect(result.stderr).toContain('npm run app:install')
    },
  )

  it('signals the server when it ignores the stop request', { timeout: 20_000 }, async () => {
    expect((await run('start.sh', { FIXTURE_MODE: 'ignore-stop' })).code).toBe(0)
    const pid = serverPid()
    const stop = await run('stop.sh', { ASHENFALL_STOP_TIMEOUT: '1' })
    expect(stop.code).toBe(0)
    await waitFor(() => !isAlive(pid))
    expect(log()).toContain('SIGTERM')
  })

  it('never kills an unrelated process from a stale pid file', { timeout: 20_000 }, async () => {
    const sleeper = spawn('/bin/sleep', ['30'])
    children.push(sleeper)
    mkdirSync(join(project, '.local'))
    writeFileSync(pidFile(), `${sleeper.pid}\n`)
    const stop = await run('stop.sh')
    expect(stop.code).toBe(0)
    expect(isAlive(sleeper.pid!)).toBe(true)
    expect(existsSync(pidFile())).toBe(false)
  })

  describe('port', () => {
    /** Sources lib.sh the way the scripts do and prints the port it settled on. Contacts nothing. */
    const port = (extra: Record<string, string> = {}) => {
      const lib = join(DESKTOP_DIR, 'lib.sh')
      // $0 is lib.sh itself, so lib.sh finds its own folder as it does from a script.
      return runShell(['-c', '. "$1" && printf \'%s\\n\' "$PORT"', lib, lib], extra)
    }

    beforeEach(() => {
      delete env.ASHENFALL_PORT
    })

    it('comes from APP_PORT in .env', async () => {
      writeFileSync(join(project, '.env'), 'WIKI_USER_AGENT="x (y@z)"\nAPP_PORT="5231" # fixed port\n')
      expect(await port()).toMatchObject({ code: 0, stdout: '5231\n' })
    })

    it('defaults to 5199', async () => {
      expect((await port()).stdout).toBe('5199\n')
    })

    it('is the one the app passes, whatever .env says', async () => {
      writeFileSync(join(project, '.env'), 'APP_PORT=5231\n')
      expect((await port({ ASHENFALL_PORT: '5307' })).stdout).toBe('5307\n')
    })

    it('must be a number', async () => {
      writeFileSync(join(project, '.env'), 'APP_PORT=five\n')
      const result = await port()
      expect(result.code).toBe(1)
      expect(result.stderr).toContain("APP_PORT in .env isn't a port number: five")
    })
  })

  it('puts the node the app passes first on PATH, for tools that start with env node', async () => {
    const lib = join(DESKTOP_DIR, 'lib.sh')
    const result = await runShell(['-c', '. "$1" && resolve_node && command -v node', lib, lib])
    expect(result).toMatchObject({ code: 0, stdout: `${process.execPath}\n` })
  })
})
