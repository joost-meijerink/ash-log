// Tests for the Windows launcher (launcher.ts). Three layers:
//   - pure helpers (config, tasklist, dialogs, arguments),
//   - the Windows branches with a stand-in System (platform win32) against a small HTTP server
//     in this process, so tasklist, taskkill, Edge and the dialogs never really run,
//   - whole runs on this machine with a stand-in server (__fixtures__/server.mjs), a stand-in
//     vite and a stand-in browser that holds a Chromium-style profile lock.
import { type ChildProcess, spawn, type SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  browserArgs,
  browserCandidates,
  chromiumProfileLocked,
  closeWindow,
  type Dialog,
  type DialogAnswer,
  displayPath,
  getEnv,
  HANDOFF_MS,
  lastServerMessage,
  LAUNCHER_FILE,
  LauncherError,
  LIVE_QUESTION,
  needsBuild,
  openWindow,
  parseLauncherArgs,
  parseTasklist,
  processImage,
  popupAnswer,
  popupCommand,
  popupFlags,
  POPUP_SCRIPT,
  realSystem,
  resolveConfig,
  resolvePort,
  runLauncher,
  serverPid,
  stopServer,
  type System,
  timestamp,
  watcherCommand,
  watchWindow,
  withDirOnPath,
} from './launcher.ts'

const WINDOWS_DIR = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(WINDOWS_DIR, '__fixtures__')

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

async function waitFor(check: () => boolean, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 50))
  }
}

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

describe('environment helpers', () => {
  it('reads Windows variables without regard to case, and others with it', () => {
    const env = { Path: 'C:\\Windows', LocalAppData: 'C:\\Users\\jan\\AppData\\Local' }
    expect(getEnv(env, 'PATH', 'win32')).toBe('C:\\Windows')
    expect(getEnv(env, 'LOCALAPPDATA', 'win32')).toBe('C:\\Users\\jan\\AppData\\Local')
    expect(getEnv(env, 'PATH', 'darwin')).toBeUndefined()
  })

  it('puts the node folder first on Path, without adding a second PATH on Windows', () => {
    const win = withDirOnPath({ Path: 'C:\\Windows\\System32', Other: 'x' }, 'C:\\Program Files\\nodejs', 'win32')
    expect(win).toEqual({ Path: 'C:\\Program Files\\nodejs;C:\\Windows\\System32', Other: 'x' })
    expect(withDirOnPath({}, 'C:\\node', 'win32')).toEqual({ Path: 'C:\\node' })
    expect(withDirOnPath({ PATH: '/usr/bin' }, '/opt/node/bin', 'darwin')).toEqual({ PATH: '/opt/node/bin:/usr/bin' })
  })
})

describe('resolveConfig', () => {
  let project: string
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'ash log config '))
  })
  afterEach(() => rmSync(project, { recursive: true, force: true }))

  it('takes the port from ASHENFALL_PORT, then APP_PORT, then .env, then 5199', () => {
    expect(resolvePort(project, {})).toBe(5199)
    writeFileSync(join(project, '.env'), '\uFEFFWIKI_USER_AGENT=x\r\nAPP_PORT=5301\r\n')
    expect(resolvePort(project, {})).toBe(5301)
    expect(resolvePort(project, { APP_PORT: '5302' })).toBe(5302)
    expect(resolvePort(project, { app_port: '5303' }, 'win32')).toBe(5303)
    expect(resolvePort(project, { APP_PORT: '5302', ASHENFALL_PORT: '5304' })).toBe(5304)
  })

  it('reads a .env that PowerShell 5.1 wrote as UTF-16', () => {
    writeFileSync(join(project, '.env'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('APP_PORT=5305\r\n', 'utf16le')]))
    expect(resolvePort(project, {})).toBe(5305)
  })

  it('turns a bad port into a launcher error', () => {
    writeFileSync(join(project, '.env'), 'APP_PORT=five\n')
    expect(() => resolveConfig({ projectDir: project, env: {} })).toThrow(LauncherError)
    expect(() => resolveConfig({ projectDir: project, env: {} })).toThrow(/APP_PORT in \.env.*: five/)
  })

  it('builds the Windows paths, the child environment and the timeouts', () => {
    const cfg = resolveConfig({
      projectDir: project,
      platform: 'win32',
      execPath: 'C:\\Program Files\\nodejs\\node.exe',
      env: {
        LOCALAPPDATA: 'C:\\Users\\Jan de Vries\\AppData\\Local',
        Path: 'C:\\Windows\\System32',
        App_Port: '1',
        ASHENFALL_PORT: '5310',
        ASHENFALL_START_TIMEOUT: '12',
        ASHENFALL_STOP_TIMEOUT: 'nope',
      },
    })
    expect(cfg.port).toBe(5310)
    expect(cfg.baseUrl).toBe('http://127.0.0.1:5310')
    expect(cfg.appUrl).toBe('http://localhost:5310/')
    expect(cfg.appDataDir).toBe('C:\\Users\\Jan de Vries\\AppData\\Local\\Ash Log')
    expect(cfg.localDir).toBe(join(project, '.local'))
    expect(cfg.logFile).toBe(join(project, '.local', 'server.log'))
    expect(cfg.pidFile).toBe(join(project, '.local', 'server.pid'))
    expect(cfg.serverEntry).toBe(join(project, 'server', 'app.ts'))
    expect(cfg.vite).toBe(join(project, 'node_modules', 'vite', 'bin', 'vite.js'))
    expect(cfg.startTimeoutMs).toBe(12_000)
    expect(cfg.stopTimeoutMs).toBe(10_000)
    expect(cfg.childEnv.APP_PORT).toBe('5310')
    expect(cfg.childEnv.App_Port).toBeUndefined()
    // dirname of a Windows path on this (POSIX) test machine is '.', which is fine: what counts is that it comes first.
    expect(String(cfg.childEnv.Path)).toMatch(/;C:\\Windows\\System32$/)
    expect(cfg.childEnv.PATH).toBeUndefined()
  })

  it('falls back to the home folder without LOCALAPPDATA and honours ASH_LOG_LOCAL_DIR', () => {
    const cfg = resolveConfig({ projectDir: project, platform: 'win32', homedir: 'C:\\Users\\jan', env: { ASH_LOG_LOCAL_DIR: 'tmp-local' } })
    expect(cfg.appDataDir).toBe('C:\\Users\\jan\\AppData\\Local\\Ash Log')
    expect(cfg.localDir).toBe(join(project, 'tmp-local'))
    expect(displayPath(cfg, cfg.logFile)).toBe(join('tmp-local', 'server.log'))
    expect(displayPath(cfg, '/elsewhere/server.log')).toBe('/elsewhere/server.log')
  })
})

