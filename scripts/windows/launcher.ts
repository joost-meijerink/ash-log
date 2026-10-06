/**
 * Ash Log on Windows: what the Mac app does with its Dock icon, start.sh and stop.sh
 * (scripts/desktop), for the Start menu shortcuts that `npm run app:install` makes (install.ts).
 *
 *   (no flag)       start the app server unless it already answers (building the app first when
 *                   the sources changed), then open Ash Log in its own window: Microsoft Edge
 *                   in app mode with a profile of its own, else Chrome, else the default browser
 *   --no-browser    only start the server; exit 0 once it answers (CI, debugging)
 *   --stop          stop the server and close the window (the 'Stop Ash Log' shortcut)
 *   --status        exit 0 while the server answers
 *   --gui           also report in dialogs, not only on stderr (the shortcuts pass it)
 *
 *   node --import tsx scripts/windows/launcher.ts [flag]
 *
 * Life cycle, as on the Mac: one server on a fixed port (APP_PORT from .env, default 5199),
 * running in the background without a console window and logging to .local/server.log. Live on
 * Wi-Fi is off after every start. Closing the window stops the server: on Windows nothing else
 * (like the Mac's Dock icon) would show that it still runs. With Live on Wi-Fi on, closing the
 * window asks first, because a phone may still be using it. Opening Ash Log while it runs opens
 * one more window. A server that was already running (npm run app) stops too, as on the Mac.
 *
 * No console window stays open: the shortcut runs node.exe minimized, and this process exits
 * once the server answers and the window is open. The waiting for the window to close happens
 * in a copy of this script (--watch) that runs detached, without a console. A shortcut to a
 * hidden PowerShell would not do: Windows Terminal, the default console of Windows 11, ignores
 * -WindowStyle Hidden (https://github.com/microsoft/terminal/issues/12464).
 *
 * The window is a browser of its own: Edge or Chrome with --app and --user-data-dir under
 * %LOCALAPPDATA%\Ash Log, so it runs as a separate process next to your normal browser, and its
 * lock file tells when the last window of it closed.
 *
 * Overrides (tests, CI): ASHENFALL_PORT, ASHENFALL_START_TIMEOUT and ASHENFALL_STOP_TIMEOUT
 * (seconds), ASHENFALL_SERVER_ENTRY (relative to the project), ASHENFALL_VITE (the vite CLI
 * script), ASHENFALL_BROWSER (a Chromium-based browser .exe) and ASH_LOG_LOCAL_DIR (instead of
 * .local, see server/config.ts). APP_PORT in the environment wins over .env, like the server's.
 */
import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from 'node:child_process'
import {
  appendFileSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { request as httpRequestNode } from 'node:http'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, posix, relative, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { localDir, parsePort } from '../../server/config.ts'
import { decodeEnvText, parseEnvText } from '../sync/env.ts'
import { isEntryPoint, nodeTsCommand, type NodeCommand } from '../sync/node-command.ts'

export const LAUNCHER_FILE = fileURLToPath(import.meta.url)
export const PROJECT_DIR = resolve(dirname(LAUNCHER_FILE), '..', '..')

/** The folder under %LOCALAPPDATA% with the browser profiles of the window. */
export const APP_DATA_NAME = 'Ash Log'
const MAX_LOG_BYTES = 1024 * 1024
/** A browser that exits this soon without ever holding its profile lock handed the window to one that already ran. */
export const HANDOFF_MS = 5000
const WATCH_INTERVAL_MS = 1000

export const USAGE = [
  'Usage: node --import tsx scripts/windows/launcher.ts [option]',
  '  (no option)     start the server and open Ash Log in its own window',
  '  --no-browser    only start the server',
  '  --stop          stop the server and close the window',
  '  --status        exit 0 while the server runs',
  '  --gui           also show messages in a dialog',
].join('\n')

/** A problem the user can act on, for the dialog and stderr. */
export class LauncherError extends Error {}

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

export interface LauncherConfig {
  platform: NodeJS.Platform
  projectDir: string
  localDir: string
  logFile: string
  /** Written by the launcher right after it starts the server, and by the server itself. */
  pidFile: string
  /** Pid of the browser that shows the window, so --stop can close it. */
  windowPidFile: string
  /** Held while one launcher starts the server, so a double click starts it once. */
  startLockFile: string
  port: number
  /** Where the launcher talks to the server: always IPv4 loopback. */
  baseUrl: string
  /** What the window shows: the same address the Mac app uses. */
  appUrl: string
  /** The node binary that runs the server, the build and the watcher. */
  node: string
  /** The server entry, absolute. A .ts entry runs with tsx's loader. */
  serverEntry: string
  /** The vite CLI script, absolute. */
  vite: string
  startTimeoutMs: number
  stopTimeoutMs: number
  /** %LOCALAPPDATA%\Ash Log: the browser profiles of the window. */
  appDataDir: string
  /** The environment of this launcher (browser candidates, system folders). */
  env: NodeJS.ProcessEnv
  /** The environment of the server, the build and the watcher: APP_PORT set, node first on PATH. */
  childEnv: NodeJS.ProcessEnv
}

export interface ConfigOptions {
  projectDir?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  execPath?: string
  homedir?: string
}

/** A variable from `env`, without regard to case on Windows (a copy of process.env is case-sensitive). */
export function getEnv(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform !== 'win32') return env[name]
  if (env[name] !== undefined) return env[name]
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase())
  return key === undefined ? undefined : env[key]
}

/** `env` with `dir` first on PATH (whatever the case of that variable on Windows). */
export function withDirOnPath(env: NodeJS.ProcessEnv, dir: string, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const result = { ...env }
  const windows = platform === 'win32'
  const key = windows ? (Object.keys(result).find((k) => k.toUpperCase() === 'PATH') ?? 'Path') : 'PATH'
  const current = result[key]
  result[key] = current ? `${dir}${windows ? ';' : ':'}${current}` : dir
  return result
}

