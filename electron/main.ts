// The desktop app (Electron main process). It runs the app server in this process on the fixed
// port, shows it in a window, and keeps everything writable in the per-user folder:
//   macOS   ~/Library/Application Support/Ash Log
//   Windows %APPDATA%\Ash Log
// The wiki data and images ship with the app as a seed (server/paths.ts, server/wiki-source.ts).
//
// Switches for tests and CI: --smoke (start the server, check it answers, quit; never a window),
// ASH_LOG_USER_DATA (another per-user folder) and ASH_LOG_PORT (another port).

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, Menu, nativeImage, net, powerSaveBlocker, shell, Tray, type MenuItemConstructorOptions } from 'electron'
import { createAppServer, type AppServer } from '../server/app.ts'
import { loadEnv, parsePort } from '../server/config.ts'
import { PortInUseError } from '../server/live.ts'
import { createDataApi } from '../server/middleware.ts'
import { desktopPaths, USER_DATA_ENV, type AshLogPaths } from '../server/paths.ts'
import { closeAction, dueForCheck, linkAction, parseRelease, RELEASES_API, updateToShow, type UpdateState } from './logic.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SMOKE = process.argv.includes('--smoke')
const WIKI_URL = 'https://dragonwilds.runescape.wiki'
const PROJECT_URL = 'https://github.com/joost-meijerink/ash-log'

app.setName('Ash Log')
const userDataOverride = process.env[USER_DATA_ENV]?.trim()
// Development (npm run desktop:dev) never touches the installed app's data: it keeps its own
// per-user folder inside the project's .local.
if (userDataOverride) app.setPath('userData', userDataOverride)
else if (!app.isPackaged) app.setPath('userData', join(HERE, '..', '..', '.local', 'desktop-dev'))

/**
 * The read-only app files in the project layout (dist/, public/, data/wiki): in the installed
 * app the resources folder, in development (npm run desktop:dev) the project itself.
 */
function resourcesDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'app-files') : join(HERE, '..', '..')
}

/** The bundled sync (scripts/sync/index.ts), run by this executable as plain Node. */
function syncScript(): string {
  return join(HERE, 'sync.mjs')
}