describe('parseTasklist', () => {
  it('finds the image name of exactly that pid', () => {
    const out = '"node.exe","4242","Console","1","45.112 K"\r\n"msedge.exe","42","Console","1","90.000 K"\r\n'
    expect(parseTasklist(out, 4242)).toBe('node.exe')
    expect(parseTasklist(out, 42)).toBe('msedge.exe')
    expect(parseTasklist(out, 424)).toBeNull()
  })

  it('treats the localized no-match notice as nothing', () => {
    expect(parseTasklist('INFO: No tasks are running which match the specified criteria.\r\n', 4242)).toBeNull()
    expect(parseTasklist('INFO: Er worden geen taken uitgevoerd die voldoen aan de opgegeven criteria.\r\n', 4242)).toBeNull()
    expect(parseTasklist('', 4242)).toBeNull()
  })
})

describe('dialogs', () => {
  const env = { SystemRoot: 'C:\\WINDOWS', Path: 'x' }

  it('sets Popup flags for the buttons, the icon, the default button and on top', () => {
    expect(popupFlags({ text: '', kind: 'info', buttons: 'ok' })).toBe(64 + 4096)
    expect(popupFlags({ text: '', kind: 'error', buttons: 'yesno' })).toBe(4 + 16 + 4096)
    expect(popupFlags({ text: '', kind: 'question', buttons: 'yesno', defaultNo: true })).toBe(4 + 32 + 256 + 4096)
  })

  it('runs Windows PowerShell with the text in the environment, never on the command line', () => {
    const text = "Ash Log can't start.\n\n\"C:\\Users\\Jan de Vries\" & %PATH% $(evil)"
    const popup = popupCommand({ text, kind: 'error', buttons: 'yesno', seconds: 4 }, env)
    expect(popup.command).toBe('C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(popup.args).toEqual(['-NoProfile', '-NonInteractive', '-Command', POPUP_SCRIPT])
    expect(popup.args.join(' ')).not.toContain('Jan de Vries')
    expect(popup.env).toMatchObject({ ASH_LOG_DIALOG_TEXT: text, ASH_LOG_DIALOG_SECONDS: '4', ASH_LOG_DIALOG_FLAGS: String(4 + 16 + 4096), Path: 'x' })
    // Node wraps the script in double quotes as one argument; one inside would end it early.
    expect(POPUP_SCRIPT).not.toContain('"')
  })

  it('maps the Popup result', () => {
    expect([6, 7, 1, -1, 4294967295, null].map(popupAnswer)).toEqual(['yes', 'no', 'ok', 'none', 'none', 'none'])
  })
})

describe('chromiumProfileLocked', () => {
  const busy = (code: string) => () => {
    throw Object.assign(new Error(code), { code })
  }
  const fs = (exists: boolean, openForWrite: () => void) => ({ exists: () => exists, openForWrite, lstat: () => ({}) })

  it('on Windows: locked while the browser holds its lockfile', () => {
    expect(chromiumProfileLocked('C:\\p', 'win32', fs(false, () => {}))).toBe(false)
    expect(chromiumProfileLocked('C:\\p', 'win32', fs(true, () => {}))).toBe(false)
    expect(chromiumProfileLocked('C:\\p', 'win32', fs(true, busy('EBUSY')))).toBe(true)
    expect(chromiumProfileLocked('C:\\p', 'win32', fs(true, busy('EPERM')))).toBe(true)
    expect(chromiumProfileLocked('C:\\p', 'win32', fs(true, busy('ENOENT')))).toBe(false)
  })

  it('looks at C:\\...\\lockfile on Windows', () => {
    const seen: string[] = []
    chromiumProfileLocked('C:\\Users\\Jan de Vries\\AppData\\Local\\Ash Log\\edge', 'win32', {
      exists: (path) => (seen.push(path), false),
      openForWrite: () => {},
      lstat: () => ({}),
    })
    expect(seen).toEqual(['C:\\Users\\Jan de Vries\\AppData\\Local\\Ash Log\\edge\\lockfile'])
  })

  it('elsewhere: locked while the SingletonLock symlink exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ash-log-profile-'))
    try {
      expect(chromiumProfileLocked(dir, 'darwin')).toBe(false)
      symlinkSync('host-123', join(dir, 'SingletonLock'))
      expect(chromiumProfileLocked(dir, 'darwin')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('browsers', () => {
  const env = {
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    ProgramFiles: 'C:\\Program Files',
    LOCALAPPDATA: 'C:\\Users\\Jan de Vries\\AppData\\Local',
  }

  it('tries Edge, then Chrome, per machine and per user, ASHENFALL_BROWSER first', () => {
    expect(browserCandidates({ ...env, ASHENFALL_BROWSER: 'D:\\Brave\\brave.exe' }, 'win32').map((b) => `${b.name} ${b.path}`)).toEqual([
      'browser D:\\Brave\\brave.exe',
      'edge C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'edge C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'edge C:\\Users\\Jan de Vries\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe',
      'chrome C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'chrome C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'chrome C:\\Users\\Jan de Vries\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
    ])
    expect(browserCandidates(env, 'darwin')).toEqual([])
  })

  it('opens an app window with a profile of its own', () => {
    expect(browserArgs('http://localhost:5199/', 'C:\\Users\\Jan de Vries\\AppData\\Local\\Ash Log\\edge')).toEqual([
      '--app=http://localhost:5199/',
      '--user-data-dir=C:\\Users\\Jan de Vries\\AppData\\Local\\Ash Log\\edge',
      '--no-first-run',
      '--no-default-browser-check',
    ])
  })
})

describe('parseLauncherArgs', () => {
  it('knows the commands and --gui', () => {
    expect(parseLauncherArgs([])).toEqual({ command: 'open', gui: false })
    expect(parseLauncherArgs(['--gui'])).toEqual({ command: 'open', gui: true })
    expect(parseLauncherArgs(['--no-browser'])).toEqual({ command: 'serve', gui: false })
    expect(parseLauncherArgs(['--gui', '--stop'])).toEqual({ command: 'stop', gui: true })
    expect(parseLauncherArgs(['--status', '--status'])).toEqual({ command: 'status', gui: false })
    expect(parseLauncherArgs(['-h'])).toEqual({ command: 'help', gui: false })
    expect(parseLauncherArgs(['--watch', '--browser=edge', '--browser-pid=4242', '--gui'])).toEqual({
      command: 'watch',
      gui: true,
      browser: 'edge',
      browserPid: 4242,
    })
  })

  it('refuses what it does not know or what does not go together', () => {
    expect(parseLauncherArgs(['--NoBrowser'])).toEqual({ error: 'Unknown option: --NoBrowser' })
    expect(parseLauncherArgs(['--stop=1'])).toHaveProperty('error')
    expect(parseLauncherArgs(['--stop', '--no-browser'])).toHaveProperty('error')
    expect(parseLauncherArgs(['--watch', '--browser=firefox', '--browser-pid=1'])).toHaveProperty('error')
    expect(parseLauncherArgs(['--watch', '--browser=edge'])).toHaveProperty('error')
    expect(parseLauncherArgs(['--browser=edge'])).toHaveProperty('error')
    expect(parseLauncherArgs(['--constructor'])).toHaveProperty('error')
  })
})

describe('watcherCommand', () => {
  it('runs this launcher again with --watch, through tsx, with the same node', () => {
    const cfg = resolveConfig({ env: { ASHENFALL_PORT: '5320' }, execPath: '/opt/node/bin/node' })
    const command = watcherCommand(cfg, 'edge', 4242, true)
    expect(command.command).toBe('/opt/node/bin/node')
    expect(command.args[0]).toBe('--import')
    expect(command.args[1]).toMatch(/^file:\/\/.*tsx/)
    expect(command.args.slice(2)).toEqual([LAUNCHER_FILE, '--watch', '--browser=edge', '--browser-pid=4242', '--gui'])
    expect(watcherCommand(cfg, 'chrome', 7, false).args.slice(-1)).toEqual(['--browser-pid=7'])
  })
})

describe('needsBuild', () => {
  let project: string
  const touch = (path: string, secondsAgo: number) => {
    mkdirSync(dirname(join(project, path)), { recursive: true })
    writeFileSync(join(project, path), '')
    const when = new Date(Date.now() - secondsAgo * 1000)
    utimesSync(join(project, path), when, when)
  }
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'ash-log-build-'))
  })
  afterEach(() => rmSync(project, { recursive: true, force: true }))

  it('builds without dist, or when a source is newer, but not for tests or .DS_Store', () => {
    touch('src/lib/deep/file.ts', 120)
    expect(needsBuild(project)).toBe(true)
    touch('dist/index.html', 60)
    expect(needsBuild(project)).toBe(false)
    touch('src/lib/deep/file.test.ts', 10)
    touch('src/.DS_Store', 10)
    expect(needsBuild(project)).toBe(false)
    touch('src/components/New.vue', 10)
    expect(needsBuild(project)).toBe(true)
    touch('dist/index.html', 0)
    touch('package.json', -5)
    expect(needsBuild(project)).toBe(true)
  })
})