/** Names and values in a .env file: UTF-8 with or without BOM, or UTF-16 (scripts/sync/env.ts). Empty when missing. */
function readEnvFile(file: string): Record<string, string> {
  let bytes: Buffer
  try {
    bytes = readFileSync(file)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
  return parseEnvText(decodeEnvText(bytes))
}

/** ASHENFALL_PORT, else APP_PORT from the environment, else APP_PORT from .env, else 5199. */
export function resolvePort(projectDir: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): number {
  const fromEnv = getEnv(env, 'ASHENFALL_PORT', platform)?.trim() || getEnv(env, 'APP_PORT', platform)?.trim()
  return parsePort(fromEnv || readEnvFile(join(projectDir, '.env')).APP_PORT)
}

function seconds(value: string | undefined, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : fallback * 1000
}

export function resolveConfig(opts: ConfigOptions = {}): LauncherConfig {
  const platform = opts.platform ?? process.platform
  const env = opts.env ?? process.env
  const projectDir = opts.projectDir ?? PROJECT_DIR
  const node = opts.execPath ?? process.execPath
  const get = (name: string) => getEnv(env, name, platform)
  let port: number
  try {
    port = resolvePort(projectDir, env, platform)
  } catch (err) {
    throw new LauncherError((err as Error).message)
  }
  const local = localDir({ ASH_LOG_LOCAL_DIR: get('ASH_LOG_LOCAL_DIR') }, projectDir)
  const pathFor = platform === 'win32' ? win32 : posix
  const localAppData = get('LOCALAPPDATA') || pathFor.join(opts.homedir ?? homedir(), 'AppData', 'Local')
  const entry = get('ASHENFALL_SERVER_ENTRY') || join('server', 'app.ts')
  const vite = get('ASHENFALL_VITE') || join(projectDir, 'node_modules', 'vite', 'bin', 'vite.js')
  const childEnv = withDirOnPath(env, dirname(node), platform)
  // The variable may exist as App_Port or so on Windows: replace it, never add a second one.
  for (const key of Object.keys(childEnv)) if (key.toUpperCase() === 'APP_PORT') delete childEnv[key]
  childEnv.APP_PORT = String(port)
  return {
    platform,
    projectDir,
    localDir: local,
    logFile: join(local, 'server.log'),
    pidFile: join(local, 'server.pid'),
    windowPidFile: join(local, 'window.pid'),
    startLockFile: join(local, 'launcher.lock'),
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    appUrl: `http://localhost:${port}/`,
    node,
    serverEntry: isAbsolute(entry) ? entry : join(projectDir, entry),
    vite: isAbsolute(vite) ? vite : join(projectDir, vite),
    startTimeoutMs: seconds(get('ASHENFALL_START_TIMEOUT'), 30),
    stopTimeoutMs: seconds(get('ASHENFALL_STOP_TIMEOUT'), 10),
    appDataDir: pathFor.join(localAppData, APP_DATA_NAME),
    env,
    childEnv,
  }
}

/** A path for messages: relative to the project when it is inside it (.local\server.log). */
export function displayPath(cfg: LauncherConfig, file: string): string {
  const rel = relative(cfg.projectDir, file)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : file
}

/* ------------------------------------------------------------------ */
/* The system: processes, files, time, dialogs                         */
/* ------------------------------------------------------------------ */

export interface RunResult {
  code: number | null
  stdout: string
}

export interface Dialog {
  text: string
  kind: 'error' | 'question' | 'info'
  buttons: 'ok' | 'yesno'
  /** No is the default button. */
  defaultNo?: boolean
  /** Closes by itself after this many seconds (0: stays until answered). */
  seconds?: number
}

export type DialogAnswer = 'yes' | 'no' | 'ok' | 'none'

/** Everything the launcher does to the outside world, so the tests can stand in for Windows. */
export interface System {
  platform: NodeJS.Platform
  pid: number
  spawn(command: string, args: readonly string[], options: SpawnOptions): ChildProcess
  /** Runs a console tool hidden (tasklist, taskkill, ps) and collects its stdout. */
  run(command: string, args: readonly string[], options?: { env?: NodeJS.ProcessEnv }): Promise<RunResult>
  isAlive(pid: number): boolean
  /** True while a browser runs with this profile folder. */
  profileLocked(profileDir: string): boolean
  exists(path: string): boolean
  sleep(ms: number): Promise<void>
  now(): number
  dialog(dialog: Dialog, env: NodeJS.ProcessEnv): Promise<DialogAnswer>
  out(line: string): void
  err(line: string): void
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: it exists, it just is not ours to signal.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** C:\Windows (SystemRoot), for absolute paths of the system tools. */
export function systemRoot(env: NodeJS.ProcessEnv): string {
  return getEnv(env, 'SystemRoot', 'win32') || getEnv(env, 'windir', 'win32') || 'C:\\Windows'
}

export function system32(env: NodeJS.ProcessEnv, file: string): string {
  return win32.join(systemRoot(env), 'System32', file)
}

export function powershellPath(env: NodeJS.ProcessEnv): string {
  return win32.join(systemRoot(env), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

interface LockFs {
  exists(path: string): boolean
  /** Opens the file for writing and closes it again; throws when another process holds it. */
  openForWrite(path: string): void
  lstat(path: string): unknown
}

const realLockFs: LockFs = {
  exists: existsSync,
  openForWrite: (path) => closeSync(openSync(path, 'r+')),
  lstat: (path) => lstatSync(path),
}

/**
 * True while a Chromium-based browser runs with this profile. On Windows it holds the file
 * 'lockfile' in the profile open without letting others write to it, and deletes it on exit
 * (Chromium's ProcessSingleton); on macOS and Linux it keeps a SingletonLock symlink.
 */
export function chromiumProfileLocked(profileDir: string, platform: NodeJS.Platform, fs: LockFs = realLockFs): boolean {
  if (platform !== 'win32') {
    try {
      fs.lstat(join(profileDir, 'SingletonLock'))
      return true
    } catch {
      return false
    }
  }
  const lockfile = win32.join(profileDir, 'lockfile')
  if (!fs.exists(lockfile)) return false
  try {
    fs.openForWrite(lockfile)
    return false
  } catch (err) {
    return ['EBUSY', 'EPERM', 'EACCES'].includes((err as NodeJS.ErrnoException).code ?? '')
  }
}

/* Dialogs: WScript.Shell's Popup from Windows PowerShell, which every Windows 10 and 11 has. */

const POPUP_BUTTONS = { ok: 0, yesno: 4 } as const
const POPUP_ICONS = { error: 16, question: 32, info: 64 } as const
const POPUP_DEFAULT_SECOND = 256
/** On top of other windows, also when the launcher has none of its own. */
const POPUP_TOPMOST = 4096

export function popupFlags(dialog: Dialog): number {
  let flags = POPUP_BUTTONS[dialog.buttons] + POPUP_ICONS[dialog.kind] + POPUP_TOPMOST
  if (dialog.buttons === 'yesno' && dialog.defaultNo) flags += POPUP_DEFAULT_SECOND
  return flags
}

/**
 * The text travels in an environment variable, so no quoting on the command line can break it.
 * No double quotes in the script: Node quotes the argument as a whole.
 */
export const POPUP_SCRIPT =
  "$shell = New-Object -ComObject WScript.Shell; exit $shell.Popup($env:ASH_LOG_DIALOG_TEXT, [int]$env:ASH_LOG_DIALOG_SECONDS, 'Ash Log', [int]$env:ASH_LOG_DIALOG_FLAGS)"

export function popupCommand(dialog: Dialog, env: NodeJS.ProcessEnv): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  return {
    command: powershellPath(env),
    args: ['-NoProfile', '-NonInteractive', '-Command', POPUP_SCRIPT],
    env: {
      ...env,
      ASH_LOG_DIALOG_TEXT: dialog.text,
      ASH_LOG_DIALOG_SECONDS: String(dialog.seconds ?? 0),
      ASH_LOG_DIALOG_FLAGS: String(popupFlags(dialog)),
    },
  }
}

/** Popup returns 6 for Yes, 7 for No, 1 for OK and -1 when it closed by itself. */
export function popupAnswer(code: number | null): DialogAnswer {
  if (code === 6) return 'yes'
  if (code === 7) return 'no'
  if (code === 1) return 'ok'
  return 'none'
}

function runHidden(command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv } = {}): Promise<RunResult> {
  return new Promise((resolveRun) => {
    let stdout = ''
    let child: ChildProcess
    try {
      child = nodeSpawn(command, args, { env: options.env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    } catch {
      resolveRun({ code: null, stdout: '' })
      return
    }
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    child.on('error', () => resolveRun({ code: null, stdout }))
    child.on('close', (code) => resolveRun({ code, stdout }))
  })
}

export function realSystem(platform: NodeJS.Platform = process.platform): System {
  return {
    platform,
    pid: process.pid,
    spawn: (command, args, options) => nodeSpawn(command, args, options),
    run: runHidden,
    isAlive,
    profileLocked: (dir) => chromiumProfileLocked(dir, platform),
    exists: existsSync,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    async dialog(dialog, env) {
      if (platform !== 'win32') return 'none'
      const popup = popupCommand(dialog, env)
      return popupAnswer((await runHidden(popup.command, popup.args, { env: popup.env })).code)
    },
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  }
}

/* ------------------------------------------------------------------ */
/* Log, pid files                                                      */
/* ------------------------------------------------------------------ */

/** Local time as 2026-09-28 16:05:12, the stamp the server and the Mac scripts write too. */
export function timestamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** Appends a timestamped line to the server log. Never fails the launcher. */
export function log(cfg: LauncherConfig, line: string): void {
  try {
    mkdirSync(cfg.localDir, { recursive: true })
    appendFileSync(cfg.logFile, `[${timestamp()}] ${line}\n`)
  } catch {
    // No log is no reason to stop.
  }
}

function logSize(cfg: LauncherConfig): number {
  try {
    return statSync(cfg.logFile).size
  } catch {
    return 0
  }
}

/** Keeps one previous log instead of letting it grow forever. */
export function rotateLog(cfg: LauncherConfig): void {
  try {
    if (statSync(cfg.logFile).size > MAX_LOG_BYTES) renameSync(cfg.logFile, `${cfg.logFile}.1`)
  } catch {
    // Missing, or held by a process that did not allow it: keep writing to it.
  }
}

/**
 * The last line the server wrote after byte `offset` that reads like a message: no stack frames,
 * no blank lines, no 'Node.js v...' footer and none of the launcher's own timestamped lines.
 */
export function lastServerMessage(logFile: string, offset: number): string {
  let text: string
  try {
    text = readFileSync(logFile).subarray(offset).toString('utf8')
  } catch {
    return ''
  }
  const lines = text
    .split(/\r?\n/)
    .filter((line) => line !== '' && !/^\s/.test(line) && !/^Node\.js v/.test(line) && !/^\[[0-9-]+ [0-9:]+\] /.test(line))
  return (lines.at(-1) ?? '').slice(0, 240)
}

export function readPid(file: string): number | null {
  try {
    const pid = Number(readFileSync(file, 'utf8').replace(/\D/g, ''))
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function writePid(file: string, pid: number): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${pid}\n`)
}

/** Removes a pid file, only when it still holds `pid` (when given). */
function removePid(file: string, pid?: number): void {
  try {
    if (pid === undefined || readPid(file) === pid) unlinkSync(file)
  } catch {
    // Already gone.
  }
}

/* ------------------------------------------------------------------ */
/* Processes                                                           */
/* ------------------------------------------------------------------ */

/** The image name from `tasklist /FI "PID eq n" /FO CSV /NH`, or null when that pid is not listed. */
export function parseTasklist(stdout: string, pid: number): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const fields = [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1]!.replaceAll('""', '"'))
    if (fields.length >= 2 && fields[1] === String(pid)) return fields[0]!
  }
  return null
}

/** The program a pid runs (node.exe, msedge.exe; node on macOS), or null when unknown. */
export async function processImage(pid: number, sys: System, env: NodeJS.ProcessEnv): Promise<string | null> {
  if (sys.platform === 'win32') {
    const { code, stdout } = await sys.run(system32(env, 'tasklist.exe'), ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'])
    return code === 0 ? parseTasklist(stdout, pid) : null
  }
  const { code, stdout } = await sys.run('ps', ['-p', String(pid), '-o', 'comm='])
  const name = stdout.trim()
  return code === 0 && name ? basename(name) : null
}

/** The pid in the server's pid file, when that process still runs node. */
export async function serverPid(cfg: LauncherConfig, sys: System): Promise<number | null> {
  const pid = readPid(cfg.pidFile)
  if (!pid || !sys.isAlive(pid)) return null
  const image = await processImage(pid, sys, cfg.env)
  return image && /^node(\.exe)?$/i.test(image) ? pid : null
}

/** Waits while `check` holds, polling every 200 ms. False when it still holds after `ms`. */
export async function waitWhile(check: () => boolean | Promise<boolean>, ms: number, sys: System): Promise<boolean> {
  const deadline = sys.now() + ms
  while (await check()) {
    if (sys.now() >= deadline) return false
    await sys.sleep(200)
  }
  return true
}

/**
 * Ends a process at once, with what it started (a running sync): taskkill /T /F on Windows,
 * where there are no signals to ask nicely with; SIGTERM, then SIGKILL elsewhere.
 */
export async function terminate(pid: number, cfg: LauncherConfig, sys: System): Promise<void> {
  if (sys.platform === 'win32') {
    await sys.run(system32(cfg.env, 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'])
    await waitWhile(() => sys.isAlive(pid), 5000, sys)
    return
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return
  }
  if (await waitWhile(() => sys.isAlive(pid), 5000, sys)) return
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    return
  }
  await waitWhile(() => sys.isAlive(pid), 2000, sys)
}

/** Resolves when the process started (null) or could not be started (the error). */
function started(child: ChildProcess): Promise<Error | null> {
  return new Promise((resolveStart) => {
    child.once('spawn', () => resolveStart(null))
    child.once('error', (err) => resolveStart(err))
  })
}

/* ------------------------------------------------------------------ */
/* Talking to the server                                               */
/* ------------------------------------------------------------------ */

interface HttpResult {
  status: number
  body: string
}

/** One request to the server on loopback, without keep-alive, so nothing holds the launcher open. */
function httpRequest(cfg: LauncherConfig, path: string, opts: { method?: string; body?: string; timeoutMs: number }): Promise<HttpResult | null> {
  return new Promise((resolveRequest) => {
    const headers: Record<string, string> = {}
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = String(Buffer.byteLength(opts.body))
    }
    const req = httpRequestNode(
      { host: '127.0.0.1', port: cfg.port, path, method: opts.method ?? 'GET', headers, agent: false, timeout: opts.timeoutMs },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolveRequest({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
        res.on('error', () => resolveRequest(null))
      },
    )
    const deadline = setTimeout(() => req.destroy(new Error('timeout')), opts.timeoutMs)
    req.on('close', () => clearTimeout(deadline))
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', () => resolveRequest(null))
    req.end(opts.body)
  })
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** True when the app server answers GET /api/health. The dev server (npm run dev) does not count. */
export async function isHealthy(cfg: LauncherConfig, timeoutMs = 2000): Promise<boolean> {
  const res = await httpRequest(cfg, '/api/health', { timeoutMs })
  if (res?.status !== 200) return false
  const body = parseJson(res.body) as { ok?: unknown; mode?: unknown } | null
  return body?.ok === true && body.mode === 'app'
}

/** Live on Wi-Fi on (true) or off (false); null when the server does not say. */
export async function liveStatus(cfg: LauncherConfig): Promise<boolean | null> {
  const res = await httpRequest(cfg, '/api/server', { timeoutMs: 3000 })
  if (res?.status !== 200) return null
  const live = (parseJson(res.body) as { live?: unknown } | null)?.live
  return typeof live === 'boolean' ? live : null
}

/** POST /api/server/stop: the server finishes pending writes and exits. */
async function requestStop(cfg: LauncherConfig): Promise<boolean> {
  const res = await httpRequest(cfg, '/api/server/stop', { method: 'POST', body: '{}', timeoutMs: 3000 })
  return !!res && res.status >= 200 && res.status < 300
}

/* ------------------------------------------------------------------ */
/* Starting the server                                                 */
/* ------------------------------------------------------------------ */

const BUILD_SOURCES = ['src', 'index.html', 'vite.config.ts', 'tailwind.config.ts', 'package.json']

function newerThan(path: string, time: number): boolean {
  let stat
  try {
    stat = statSync(path)
  } catch {
    return false
  }
  if (stat.isDirectory()) return readdirSync(path).some((name) => newerThan(join(path, name), time))
  const name = basename(path)
  if (name.endsWith('.test.ts') || name === '.DS_Store') return false
  return stat.mtimeMs > time
}

/** True when dist/index.html is missing or older than a source file (start.sh does the same). */
export function needsBuild(projectDir: string): boolean {
  let built: number
  try {
    built = statSync(join(projectDir, 'dist', 'index.html')).mtimeMs
  } catch {
    return true
  }
  return BUILD_SOURCES.some((entry) => newerThan(join(projectDir, entry), built))
}

/** Runs a node script with its output appended to the log. Resolves with its exit code (null: could not start). */
async function runToLog(cfg: LauncherConfig, sys: System, args: string[]): Promise<number | null> {
  const fd = openSync(cfg.logFile, 'a')
  let child: ChildProcess
  try {
    child = sys.spawn(cfg.node, args, { cwd: cfg.projectDir, env: cfg.childEnv, stdio: ['ignore', fd, fd], windowsHide: true })
  } finally {
    closeSync(fd)
  }
  return new Promise((resolveRun) => {
    child.on('error', () => resolveRun(null))
    child.on('close', (code) => resolveRun(code))
  })
}

/** How the server runs: through tsx's loader for a .ts entry, as plain JavaScript otherwise. */
export function serverCommand(cfg: LauncherConfig): NodeCommand {
  if (/\.[cm]?ts$/.test(cfg.serverEntry)) return nodeTsCommand(cfg.serverEntry, [], { execPath: cfg.node })
  return { command: cfg.node, args: [cfg.serverEntry] }
}

/**
 * A lock file for the start, so two launchers (a double click) never start two servers. Null
 * when another live launcher holds it; a lock older than the start timeout counts as stale.
 */
function acquireStartLock(cfg: LauncherConfig, sys: System): (() => void) | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(cfg.startLockFile, 'wx')
      writeSync(fd, `${sys.pid}\n`)
      closeSync(fd)
      return () => removePid(cfg.startLockFile, sys.pid)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return () => {}
      const holder = readPid(cfg.startLockFile)
      let age = 0
      try {
        age = sys.now() - statSync(cfg.startLockFile).mtimeMs
      } catch {
        continue
      }
      if (holder && holder !== sys.pid && sys.isAlive(holder) && age < cfg.startTimeoutMs + 10_000) return null
      removePid(cfg.startLockFile)
    }
  }
  return () => {}
}

/** Strips a final full stop, so a reason fits in the middle of a sentence. */
function sentence(reason: string): string {
  return reason.replace(/[.\s]+$/, '')
}

interface StartWatch {
  /** Byte offset in the log where this start began. */
  offset: number
  /** The server process is gone. */
  exited(): boolean
  /** Ends a server that does not answer in time. */
  kill?(): Promise<void>
}

async function waitUntilHealthy(cfg: LauncherConfig, sys: System, watch: StartWatch): Promise<void> {
  const deadline = sys.now() + cfg.startTimeoutMs
  const logName = displayPath(cfg, cfg.logFile)
  for (;;) {
    if (await isHealthy(cfg, 1000)) return
    if (watch.exited()) {
      const reason = lastServerMessage(cfg.logFile, watch.offset)
      removePid(cfg.pidFile)
      throw new LauncherError(`The server stopped right away${reason ? `: ${sentence(reason)}` : ''}. See ${logName} for what went wrong.`)
    }
    if (sys.now() >= deadline) {
      await watch.kill?.()
      throw new LauncherError(`The server didn't respond within ${Math.round(cfg.startTimeoutMs / 1000)} seconds. See ${logName} for what went wrong.`)
    }
    await sys.sleep(200)
  }
}

/**
 * Starts the app server unless it already answers, and waits until it does. Builds the app
 * first when dist/ is missing or older than the sources. 'running': it already answered.
 */
export async function ensureServer(cfg: LauncherConfig, sys: System): Promise<'running' | 'started'> {
  if (await isHealthy(cfg)) return 'running'
  try {
    mkdirSync(cfg.localDir, { recursive: true })
  } catch {
    throw new LauncherError(`Can't create the folder ${displayPath(cfg, cfg.localDir)} in ${cfg.projectDir}.`)
  }

  const release = acquireStartLock(cfg, sys)
  if (!release) {
    log(cfg, 'Another start is already in progress, waiting')
    sys.out('Ash Log is already starting, hang on...')
    // Gives up when that launcher is done (lock gone) and no server process is left.
    const otherGaveUp = () => {
      const pid = readPid(cfg.pidFile)
      return !existsSync(cfg.startLockFile) && !(pid && sys.isAlive(pid))
    }
    await waitUntilHealthy(cfg, sys, { offset: logSize(cfg), exited: otherGaveUp })
    return 'started'
  }
  try {
    // Started by the launcher that held the lock a moment ago.
    if (await isHealthy(cfg, 1000)) return 'running'
    rotateLog(cfg)

    const existing = await serverPid(cfg, sys)
    if (existing) {
      // Our own server that does not answer yet (still starting, or stuck): give it the usual time.
      log(cfg, `Server (pid ${existing}) is already running but does not answer yet, waiting`)
      await waitUntilHealthy(cfg, sys, {
        offset: logSize(cfg),
        exited: () => !sys.isAlive(existing),
        kill: () => terminate(existing, cfg, sys).then(() => removePid(cfg.pidFile, existing)),
      })
      return 'started'
    }

    if (!sys.exists(cfg.serverEntry)) throw new LauncherError(`Server not found: ${cfg.serverEntry}`)
    if (needsBuild(cfg.projectDir)) {
      if (!sys.exists(cfg.vite)) throw new LauncherError(`Vite not found. Run npm install in ${cfg.projectDir} first.`)
      log(cfg, 'dist/ is older than the sources, building the app')
      sys.out('Building the app, this takes a moment...')
      if ((await runToLog(cfg, sys, [cfg.vite, 'build'])) !== 0) {
        throw new LauncherError(`Building the app failed. See ${displayPath(cfg, cfg.logFile)} for what went wrong.`)
      }
    }

    const { command, args } = serverCommand(cfg)
    log(cfg, `Starting the server on port ${cfg.port} with ${command}`)
    const offset = logSize(cfg)
    const fd = openSync(cfg.logFile, 'a')
    let child: ChildProcess
    try {
      // Detached: no console (DETACHED_PROCESS on Windows) and outside the job object Node puts
      // its children in, so the server outlives this launcher. Its own output goes to the log.
      child = sys.spawn(command, args, { cwd: cfg.projectDir, env: cfg.childEnv, detached: true, stdio: ['ignore', fd, fd], windowsHide: true })
    } finally {
      closeSync(fd)
    }
    const error = await started(child)
    const pid = child.pid
    if (error || pid === undefined) {
      throw new LauncherError(`Node couldn't start the server (${error?.message ?? 'no pid'}). Reinstall Ash Log with: npm run app:install`)
    }
    child.unref()
    writePid(cfg.pidFile, pid)
    await waitUntilHealthy(cfg, sys, {
      offset,
      exited: () => child.exitCode !== null || child.signalCode !== null,
      kill: () => terminate(pid, cfg, sys).then(() => removePid(cfg.pidFile, pid)),
    })
    log(cfg, `Server running on port ${cfg.port} (pid ${pid})`)
    return 'started'
  } finally {
    release()
  }
}

/* ------------------------------------------------------------------ */
/* Stopping                                                            */
/* ------------------------------------------------------------------ */

/**
 * Stops the app server like stop.sh: asks it first (POST /api/server/stop), so it can finish
 * pending writes, and ends the process from the pid file when it does not stop in time.
 */
export async function stopServer(cfg: LauncherConfig, sys: System): Promise<'stopped' | 'not-running'> {
  const pid = await serverPid(cfg, sys)
  const answered = await isHealthy(cfg, 1000)
  if (!pid && !answered) {
    removePid(cfg.pidFile)
    return 'not-running'
  }
  let requested = false
  if (answered) {
    requested = await requestStop(cfg)
    log(cfg, requested ? 'Asked the server to stop' : 'Stop request failed')
  }
  if (pid) {
    // Asked nicely: give it time to exit on its own. Otherwise end it right away.
    if (!requested || !(await waitWhile(() => sys.isAlive(pid), cfg.stopTimeoutMs, sys))) {
      log(cfg, `Ending the server (pid ${pid})`)
      await terminate(pid, cfg, sys)
    }
  } else if (requested) {
    // Started some other way (npm run app): wait until it no longer answers.
    await waitWhile(() => isHealthy(cfg, 1000), cfg.stopTimeoutMs, sys)
  }
  removePid(cfg.pidFile)
  if (await isHealthy(cfg, 1000)) {
    const where = sys.platform === 'win32' ? 'Task Manager (process Node.js JavaScript Runtime)' : 'Activity Monitor (process node)'
    throw new LauncherError(`The server on port ${cfg.port} won't stop. Stop it yourself, for example in ${where}.`)
  }
  log(cfg, 'Server stopped')
  return 'stopped'
}

const BROWSER_IMAGE = /^(msedge|chrome)(\.exe)?$/i

/**
 * Closes the Ash Log window(s): asks the browser in window.pid to close them, the way the close
 * button does (taskkill without /F sends WM_CLOSE). Only when that pid still runs Edge or Chrome
 * (or the ASHENFALL_BROWSER program).
 */
export async function closeWindow(cfg: LauncherConfig, sys: System): Promise<boolean> {
  const pid = readPid(cfg.windowPidFile)
  if (!pid || !sys.isAlive(pid)) {
    removePid(cfg.windowPidFile)
    return false
  }
  const image = await processImage(pid, sys, cfg.env)
  const custom = getEnv(cfg.env, 'ASHENFALL_BROWSER', cfg.platform)
  const ours = !!image && (BROWSER_IMAGE.test(image) || (!!custom && image.toLowerCase() === basename(custom).toLowerCase()))
  if (!ours) {
    removePid(cfg.windowPidFile)
    return false
  }
  if (sys.platform === 'win32') await sys.run(system32(cfg.env, 'taskkill.exe'), ['/PID', String(pid)])
  else {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // Gone already.
    }
  }
  await waitWhile(() => sys.isAlive(pid), 5000, sys)
  removePid(cfg.windowPidFile, pid)
  log(cfg, `Window closed (pid ${pid})`)
  return true
}

/* ------------------------------------------------------------------ */
/* The window                                                          */
/* ------------------------------------------------------------------ */

export type BrowserName = 'edge' | 'chrome' | 'browser'

export interface Browser {
  /** Also the name of its profile folder under %LOCALAPPDATA%\Ash Log. */
  name: BrowserName
  label: string
  path: string
}

/** Where Edge and Chrome live on Windows, per machine and per user; ASHENFALL_BROWSER first. */
export function browserCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): Browser[] {
  const get = (name: string) => getEnv(env, name, platform)
  const list: Browser[] = []
  const custom = get('ASHENFALL_BROWSER')?.trim()
  if (custom) list.push({ name: 'browser', label: basename(custom), path: custom })
  if (platform !== 'win32') return list
  const programFiles = get('ProgramFiles')
  const programFilesX86 = get('ProgramFiles(x86)')
  const localAppData = get('LOCALAPPDATA')
  for (const base of [programFilesX86, programFiles, localAppData]) {
    if (base) list.push({ name: 'edge', label: 'Microsoft Edge', path: win32.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe') })
  }
  for (const base of [programFiles, programFilesX86, localAppData]) {
    if (base) list.push({ name: 'chrome', label: 'Google Chrome', path: win32.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe') })
  }
  return list
}

export function findBrowser(cfg: LauncherConfig, sys: System): Browser | null {
  return browserCandidates(cfg.env, cfg.platform).find((browser) => sys.exists(browser.path)) ?? null
}

export function browserProfile(cfg: LauncherConfig, name: BrowserName): string {
  return (cfg.platform === 'win32' ? win32 : posix).join(cfg.appDataDir, name)
}

/** An app window (no tabs, no address bar) in a browser of its own. */
export function browserArgs(url: string, profileDir: string): string[] {
  return [`--app=${url}`, `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check']
}

/** The copy of this launcher that waits for the window to close (see watchWindow). */
export function watcherCommand(cfg: LauncherConfig, browser: BrowserName, browserPid: number, gui: boolean, launcherFile = LAUNCHER_FILE): NodeCommand {
  const args = ['--watch', `--browser=${browser}`, `--browser-pid=${browserPid}`]
  if (gui) args.push('--gui')
  return nodeTsCommand(launcherFile, args, { execPath: cfg.node })
}

export const DEFAULT_BROWSER_NOTE =
  'No Edge or Chrome found, so Ash Log opens in your default browser.\n\n' +
  'Closing that tab keeps Ash Log running. To stop it, use Stop Ash Log in the Start menu.'

function openDefaultBrowser(cfg: LauncherConfig, sys: System): void {
  const command = sys.platform === 'win32' ? win32.join(systemRoot(cfg.env), 'explorer.exe') : sys.platform === 'darwin' ? 'open' : 'xdg-open'
  const child = sys.spawn(command, [cfg.appUrl], { detached: true, stdio: 'ignore' })
  child.on('error', () => {})
  child.unref()
}

/**
 * Opens the app window. A fresh browser (none ran with the profile) gets a watcher that stops
 * the server once the window closes; an extra window in a browser that already runs does not,
 * the watcher of that browser does.
 */
export async function openWindow(cfg: LauncherConfig, sys: System, opts: { gui: boolean; launcherFile?: string }): Promise<void> {
  const browser = findBrowser(cfg, sys)
  if (!browser) {
    log(cfg, 'No Edge or Chrome found, Ash Log opens in the default browser')
    openDefaultBrowser(cfg, sys)
    if (opts.gui) await sys.dialog({ kind: 'info', buttons: 'ok', seconds: 20, text: DEFAULT_BROWSER_NOTE }, cfg.env)
    else sys.out(DEFAULT_BROWSER_NOTE.replace('\n\n', ' '))
    return
  }

  const profile = browserProfile(cfg, browser.name)
  const alreadyOpen = sys.profileLocked(profile)
  // Not windowsHide: for a program with windows, that would ask it to start hidden.
  const child = sys.spawn(browser.path, browserArgs(cfg.appUrl, profile), { detached: true, stdio: 'ignore' })
  const error = await started(child)
  const pid = child.pid
  if (error || pid === undefined) throw new LauncherError(`${browser.label} couldn't start: ${error?.message ?? 'no pid'}`)
  child.unref()
  if (alreadyOpen) {
    log(cfg, `Opened another window in ${browser.label}`)
    return
  }

  writePid(cfg.windowPidFile, pid)
  const watcher = watcherCommand(cfg, browser.name, pid, opts.gui, opts.launcherFile)
  const watch = sys.spawn(watcher.command, watcher.args, { cwd: cfg.projectDir, env: cfg.childEnv, detached: true, stdio: 'ignore', windowsHide: true })
  const watchError = await started(watch)
  if (watchError) log(cfg, `Can't follow the window (${watchError.message}): stop Ash Log yourself with Stop Ash Log`)
  watch.unref()
  log(cfg, `Window opened in ${browser.label} (pid ${pid})`)
}

export const LIVE_QUESTION =
  'Live on Wi-Fi is still on.\n\n' +
  'Keep Ash Log running for your phone?\n\n' +
  'Yes: Ash Log keeps running. Stop it later with Stop Ash Log in the Start menu.\n' +
  'No: Ash Log stops now.'

/**
 * The watcher (--watch): waits until the window's browser is gone, then stops the server. With
 * Live on Wi-Fi on it asks first. Started detached by openWindow, without a console.
 */
export async function watchWindow(cfg: LauncherConfig, sys: System, opts: { browser: BrowserName; browserPid: number; gui: boolean }): Promise<void> {
  const profile = browserProfile(cfg, opts.browser)
  const startedAt = sys.now()
  let seenLock = false
  for (;;) {
    if (sys.profileLocked(profile)) seenLock = true
    // Before the lock shows up (or where there is none), the browser process itself counts.
    else if (seenLock || !sys.isAlive(opts.browserPid)) break
    await sys.sleep(WATCH_INTERVAL_MS)
  }
  removePid(cfg.windowPidFile, opts.browserPid)

  if (!seenLock && sys.now() - startedAt < HANDOFF_MS) {
    // It handed the window to a browser that already ran with this profile: that one's watcher waits.
    log(cfg, 'The browser handed the window to a browser that was already running')
    return
  }
  if (!(await isHealthy(cfg))) {
    log(cfg, 'Window closed, the server had already stopped')
    return
  }
  if ((await liveStatus(cfg)) === true) {
    const answer = opts.gui ? await sys.dialog({ kind: 'question', buttons: 'yesno', defaultNo: true, text: LIVE_QUESTION }, cfg.env) : 'none'
    if (answer === 'yes') {
      log(cfg, 'Window closed, Live on Wi-Fi is on: the server keeps running')
      return
    }
  }
  log(cfg, 'Window closed, stopping the server')
  await stopServer(cfg, sys)
}

/* ------------------------------------------------------------------ */
/* Command line                                                        */
/* ------------------------------------------------------------------ */

export type LauncherCommand =
  | { command: 'open' | 'serve' | 'stop' | 'status' | 'help'; gui: boolean }
  | { command: 'watch'; gui: boolean; browser: BrowserName; browserPid: number }

const COMMAND_FLAGS: Record<string, 'serve' | 'stop' | 'status' | 'help' | 'watch'> = {
  '--no-browser': 'serve',
  '--stop': 'stop',
  '--status': 'status',
  '--help': 'help',
  '-h': 'help',
  '--watch': 'watch',
}

export function parseLauncherArgs(argv: readonly string[]): LauncherCommand | { error: string } {
  let gui = false
  const commands = new Set<'serve' | 'stop' | 'status' | 'help' | 'watch'>()
  let browser: string | undefined
  let browserPid: number | undefined
  for (const arg of argv) {
    const at = arg.indexOf('=')
    const name = at < 0 ? arg : arg.slice(0, at)
    const value = at < 0 ? undefined : arg.slice(at + 1)
    const flagCommand = Object.hasOwn(COMMAND_FLAGS, name) ? COMMAND_FLAGS[name] : undefined
    if (name === '--gui' && value === undefined) gui = true
    else if (flagCommand && value === undefined) commands.add(flagCommand)
    else if (name === '--browser' && value) browser = value
    else if (name === '--browser-pid' && value && /^\d+$/.test(value)) browserPid = Number(value)
    else return { error: `Unknown option: ${arg}` }
  }
  if (commands.size > 1) return { error: 'Pick one of --no-browser, --stop, --status and --watch, not more than one.' }
  const command = [...commands][0] ?? 'open'
  if (command === 'watch') {
    if ((browser !== 'edge' && browser !== 'chrome' && browser !== 'browser') || !browserPid) {
      return { error: '--watch goes with --browser=edge|chrome|browser and --browser-pid=<pid>' }
    }
    return { command, gui, browser, browserPid }
  }
  if (browser !== undefined || browserPid !== undefined) return { error: '--browser and --browser-pid only go with --watch' }
  return { command, gui }
}

export interface LauncherDeps {
  sys?: System
  config?: ConfigOptions
  launcherFile?: string
}

/** Reports a failure on stderr and in the log, and with --gui in a dialog that offers the log. */
async function report(cfg: LauncherConfig | null, sys: System, gui: boolean, title: string, err: unknown): Promise<void> {
  const message = err instanceof LauncherError ? err.message : `Something unexpected went wrong: ${(err as Error)?.message ?? String(err)}`
  sys.err(message)
  if (cfg) log(cfg, `ERROR: ${message}`)
  if (!gui) return
  const env = cfg?.env ?? process.env
  if (!cfg) {
    await sys.dialog({ kind: 'error', buttons: 'ok', text: `${title}\n\n${message}` }, env)
    return
  }
  const answer = await sys.dialog({ kind: 'error', buttons: 'yesno', text: `${title}\n\n${message}\n\nOpen the log file?` }, env)
  if (answer === 'yes' && sys.platform === 'win32') {
    const child = sys.spawn(system32(cfg.env, 'notepad.exe'), [cfg.logFile], { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
  }
}

/** Runs the launcher with these arguments. Resolves with the exit code. */
export async function runLauncher(argv: readonly string[], deps: LauncherDeps = {}): Promise<number> {
  const sys = deps.sys ?? realSystem()
  const parsed = parseLauncherArgs(argv)
  if ('error' in parsed) {
    sys.err(parsed.error)
    sys.err(USAGE)
    return 2
  }
  if (parsed.command === 'help') {
    sys.out(USAGE)
    return 0
  }
  const { gui } = parsed
  let cfg: LauncherConfig
  try {
    cfg = resolveConfig({ platform: sys.platform, ...deps.config })
  } catch (err) {
    await report(null, sys, gui, "Ash Log can't start.", err)
    return 1
  }

  switch (parsed.command) {
    case 'status': {
      // One retry, so a busy moment does not count (status.sh does the same).
      let running = await isHealthy(cfg, 3000)
      if (!running) {
        await sys.sleep(1000)
        running = await isHealthy(cfg, 3000)
      }
      if (running) {
        sys.out(`Ash Log is running at ${cfg.appUrl}`)
        return 0
      }
      sys.err('The server is not running.')
      return 1
    }
    case 'serve':
    case 'open': {
      try {
        sys.out('Starting Ash Log...')
        await ensureServer(cfg, sys)
        if (parsed.command === 'serve') {
          sys.out(`Ash Log is running at ${cfg.appUrl}`)
          return 0
        }
        await openWindow(cfg, sys, { gui, launcherFile: deps.launcherFile })
        return 0
      } catch (err) {
        await report(cfg, sys, gui, "Ash Log can't start.", err)
        return 1
      }
    }
    case 'stop': {
      try {
        const result = await stopServer(cfg, sys)
        await closeWindow(cfg, sys)
        const text = result === 'stopped' ? 'Ash Log has stopped.' : "Ash Log wasn't running."
        sys.out(text)
        if (gui) await sys.dialog({ kind: 'info', buttons: 'ok', seconds: 4, text }, cfg.env)
        return 0
      } catch (err) {
        await report(cfg, sys, gui, "Couldn't stop Ash Log.", err)
        return 1
      }
    }
    case 'watch': {
      try {
        await watchWindow(cfg, sys, parsed)
        return 0
      } catch (err) {
        await report(cfg, sys, gui, "Couldn't stop Ash Log.", err)
        return 1
      }
    }
  }
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  runLauncher(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (err: unknown) => {
      console.error(err)
      process.exitCode = 1
    },
  )
}