const pad = (n: number) => String(n).padStart(2, '0')
function timestamp(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

let paths: AshLogPaths
let server: AppServer | null = null
let port = 5199
let win: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let blocker: number | null = null

function log(line: string) {
  const text = `[${timestamp()}] ${line}`
  console.log(text)
  try {
    appendFileSync(paths.logFile, `${text}\n`)
  } catch {
    // The log is a convenience; never fail on it.
  }
}

/** Keeps the computer from sleeping while Live on Wi-Fi is on (the screen may still turn off). */
const stayAwake = {
  start() {
    if (blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension')
  },
  stop() {
    if (blocker !== null && powerSaveBlocker.isStarted(blocker)) powerSaveBlocker.stop(blocker)
    blocker = null
  },
}

/** Starts the app server on the fixed port. Shows why and quits when that is impossible. */
async function startServer(): Promise<boolean> {
  paths = desktopPaths({ userData: app.getPath('userData'), resources: resourcesDir() })
  mkdirSync(paths.localDir, { recursive: true })
  try {
    loadEnv(paths.envFile)
    port = parsePort(process.env.ASH_LOG_PORT ?? process.env.APP_PORT)
  } catch (err) {
    return fail(`Ash Log couldn't read its settings: ${(err as Error).message}`)
  }
  const data = createDataApi({
    paths,
    log,
    appVersion: app.getVersion(),
    // The sync runs as a separate process: this executable as plain Node on the bundled script.
    syncCommand: (args) => ({ command: process.execPath, args: [syncScript(), ...args], env: { ELECTRON_RUN_AS_NODE: '1' }, cwd: paths.userDataDir ?? undefined }),
  })
  server = createAppServer({
    port,
    paths,
    data,
    log,
    stayAwake,
    onStop: () => {
      quitting = true
      app.quit()
    },
    onFatal: (err) => void fail(`Ash Log stopped: ${err.message}`),
  })
  try {
    await server.start()
  } catch (err) {
    server = null
    if (err instanceof PortInUseError) {
      return fail(`Port ${port} is already in use, maybe by Ash Log started from source (npm run app) or another program. Close it and open Ash Log again.`)
    }
    return fail(`Ash Log couldn't start: ${(err as Error).message}`)
  }
  log(`Ash Log ${app.getVersion()} is running on http://localhost:${port}`)
  return true
}

function fail(message: string): false {
  log(message)
  if (SMOKE) console.error(message)
  else dialog.showErrorBox('Ash Log', message)
  quitting = true
  app.exit(1)
  return false
}

/** --smoke: the server answers /api/health and the app page, then quit. For CI; never a window. */
async function smoke(): Promise<void> {
  const base = `http://127.0.0.1:${port}`
  try {
    const health = (await (await net.fetch(`${base}/api/health`)).json()) as { ok?: boolean; mode?: string }
    const page = await net.fetch(`${base}/`)
    const html = await page.text()
    if (!health.ok || health.mode !== 'app' || !page.ok || !html.includes('<div id="app"')) throw new Error(`unexpected answer: ${JSON.stringify(health)} ${page.status}`)
    // The wiki data that ships with the app (or the user's newer copy) is served.
    const data = (await (await net.fetch(`${base}/api/data`)).json()) as { ready?: boolean; map?: { points?: unknown[] }; quests?: unknown[] }
    const points = data.map?.points?.length ?? 0
    if (!data.ready || !points || !data.quests?.length) throw new Error('no wiki data')
    console.log(`smoke ok: Ash Log ${app.getVersion()} on port ${port}, ${points} map points, data in ${paths.userDataDir}`)
    await server?.close()
    app.exit(0)
  } catch (err) {
    console.error(`smoke failed: ${(err as Error).message}`)
    await server?.close().catch(() => {})
    app.exit(1)
  }
}

function appIcon(): Electron.NativeImage {
  return nativeImage.createFromPath(join(resourcesDir(), 'public', 'icons', 'icon-512.png'))
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 360,
    minHeight: 480,
    title: 'Ash Log',
    backgroundColor: '#15120e',
    icon: process.platform === 'darwin' ? undefined : appIcon(),
    autoHideMenuBar: process.platform !== 'darwin',
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  w.once('ready-to-show', () => w.show())
  // Only the app itself stays in the window; other web links open in the default browser.
  w.webContents.setWindowOpenHandler(({ url }) => {
    const action = linkAction(url, port)
    if (action === 'app') void w.loadURL(url)
    else if (action === 'external') void shell.openExternal(url)
    return { action: 'deny' }
  })
  w.webContents.on('will-navigate', (event, url) => {
    const action = linkAction(url, port)
    if (action === 'app') return
    event.preventDefault()
    if (action === 'external') void shell.openExternal(url)
  })
  w.on('close', (event) => onClose(event, w))
  w.on('closed', () => {
    if (win === w) win = null
  })
  void w.loadURL(`http://localhost:${port}/`)
  return w
}

function showWindow() {
  if (!win) win = createWindow()
  else {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
}

function onClose(event: Electron.Event, w: BrowserWindow) {
  const action = closeAction({ platform: process.platform, live: !!server?.listeners.live, quitting })
  if (action === 'quit') return
  event.preventDefault()
  if (action === 'hide') return w.hide()
  const answer = dialog.showMessageBoxSync(w, {
    type: 'question',
    buttons: ['Keep running', 'Quit Ash Log'],
    defaultId: 1,
    cancelId: 0,
    title: 'Ash Log',
    message: 'Keep Ash Log running for your phone?',
    detail: 'Live on Wi-Fi is on. Ash Log keeps running in the background; open it again from the icon in the taskbar corner.',
  })
  if (answer === 0) {
    w.hide()
    showTray()
  } else {
    quitting = true
    app.quit()
  }
}

/** Windows and Linux: the icon in the taskbar corner while Ash Log runs without a window. */
function showTray() {
  if (tray) return
  tray = new Tray(appIcon().resize({ width: 16, height: 16 }))
  tray.setToolTip('Ash Log')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Ash Log', click: showWindow },
      { type: 'separator' },
      {
        label: 'Quit Ash Log',
        click: () => {
          quitting = true
          app.quit()
        },
      },
    ]),
  )
  tray.on('click', showWindow)
}

function openLog() {
  void shell.openPath(paths.logFile)
}