describe('log helpers', () => {
  it('stamps like the server does', () => {
    expect(timestamp(new Date(2026, 8, 28, 16, 5, 2))).toBe('2026-09-28 16:05:02')
  })

  it('picks the last line that reads like a message, after the offset', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ash-log-log-'))
    const file = join(dir, 'server.log')
    try {
      const before = "[2026-09-28 16:05:12] Starting the server\nYesterday's old error\n"
      writeFileSync(
        file,
        before +
          'Port 5199 is in use by another program.\r\n' +
          '    at Server.listen (node:net:1)\r\n\r\n' +
          '[2026-09-28 16:05:13] ERROR: something\n' +
          'Node.js v24.15.0\n',
      )
      expect(lastServerMessage(file, Buffer.byteLength(before))).toBe('Port 5199 is in use by another program.')
      expect(lastServerMessage(file, 1e6)).toBe('')
      expect(lastServerMessage(join(dir, 'missing.log'), 0)).toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/* ------------------------------------------------------------------ */
/* Windows branches, with a stand-in System                            */
/* ------------------------------------------------------------------ */

interface AppState {
  healthy: boolean
  live: boolean
  stops: number
  /** Called after a stop request was answered. */
  onStop?: () => void
}

/** A stand-in for the app server in this process: health, status and stop. */
async function startApp(state: AppState): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (!state.healthy) return json(503, { error: 'weg' })
    if (req.method === 'GET' && req.url === '/api/health') return json(200, { ok: true, mode: 'app' })
    if (req.method === 'GET' && req.url === '/api/server') return json(200, { mode: 'app', local: true, live: state.live, port: 0, urls: [] })
    if (req.method === 'POST' && req.url === '/api/server/stop' && /^application\/json/.test(String(req.headers['content-type']))) {
      req.resume()
      req.on('end', () => {
        state.stops++
        json(202, { ok: true })
        state.healthy = false
        state.onStop?.()
      })
      return
    }
    json(404, {})
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return { server, port: typeof address === 'object' && address ? address.port : 0 }
}

class FakeChild extends EventEmitter {
  exitCode: number | null = null
  signalCode: string | null = null
  unrefed = false
  pid: number | undefined
  constructor(pid: number | undefined) {
    super()
    this.pid = pid
    setImmediate(() => (pid === undefined ? this.emit('error', new Error('ENOENT')) : this.emit('spawn')))
  }
  unref() {
    this.unrefed = true
  }
}

interface FakeWindows extends System {
  spawns: { command: string; args: readonly string[]; options: SpawnOptions; child: FakeChild }[]
  runs: { command: string; args: readonly string[] }[]
  dialogs: Dialog[]
  alive: Set<number>
  images: Map<number, string>
  files: Set<string>
  locked: Set<string>
  answers: DialogAnswer[]
  clock: number
  lines: string[]
}

function fakeWindows(): FakeWindows {
  let nextPid = 4000
  const sys: FakeWindows = {
    platform: 'win32',
    pid: 1234,
    spawns: [],
    runs: [],
    dialogs: [],
    alive: new Set(),
    images: new Map(),
    files: new Set(),
    locked: new Set(),
    answers: [],
    clock: 0,
    lines: [],
    spawn(command, args, options) {
      const child = new FakeChild(nextPid++)
      sys.spawns.push({ command, args, options, child })
      return child as unknown as ChildProcess
    },
    async run(command, args) {
      sys.runs.push({ command, args })
      if (command.endsWith('tasklist.exe')) {
        const pid = Number(String(args[1]).replace('PID eq ', ''))
        const image = sys.alive.has(pid) ? sys.images.get(pid) : undefined
        return { code: 0, stdout: image ? `"${image}","${pid}","Console","1","1.000 K"\r\n` : 'INFO: no tasks\r\n' }
      }
      if (command.endsWith('taskkill.exe')) {
        sys.alive.delete(Number(args[1]))
        return { code: 0, stdout: '' }
      }
      return { code: 1, stdout: '' }
    },
    isAlive: (pid) => sys.alive.has(pid),
    profileLocked: (dir) => sys.locked.has(dir),
    exists: (path) => sys.files.has(path),
    async sleep(ms) {
      sys.clock += ms
      await new Promise((r) => setTimeout(r, 1))
    },
    now: () => sys.clock,
    async dialog(dialog) {
      sys.dialogs.push(dialog)
      return sys.answers.shift() ?? 'none'
    },
    out: (line) => sys.lines.push(line),
    err: (line) => sys.lines.push(`ERR ${line}`),
  }
  return sys
}

describe('on Windows (stand-in system)', () => {
  let project: string
  let app: { server: Server; port: number }
  let state: AppState
  let sys: FakeWindows
  const SERVER_PID = 777
  const winEnv = (port: number) => ({
    SystemRoot: 'C:\\WINDOWS',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    ProgramFiles: 'C:\\Program Files',
    LOCALAPPDATA: 'C:\\Users\\Jan de Vries\\AppData\\Local',
    ASHENFALL_PORT: String(port),
    ASHENFALL_STOP_TIMEOUT: '2',
  })
  const config = () => resolveConfig({ projectDir: project, platform: 'win32', env: winEnv(app.port), execPath: 'C:\\Program Files\\nodejs\\node.exe' })
  const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  const EDGE_PROFILE = 'C:\\Users\\Jan de Vries\\AppData\\Local\\Ash Log\\edge'

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), 'ash log win '))
    state = { healthy: true, live: false, stops: 0 }
    app = await startApp(state)
    sys = fakeWindows()
    // The server process: alive, running node.exe, gone once it was asked to stop.
    sys.alive.add(SERVER_PID)
    sys.images.set(SERVER_PID, 'node.exe')
    state.onStop = () => sys.alive.delete(SERVER_PID)
    mkdirSync(join(project, '.local'))
    writeFileSync(join(project, '.local', 'server.pid'), `${SERVER_PID}\r\n`)
  })

  afterEach(async () => {
    await new Promise((resolve) => app.server.close(resolve))
    rmSync(project, { recursive: true, force: true })
  })

  it('finds the server pid only when tasklist says it runs node.exe', async () => {
    const cfg = config()
    expect(await serverPid(cfg, sys)).toBe(SERVER_PID)
    expect(sys.runs[0]).toEqual({ command: 'C:\\WINDOWS\\System32\\tasklist.exe', args: ['/FI', `PID eq ${SERVER_PID}`, '/FO', 'CSV', '/NH'] })
    sys.images.set(SERVER_PID, 'msedge.exe')
    expect(await serverPid(cfg, sys)).toBeNull()
    sys.alive.delete(SERVER_PID)
    expect(await serverPid(cfg, sys)).toBeNull()
  })

  it('stops the server by asking it, without taskkill when it leaves in time', async () => {
    expect(await stopServer(config(), sys)).toBe('stopped')
    expect(state.stops).toBe(1)
    expect(sys.runs.filter((r) => r.command.endsWith('taskkill.exe'))).toEqual([])
    expect(existsSync(join(project, '.local', 'server.pid'))).toBe(false)
  })

  it('ends a server that does not leave with taskkill /T /F, after the stop timeout', async () => {
    state.onStop = () => {
      state.healthy = false // answers no more, but the process stays
    }
    expect(await stopServer(config(), sys)).toBe('stopped')
    expect(sys.clock).toBeGreaterThanOrEqual(2000)
    expect(sys.runs.filter((r) => r.command.endsWith('taskkill.exe'))).toEqual([
      { command: 'C:\\WINDOWS\\System32\\taskkill.exe', args: ['/PID', String(SERVER_PID), '/T', '/F'] },
    ])
  })

  it('says so when nothing runs, and fails with a clear message when the server keeps answering', async () => {
    state.healthy = false
    sys.alive.delete(SERVER_PID)
    expect(await stopServer(config(), sys)).toBe('not-running')

    state.healthy = true
    state.onStop = () => {
      state.healthy = true // a server that ignores the request and survives taskkill
    }
    sys.alive.add(SERVER_PID)
    await expect(stopServer(config(), sys)).rejects.toThrow(/won't stop\. Stop it yourself, for example in Task Manager \(process Node\.js JavaScript Runtime\)/)
  })

  it('opens Edge as an app window with its own profile, and leaves a watcher behind', async () => {
    sys.files.add(EDGE)
    const cfg = config()
    await openWindow(cfg, sys, { gui: true })
    expect(sys.spawns).toHaveLength(2)
    const [browser, watcher] = sys.spawns
    expect(browser!.command).toBe(EDGE)
    expect(browser!.args).toEqual(['--app=' + cfg.appUrl, `--user-data-dir=${EDGE_PROFILE}`, '--no-first-run', '--no-default-browser-check'])
    // Detached, so it is not ended with this launcher; never windowsHide, which would hide its window.
    expect(browser!.options).toEqual({ detached: true, stdio: 'ignore' })
    expect(browser!.child.unrefed).toBe(true)

    expect(watcher!.command).toBe('C:\\Program Files\\nodejs\\node.exe')
    expect(watcher!.args.slice(2)).toEqual([LAUNCHER_FILE, '--watch', '--browser=edge', `--browser-pid=${browser!.child.pid}`, '--gui'])
    expect(watcher!.options).toMatchObject({ cwd: project, detached: true, stdio: 'ignore', windowsHide: true })
    expect(watcher!.options.env).toMatchObject({ APP_PORT: String(app.port) })
    expect(readFileSync(join(project, '.local', 'window.pid'), 'utf8').trim()).toBe(String(browser!.child.pid))
  })

  it('opens one more window in a browser that already runs, without a second watcher', async () => {
    sys.files.add('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
    sys.locked.add('C:\\Users\\Jan de Vries\\AppData\\Local\\Ash Log\\chrome')
    await openWindow(config(), sys, { gui: false })
    expect(sys.spawns.map((s) => s.command)).toEqual(['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'])
    expect(existsSync(join(project, '.local', 'window.pid'))).toBe(false)
  })

  it('falls back to the default browser and says how to stop', async () => {
    await openWindow(config(), sys, { gui: true })
    expect(sys.spawns.map((s) => [s.command, s.args])).toEqual([['C:\\WINDOWS\\explorer.exe', [config().appUrl]]])
    expect(sys.dialogs).toEqual([expect.objectContaining({ kind: 'info', buttons: 'ok', text: expect.stringContaining('Stop Ash Log in the Start menu') })])
  })

  it('reports a browser that will not start', async () => {
    sys.files.add(EDGE)
    sys.spawn = (command, args, options) => {
      const child = new FakeChild(undefined)
      sys.spawns.push({ command, args, options, child })
      return child as unknown as ChildProcess
    }
    await expect(openWindow(config(), sys, { gui: false })).rejects.toThrow(/Microsoft Edge couldn't start: ENOENT/)
  })

  describe('the watcher', () => {
    const BROWSER = 4321
    const watch = (gui = true) => watchWindow(config(), sys, { browser: 'edge', browserPid: BROWSER, gui })
    /** The browser holds its profile for `ms` of the fake clock, then exits. */
    const browserFor = (ms: number, lock = true) => {
      sys.alive.add(BROWSER)
      if (lock) sys.locked.add(EDGE_PROFILE)
      const sleep = sys.sleep
      sys.sleep = async (step) => {
        await sleep(step)
        if (sys.clock >= ms) {
          sys.locked.delete(EDGE_PROFILE)
          sys.alive.delete(BROWSER)
        }
      }
    }

    it('stops the server when the window closes, without asking while Live is off', async () => {
      writeFileSync(join(project, '.local', 'window.pid'), `${BROWSER}\n`)
      browserFor(3000)
      await watch()
      expect(state.stops).toBe(1)
      expect(sys.dialogs).toEqual([])
      expect(existsSync(join(project, '.local', 'window.pid'))).toBe(false)
    })

    it('asks first with Live on Wi-Fi on, and keeps the server on Yes', async () => {
      state.live = true
      sys.answers.push('yes')
      browserFor(3000)
      await watch()
      expect(sys.dialogs).toEqual([{ kind: 'question', buttons: 'yesno', defaultNo: true, text: LIVE_QUESTION }])
      expect(state.stops).toBe(0)
    })

    it('stops on No, and without a dialog when there is no --gui', async () => {
      state.live = true
      sys.answers.push('no')
      browserFor(3000)
      await watch()
      expect(state.stops).toBe(1)

      state.healthy = true
      sys.alive.add(SERVER_PID)
      writeFileSync(join(project, '.local', 'server.pid'), `${SERVER_PID}\n`)
      sys.clock = 0
      sys.dialogs.length = 0
      browserFor(3000)
      await watch(false)
      expect(sys.dialogs).toEqual([])
      expect(state.stops).toBe(2)
    })

    it('leaves the server alone when the browser only handed the window to one that already ran', async () => {
      browserFor(1000, false)
      await watch()
      expect(sys.clock).toBeLessThan(HANDOFF_MS)
      expect(state.stops).toBe(0)
    })

    it('without a lock file, follows the browser process itself', async () => {
      browserFor(HANDOFF_MS + 3000, false)
      await watch()
      expect(state.stops).toBe(1)
    })

    it('does nothing when the server is gone already (stopped with Stop Ash Log)', async () => {
      state.healthy = false
      browserFor(3000)
      await watch()
      expect(state.stops).toBe(0)
      expect(sys.dialogs).toEqual([])
    })
  })

  it('closes the window of window.pid with taskkill without /F, only when it is a browser', async () => {
    const cfg = config()
    writeFileSync(cfg.windowPidFile, '4321\n')
    sys.alive.add(4321)
    sys.images.set(4321, 'node.exe')
    expect(await closeWindow(cfg, sys)).toBe(false)
    expect(sys.runs.filter((r) => r.command.endsWith('taskkill.exe'))).toEqual([])

    writeFileSync(cfg.windowPidFile, '4321\n')
    sys.images.set(4321, 'msedge.exe')
    expect(await closeWindow(cfg, sys)).toBe(true)
    expect(sys.runs.filter((r) => r.command.endsWith('taskkill.exe'))).toEqual([{ command: 'C:\\WINDOWS\\System32\\taskkill.exe', args: ['/PID', '4321'] }])
    expect(existsSync(cfg.windowPidFile)).toBe(false)
  })

  it('--stop --gui stops, closes the window and says so in a dialog that closes itself', async () => {
    writeFileSync(join(project, '.local', 'window.pid'), '4321\n')
    sys.alive.add(4321)
    sys.images.set(4321, 'msedge.exe')
    const code = await runLauncher(['--stop', '--gui'], { sys, config: { projectDir: project, env: winEnv(app.port), execPath: 'C:\\node.exe' } })
    expect(code).toBe(0)
    expect(state.stops).toBe(1)
    expect(sys.alive.has(4321)).toBe(false)
    expect(sys.dialogs).toEqual([{ kind: 'info', buttons: 'ok', seconds: 4, text: 'Ash Log has stopped.' }])
  })

  it('reports a failed start in a dialog that offers the log in Notepad', async () => {
    state.healthy = false
    sys.alive.clear()
    sys.answers.push('yes')
    const code = await runLauncher(['--gui'], { sys, config: { projectDir: project, env: winEnv(app.port), execPath: 'C:\\node.exe' } })
    expect(code).toBe(1)
    expect(sys.dialogs).toHaveLength(1)
    expect(sys.dialogs[0]).toMatchObject({ kind: 'error', buttons: 'yesno' })
    expect(sys.dialogs[0]!.text).toMatch(/^Ash Log can't start\.\n\nServer not found: .*app\.ts\n\nOpen the log file\?$/)
    expect(sys.spawns.map((s) => [s.command, s.args])).toEqual([['C:\\WINDOWS\\System32\\notepad.exe', [join(project, '.local', 'server.log')]]])
    expect(readFileSync(join(project, '.local', 'server.log'), 'utf8')).toMatch(/\] ERROR: Server not found/)
  })

  it('prints the usage for an unknown option', async () => {
    expect(await runLauncher(['-NoBrowser'], { sys })).toBe(2)
    expect(sys.lines[0]).toBe('ERR Unknown option: -NoBrowser')
  })
})

/* ------------------------------------------------------------------ */
/* Whole runs on this machine                                          */
/* ------------------------------------------------------------------ */

describe.skipIf(process.platform === 'win32')('whole runs with a stand-in server', () => {
  let project: string
  let local: string
  let port: number
  let env: NodeJS.ProcessEnv
  let lines: string[]

  /** realSystem, with its output captured and its own pid when given. */
  function system(pid = process.pid): System {
    return { ...realSystem(), pid, out: (line) => lines.push(line), err: (line) => lines.push(`ERR ${line}`) }
  }
  const launch = (args: string[], extra: NodeJS.ProcessEnv = {}, sys = system()) =>
    runLauncher(args, { sys, config: { projectDir: project, env: { ...env, ...extra } } })
  const pidFile = () => join(local, 'server.pid')
  const log = () => readFileSync(join(local, 'server.log'), 'utf8')
  const health = () =>
    fetch(`http://127.0.0.1:${port}/api/health`).then(
      (r) => r.status,
      () => 0,
    )

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), 'ash log run '))
    local = join(project, 'local state')
    mkdirSync(join(project, 'server'))
    writeFileSync(join(project, 'server', 'app.mjs'), readFileSync(join(FIXTURES, 'server.mjs')))
    mkdirSync(join(project, 'src'))
    writeFileSync(join(project, 'src', 'main.ts'), '')
    mkdirSync(join(project, 'dist'))
    writeFileSync(join(project, 'dist', 'index.html'), '')
    const past = new Date(Date.now() - 60_000)
    utimesSync(join(project, 'src', 'main.ts'), past, past)
    port = await freePort()
    lines = []
    env = {
      PATH: process.env.PATH,
      HOME: project,
      LOCALAPPDATA: join(project, 'appdata'),
      ASH_LOG_LOCAL_DIR: local,
      ASHENFALL_PORT: String(port),
      ASHENFALL_SERVER_ENTRY: join('server', 'app.mjs'),
      ASHENFALL_VITE: join(FIXTURES, 'vite.mjs'),
      ASHENFALL_START_TIMEOUT: '10',
      ASHENFALL_STOP_TIMEOUT: '2',
      FIXTURE_RECORD: join(project, 'stop-requests.jsonl'),
    }
  })

  afterEach(() => {
    const pid = existsSync(pidFile()) ? Number(readFileSync(pidFile(), 'utf8').trim()) : 0
    if (pid && isAlive(pid)) process.kill(pid, 'SIGKILL')
    rmSync(project, { recursive: true, force: true })
  })

  it('starts the server once, reports it and stops it cleanly', { timeout: 20_000 }, async () => {
    expect(await launch(['--no-browser'])).toBe(0)
    expect(lines).toEqual(['Starting Ash Log...', `Ash Log is running at http://localhost:${port}/`])
    const pid = Number(readFileSync(pidFile(), 'utf8').trim())
    expect(isAlive(pid)).toBe(true)
    expect(await health()).toBe(200)

    expect(await launch(['--no-browser'])).toBe(0)
    expect(Number(readFileSync(pidFile(), 'utf8').trim())).toBe(pid)
    expect(log().match(/Starting the server/g)).toHaveLength(1)
    // The server's own output lands in the log too.
    expect(log()).toContain(`fixture server on port ${port}`)

    expect(await launch(['--status'])).toBe(0)
    lines = []
    expect(await launch(['--stop'])).toBe(0)
    expect(lines).toEqual(['Ash Log has stopped.'])
    await waitFor(() => !isAlive(pid))
    expect(existsSync(pidFile())).toBe(false)
    const requests = readFileSync(String(env.FIXTURE_RECORD), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as unknown)
    expect(requests).toEqual([{ method: 'POST', contentType: 'application/json', body: '{}' }])

    lines = []
    expect(await launch(['--status'])).toBe(1)
    expect(lines).toEqual(['ERR The server is not running.'])
    expect(await launch(['--stop'])).toBe(0)
    expect(lines.at(-1)).toBe("Ash Log wasn't running.")
  })

  it('reports a server that stops right away, with its last message', { timeout: 20_000 }, async () => {
    expect(await launch(['--no-browser'], { FIXTURE_MODE: 'crash' })).toBe(1)
    expect(lines.at(-1)).toBe(
      `ERR The server stopped right away: Port 1234 is in use by another program (fixture). See ${join('local state', 'server.log')} for what went wrong.`,
    )
    expect(existsSync(pidFile())).toBe(false)
  })

  it('builds first when the sources are newer, and reports a failed build', { timeout: 20_000 }, async () => {
    writeFileSync(join(project, 'src', 'main.ts'), 'export {}')
    // Later than dist/index.html for sure: Linux stamps files with a coarse clock, so a write right
    // after beforeEach can carry the same time.
    const later = new Date(Date.now() + 60_000)
    utimesSync(join(project, 'src', 'main.ts'), later, later)
    expect(await launch(['--no-browser'], { FIXTURE_BUILD_FAIL: '1' })).toBe(1)
    expect(lines.at(-1)).toMatch(/^ERR Building the app failed\. See .*server\.log for what went wrong\.$/)
    expect(log()).toContain('build failed (fixture)')

    lines = []
    expect(await launch(['--no-browser'])).toBe(0)
    expect(lines).toContain('Building the app, this takes a moment...')
    expect(readFileSync(join(project, 'dist', 'build-count'), 'utf8')).toBe('1')
  })

  it('ends a server that accepts the stop request but keeps running', { timeout: 20_000 }, async () => {
    expect(await launch(['--no-browser'], { FIXTURE_MODE: 'ignore-stop' })).toBe(0)
    const pid = Number(readFileSync(pidFile(), 'utf8').trim())
    expect(await launch(['--stop'])).toBe(0)
    expect(isAlive(pid)).toBe(false)
    expect(log()).toMatch(/Ending the server \(pid \d+\)/)
  })

  it('starts one server when two launchers start at the same moment', { timeout: 20_000 }, async () => {
    // Two launchers in this process: give them pids of their own that both live.
    const [a, b] = await Promise.all([launch(['--no-browser'], {}, system(process.pid)), launch(['--no-browser'], {}, system(process.ppid))])
    expect([a, b]).toEqual([0, 0])
    expect(log().match(/Starting the server/g)).toHaveLength(1)
    expect(existsSync(join(local, 'launcher.lock'))).toBe(false)
  })

  it('opens the window, and the watcher stops the server once it closes', { timeout: 30_000 }, async () => {
    // A stand-in browser: holds a Chromium-style SingletonLock in its profile until 'close' appears.
    const browser = join(project, 'fake browser.sh')
    const closeFile = join(project, 'close')
    writeFileSync(
      browser,
      [
        '#!/bin/sh',
        'for arg in "$@"; do case $arg in --user-data-dir=*) dir=${arg#--user-data-dir=} ;; --app=*) url=${arg#--app=} ;; esac; done',
        'mkdir -p "$dir"',
        // A second start hands its window to the browser that runs (as Chromium does) and exits.
        '[ -L "$dir/SingletonLock" ] && { echo "$url" >> "$dir/handed-off"; exit 0; }',
        'ln -s "host-$$" "$dir/SingletonLock"',
        'echo "$url" > "$dir/opened"',
        // Also ends when the test removed the project (a failed test must not leave it running).
        `while [ ! -f "${closeFile}" ] && [ -d "$dir" ]; do sleep 0.1; done`,
        'rm -f "$dir/SingletonLock"',
      ].join('\n'),
    )
    chmodSync(browser, 0o755)
    const profile = join(project, 'appdata', 'Ash Log', 'browser')

    expect(await launch([], { ASHENFALL_BROWSER: browser })).toBe(0)
    const serverPidNow = Number(readFileSync(pidFile(), 'utf8').trim())
    await waitFor(() => existsSync(join(profile, 'opened')))
    expect(readFileSync(join(profile, 'opened'), 'utf8').trim()).toBe(`http://localhost:${port}/`)
    expect(existsSync(join(local, 'window.pid'))).toBe(true)

    // Opening it again gives one more window in the running browser, and keeps the server.
    expect(await launch([], { ASHENFALL_BROWSER: browser })).toBe(0)
    await waitFor(() => existsSync(join(profile, 'handed-off')))
    expect(log().match(/Starting the server/g)).toHaveLength(1)

    // Wait well past the handoff window, so the watcher has surely seen the lock.
    await new Promise((r) => setTimeout(r, 1500))
    expect(isAlive(serverPidNow)).toBe(true)
    writeFileSync(closeFile, '')
    await waitFor(() => !isAlive(serverPidNow) && log().includes('Server stopped'), 15_000)
    expect(log()).toContain('Window closed, stopping the server')
    expect(existsSync(join(local, 'window.pid'))).toBe(false)
  })
})

describe('the launcher script', () => {
  it('is an entry point that prints its usage', () => {
    const child = spawn(process.execPath, ['--import', 'tsx', LAUNCHER_FILE, '--help'], { cwd: join(WINDOWS_DIR, '..', '..') })
    let out = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    return new Promise<void>((resolve, reject) => {
      child.on('error', reject)
      child.on('close', (code) => {
        try {
          expect(code).toBe(0)
          expect(out).toContain('--no-browser')
          resolve()
        } catch (err) {
          reject(err as Error)
        }
      })
    })
  }, 20_000)

  it('hands Windows PowerShell a plain ASCII script', () => {
    // It travels on the command line, where Windows PowerShell may read it in the ANSI code page.
    expect(POPUP_SCRIPT).toMatch(/^[\x20-\x7e]+$/)
  })
})

describe('processImage on Linux and macOS', () => {
  function unix(platform: NodeJS.Platform, answers: Record<string, string>): System {
    return {
      ...fakeWindows(),
      platform,
      async run(command: string) {
        return command in answers ? { code: 0, stdout: answers[command]! } : { code: 1, stdout: '' }
      },
    }
  }

  it('reads the program from ps', async () => {
    expect(await processImage(42, unix('darwin', { ps: '/opt/node/bin/node\n' }), {})).toBe('node')
  })

  it('looks past the MainThread name Node 24 gives its main thread on Linux', async () => {
    expect(await processImage(42, unix('linux', { ps: 'MainThread\n', readlink: '/usr/local/bin/node\n' }), {})).toBe('node')
  })

  it('keeps MainThread when /proc cannot say more', async () => {
    expect(await processImage(42, unix('linux', { ps: 'MainThread\n' }), {})).toBe('MainThread')
  })
})