function buildMenu() {
  const mac = process.platform === 'darwin'
  const help: MenuItemConstructorOptions = {
    role: 'help',
    submenu: [
      { label: 'Open Server Log', click: openLog },
      { label: 'Ash Log on GitHub', click: () => void shell.openExternal(PROJECT_URL) },
      { label: 'RuneScape: Dragonwilds Wiki', click: () => void shell.openExternal(WIKI_URL) },
      ...(mac ? [] : [{ type: 'separator' } as const, { label: 'About Ash Log', click: showAbout }]),
    ],
  }
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : [{ label: 'File', submenu: [{ role: 'quit' }] } as MenuItemConstructorOptions]),
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' } as const]),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'History',
      submenu: [
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => win?.webContents.navigationHistory.goBack() },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => win?.webContents.navigationHistory.goForward() },
      ],
    },
    ...(mac ? [{ role: 'windowMenu' } as MenuItemConstructorOptions] : []),
    help,
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

const CREDITS =
  'Game content from the RuneScape: Dragonwilds Wiki (dragonwilds.runescape.wiki), CC BY-NC-SA 3.0. ' +
  'Unofficial fan tool, not affiliated with or endorsed by Jagex.'

function showAbout() {
  void dialog.showMessageBox({ type: 'info', title: 'About Ash Log', message: `Ash Log ${app.getVersion()}`, detail: `${CREDITS}\n\n${PROJECT_URL}` })
}

/* ---------------- updates: a notice, no auto-update (the app is not signed) ---------------- */

function updateFile() {
  return join(app.getPath('userData'), 'update.json')
}

function readUpdateState(): UpdateState {
  try {
    return JSON.parse(readFileSync(updateFile(), 'utf8')) as UpdateState
  } catch {
    return {}
  }
}

function writeUpdateState(state: UpdateState) {
  try {
    writeFileSync(updateFile(), JSON.stringify(state))
  } catch {
    // Not worth bothering anyone about.
  }
}

async function checkForUpdate() {
  const state = readUpdateState()
  if (!dueForCheck(state, Date.now())) return
  try {
    const res = await net.fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': `AshLog/${app.getVersion()}` } })
    writeUpdateState({ ...state, lastCheck: Date.now() })
    if (!res.ok) return
    const release = updateToShow(parseRelease(await res.json()), app.getVersion(), state)
    if (!release) return
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: 'Ash Log',
      message: `Ash Log ${release.version} is available`,
      detail: `You have ${app.getVersion()}. Download the new version and install it over this one; your progress stays.`,
      buttons: ['Download', 'Later', 'Skip this version'],
      defaultId: 0,
      cancelId: 1,
    })
    if (response === 0) void shell.openExternal(release.url)
    if (response === 2) writeUpdateState({ ...readUpdateState(), skipped: release.version })
  } catch {
    // Offline or GitHub unreachable: try again another day.
  }
}

/* ---------------- lifecycle ---------------- */

if (!SMOKE && !app.requestSingleInstanceLock()) {
  app.exit(0)
} else {
  app.on('second-instance', () => showWindow())

  app.whenReady().then(async () => {
    app.setAboutPanelOptions({ applicationName: 'Ash Log', applicationVersion: app.getVersion(), credits: CREDITS, website: PROJECT_URL })
    if (!(await startServer())) return
    if (SMOKE) return void smoke()
    buildMenu()
    showWindow()
    setTimeout(() => void checkForUpdate(), 10_000)
    setInterval(() => void checkForUpdate(), 6 * 60 * 60 * 1000).unref()
  })

  // macOS: the Dock icon brings the window back.
  app.on('activate', () => {
    if (server) showWindow()
  })

  // macOS keeps running without windows (phones may use it); elsewhere onClose decides.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && !tray) {
      quitting = true
      app.quit()
    }
  })

  // Stop the server cleanly (paired devices saved, a running sync ended) before quitting.
  let closing = false
  app.on('before-quit', (event) => {
    quitting = true
    if (!server || closing) return
    event.preventDefault()
    closing = true
    stayAwake.stop()
    void server
      .close()
      .catch((err: Error) => log(`Error while stopping: ${err.message}`))
      .finally(() => {
        server = null
        log('Stopped')
        app.quit()
      })
  })
}
