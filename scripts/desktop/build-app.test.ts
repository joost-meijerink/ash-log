import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  APP_NAME,
  buildApp,
  BUNDLE_ID,
  CONFIG_KEYS,
  EXECUTABLE,
  infoPlist,
  infoPlistValues,
  MINIMUM_MACOS,
  resolvePort,
  SWIFT_SOURCES,
  swiftcFlags,
  swiftTarget,
} from './build-app.ts'
import { DESKTOP_DIR } from './make-icons.ts'

const HERD_NODE = '/Users/me/Library/Application Support/Herd/config/nvm/versions/node/v24.15.0/bin/node'
const CONFIG = { projectDir: '/Users/me/Documents/Projectjes/Dragonwilds', nodePath: HERD_NODE, port: 5199 }
const isMac = process.platform === 'darwin'
const hasSwift = isMac && existsSync('/usr/bin/swiftc') && spawnSync('/usr/bin/xcrun', ['--find', 'swiftc'], { stdio: 'ignore' }).status === 0
const swiftSource = SWIFT_SOURCES.map((file) => readFileSync(file, 'utf8')).join('\n')

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

/** An XML plist as JSON, through plutil. */
function plistToJson(file: string): Record<string, unknown> {
  return JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' })) as Record<string, unknown>
}

describe('Info.plist', () => {
  const values = infoPlistValues(CONFIG, '1.2.3')

  it('makes a named app with a bundle id, version, icon and executable', () => {
    expect(values).toMatchObject({
      CFBundleName: 'Ash Log',
      CFBundleDisplayName: 'Ash Log',
      CFBundleIdentifier: 'nl.ashenfall.ashlog',
      CFBundleExecutable: 'AshLog',
      CFBundleIconFile: 'AppIcon',
      CFBundlePackageType: 'APPL',
      CFBundleShortVersionString: '1.2.3',
      CFBundleVersion: '1.2.3',
      LSMinimumSystemVersion: MINIMUM_MACOS,
      LSApplicationCategoryType: 'public.app-category.utilities',
      NSHighResolutionCapable: true,
      NSPrincipalClass: 'NSApplication',
    })
  })

  it('lets the web view load the app over plain http on this Mac, and nothing else', () => {
    expect(values.NSAppTransportSecurity).toEqual({ NSAllowsLocalNetworking: true })
  })

  it('always gets to stop the server on quit and logout', () => {
    expect(values).toMatchObject({ NSSupportsSuddenTermination: false, NSSupportsAutomaticTermination: false })
  })

  it('explains the permissions macOS asks for, in English', () => {
    expect(values.NSDocumentsFolderUsageDescription).toContain('project folder')
    expect(values.NSLocalNetworkUsageDescription).toContain('Live on Wi-Fi')
    // No AppleScript any more, so no Apple Events.
    expect(values).not.toHaveProperty('NSAppleEventsUsageDescription')
  })

  it('bakes in the project, the absolute node path and the port', () => {
    expect(values).toMatchObject({ AshLogProjectDir: CONFIG.projectDir, AshLogNode: HERD_NODE, AshLogPort: 5199 })
    expect(CONFIG_KEYS).toEqual({ projectDir: 'AshLogProjectDir', nodePath: 'AshLogNode', port: 'AshLogPort' })
  })

  it('refuses relative paths and bad ports', () => {
    expect(() => infoPlistValues({ ...CONFIG, projectDir: 'Dragonwilds' }, '1')).toThrow(/absolute/)
    expect(() => infoPlistValues({ ...CONFIG, nodePath: 'node' }, '1')).toThrow(/absolute/)
    expect(() => infoPlistValues({ ...CONFIG, port: 0 }, '1')).toThrow(/port/)
    expect(() => infoPlistValues({ ...CONFIG, port: 70000 }, '1')).toThrow(/port/)
  })

  it('writes paths with spaces as they are, and escapes XML', () => {
    const xml = infoPlist({ ...CONFIG, projectDir: '/Users/me/Tom & Jerry <old>' }, '1.0.0')
    expect(xml).toContain(`<key>AshLogNode</key>\n\t<string>${HERD_NODE}</string>`)
    expect(xml).toContain('<string>/Users/me/Tom &amp; Jerry &lt;old&gt;</string>')
    expect(xml).toContain('<key>AshLogPort</key>\n\t<integer>5199</integer>')
    expect(xml).toContain('<key>NSAllowsLocalNetworking</key>\n\t\t<true/>')
  })

  it('refuses control characters XML cannot hold', () => {
    expect(() => infoPlist({ ...CONFIG, projectDir: '/a\u0001b' }, '1')).toThrow(/Control character/)
  })

  it.skipIf(!isMac)('is a valid plist that reads back the same', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ash-log-plist-'))
    try {
      const file = join(dir, 'Info.plist')
      const config = { ...CONFIG, projectDir: '/Users/me/Tom & Jerry <old>/"quoted" \'too\'' }
      writeFileSync(file, infoPlist(config, '1.2.3'))
      execFileSync('/usr/bin/plutil', ['-lint', '-s', file])
      expect(plistToJson(file)).toEqual(infoPlistValues(config, '1.2.3'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('resolvePort', () => {
  const project = mkdtempSync(join(tmpdir(), 'ash-log-port-'))
  afterAll(() => rmSync(project, { recursive: true, force: true }))

  it('takes APP_PORT from .env, quotes and comments and all', () => {
    writeFileSync(join(project, '.env'), 'WIKI_USER_AGENT="x (y@z)"\nAPP_PORT="5231" # fixed port\n')
    expect(resolvePort(project, {})).toBe(5231)
  })

  it('lets ASHENFALL_PORT win', () => {
    expect(resolvePort(project, { ASHENFALL_PORT: '5307' })).toBe(5307)
  })

  it('defaults to 5199', () => {
    rmSync(join(project, '.env'), { force: true })
    expect(resolvePort(project, {})).toBe(5199)
  })

  it('refuses a port that is not a number', () => {
    writeFileSync(join(project, '.env'), 'APP_PORT=five\n')
    expect(() => resolvePort(project, {})).toThrow(/APP_PORT/)
  })
})

describe('Swift source', () => {
  it('reads the Info.plist keys the build writes', () => {
    for (const key of Object.values(CONFIG_KEYS)) expect(swiftSource).toContain(`"${key}"`)
  })

  it('passes node and the port to the scripts the way lib.sh reads them', () => {
    const lib = readFileSync(join(DESKTOP_DIR, 'lib.sh'), 'utf8')
    for (const name of ['ASHENFALL_NODE', 'ASHENFALL_PORT']) {
      expect(swiftSource).toContain(`environment["${name}"]`)
      expect(lib).toContain(name)
    }
  })

  it('runs scripts that exist', () => {
    const scripts = [...new Set([...swiftSource.matchAll(/DesktopScript\("([^"]+)"/g)].map((match) => match[1]))]
    expect(scripts.sort()).toEqual(['start.sh', 'stop.sh'])
    for (const script of scripts) expect(existsSync(join(DESKTOP_DIR, script))).toBe(true)
  })

  it('checks the server the way the scripts do: mode "app" on /api/health', () => {
    expect(swiftSource).toContain('/api/health')
    expect(swiftSource).toContain('body["mode"] as? String == "app"')
  })

  it('has no em-dashes', () => {
    expect(swiftSource).not.toContain('\u2014')
  })

  it.skipIf(!hasSwift)('compiles without warnings and hooks into AppKit and WebKit', { timeout: 120_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ash-log-swift-'))
    try {
      const header = join(dir, 'AshLog-Swift.h')
      const result = spawnSync('/usr/bin/swiftc', ['-typecheck', ...swiftcFlags(), '-emit-objc-header-path', header, ...SWIFT_SOURCES], {
        encoding: 'utf8',
      })
      expect(result.stderr).toBe('')
      expect(result.status).toBe(0)
      // A delegate method whose Swift signature is slightly off is silently never called;
      // the generated header lists only the ones AppKit and WebKit will see.
      const exposed = readFileSync(header, 'utf8')
      for (const selector of [
        'applicationDidFinishLaunching:',
        'applicationShouldTerminate:',
        'applicationShouldTerminateAfterLastWindowClosed:',
        'applicationShouldHandleReopen:(NSApplication * _Nonnull)sender hasVisibleWindows:',
        'webView:(WKWebView * _Nonnull)webView decidePolicyForNavigationAction:',
        'webView:(WKWebView * _Nonnull)webView decidePolicyForNavigationResponse:',
        'webView:(WKWebView * _Nonnull)webView createWebViewWithConfiguration:',
        'webView:(WKWebView * _Nonnull)webView didCommitNavigation:',
        'webView:(WKWebView * _Nonnull)webView didFinishNavigation:',
        'webView:(WKWebView * _Nonnull)webView didFailProvisionalNavigation:',
        'webView:(WKWebView * _Nonnull)webView didFailNavigation:',
        'webViewWebContentProcessDidTerminate:',
        'validateMenuItem:',
      ]) {
        expect(exposed).toContain(selector)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// Skipped in CI: these drive AppKit without a window and once in a while macOS keeps such a
// process waiting for minutes, which says nothing about the app. Run them on a Mac before a release.
describe.skipIf(!hasSwift || !!process.env.CI)('the app, without a window', () => {
  // AshLog.swift with a test main instead of its own (see __fixtures__/SelfTest.swift).
  const root = mkdtempSync(join(tmpdir(), 'ash-log-selftest-'))
  const selfTest = join(root, 'SelfTest')
  const project = join(root, 'My project')
  const scripts = join(project, 'scripts', 'desktop')

  beforeAll(() => {
    execFileSync(
      '/usr/bin/swiftc',
      [...swiftcFlags(), '-D', 'ASHLOG_SELFTEST', '-o', selfTest, ...SWIFT_SOURCES, join(DESKTOP_DIR, '__fixtures__', 'SelfTest.swift')],
      { stdio: 'pipe' },
    )
  }, 180_000)

  afterAll(() => rmSync(root, { recursive: true, force: true }))

  interface Call {
    status: number | null
    lastLine: string | null
    missing: boolean | null
    ms: number
  }

  function writeScripts(files: Record<string, string>) {
    rmSync(project, { recursive: true, force: true })
    mkdirSync(scripts, { recursive: true })
    for (const [name, body] of Object.entries(files)) writeFileSync(join(scripts, name), body)
  }

  function quit(deadline: number, ...extra: string[]): Call[] {
    // SIGKILL: a hanging SelfTest must end the test, not keep it waiting on a polite SIGTERM.
    const out = execFileSync(selfTest, ['quit', project, String(deadline), ...extra], { encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL' })
    return (JSON.parse(out) as { calls: Call[] }).calls
  }

  it('keeps the pages of the app in the window and sends the rest to the browser, or nowhere', () => {
    const port = 5311
    const cases = [
      [{ url: `http://localhost:${port}/quests?q=1#x` }, 'window'],
      [{ url: `http://127.0.0.1:${port}/` }, 'window'],
      [{ url: `http://[::1]:${port}/map` }, 'window'],
      [{ url: `http://LOCALHOST:${port}/` }, 'window'],
      [{ url: `http://localhost:${port}/`, newWindow: true }, 'window'],
      [{ url: 'about:blank' }, 'window'],
      [{ url: 'blob:http://localhost:5311/2f1c' }, 'window'],
      [{ url: 'https://example.com/embed', subframe: true }, 'window'],
      [{ url: `http://localhost:${port + 1}/` }, 'browser'],
      [{ url: `https://localhost:${port}/` }, 'browser'],
      [{ url: `http://macbook-van-joost.local:${port}/pair?code=1` }, 'browser'],
      [{ url: 'https://dragonwilds.runescape.wiki/w/Quests', newWindow: true }, 'browser'],
      [{ url: 'https://creativecommons.org/licenses/by-nc-sa/3.0/' }, 'browser'],
      [{ url: 'mailto:joost@example.com' }, 'browser'],
      [{ url: `http://localhost:${port}/export.json`, download: true }, 'browser'],
      [{ url: 'about:blank', newWindow: true }, 'nowhere'],
      [{ url: 'blob:http://localhost:5311/2f1c', download: true }, 'nowhere'],
      [{ url: 'file:///Users/me/.ssh/id_ed25519' }, 'nowhere'],
      [{ url: 'file:///Applications/Calculator.app', newWindow: true }, 'nowhere'],
      [{ url: 'steam://run/1374490' }, 'nowhere'],
      [{ url: 'javascript:alert(1)', newWindow: true }, 'nowhere'],
    ] as const
    const out = execFileSync(selfTest, ['routes', String(port)], { input: JSON.stringify(cases.map(([c]) => c)), encoding: 'utf8' })
    const routes = JSON.parse(out) as string[]
    expect(cases.map(([c], i) => [c.url, routes[i]])).toEqual(cases.map(([c, route]) => [c.url, route]))
  })

  it('answers a quit once, at the deadline, when stop.sh hangs', { timeout: 30_000 }, () => {
    writeScripts({ 'stop.sh': 'echo $$ > stop.pid\nexec /bin/sleep 30\n' })
    try {
      const calls = quit(0.6)
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({ status: null })
      expect(calls[0].ms).toBeGreaterThanOrEqual(550)
      expect(calls[0].ms).toBeLessThan(1500)
    } finally {
      // The app quits without it; here it is only a sleep to clean up.
      try {
        process.kill(Number(readFileSync(join(project, 'stop.pid'), 'utf8').trim()), 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
  })

  it('answers a quit once, right away, when stop.sh fails', { timeout: 30_000 }, () => {
    writeScripts({ 'stop.sh': 'echo "The server on port 1 won\'t stop." >&2\nexit 1\n' })
    const calls = quit(1)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ status: 1, lastLine: "The server on port 1 won't stop.", missing: false })
    expect(calls[0].ms).toBeLessThan(900)
  })

  it('answers a quit once when the project folder is gone', { timeout: 30_000 }, () => {
    rmSync(project, { recursive: true, force: true })
    expect(quit(1)).toMatchObject([{ status: 127, missing: true }])
  })

  it('on a quit while starting, stops start.sh and lets it end before stop.sh runs', { timeout: 30_000 }, () => {
    // start.sh takes half a second to wind down after SIGTERM: stop.sh must still come after it.
    writeScripts({
      'start.sh': [
        'trap \'/bin/sleep 0.5; echo "start ended" >> order.log; exit 143\' TERM',
        'echo "start began" >> order.log',
        'i=0',
        'while [ "$i" -lt 100 ]; do /bin/sleep 0.1; i=$((i + 1)); done',
        'echo "start ran to the end" >> order.log',
        '',
      ].join('\n'),
      'stop.sh': 'echo "stop ran" >> order.log\n',
    })
    const calls = quit(5, 'pending-start')
    expect(calls).toMatchObject([{ status: 0 }])
    expect(readFileSync(join(project, 'order.log'), 'utf8').trim().split('\n')).toEqual(['start began', 'start ended', 'stop ran'])
  })
})

describe.skipIf(!hasSwift)('the built app', () => {
  // A stand-in project in a folder with a space, with the real desktop scripts and the
  // stand-in server of the launcher tests, and a node path with spaces, like Herd's.
  const root = mkdtempSync(join(tmpdir(), 'ash-log-app-'))
  const outDir = join(root, 'build')
  const project = join(root, 'My projects', 'Ash Log')
  const nodePath = join(root, 'Application Support', 'node', 'bin', 'node')
  const version = '1.2.3'
  let port = 0
  let app = ''
  let executable = ''

  const pidFile = () => join(project, '.local', 'server.pid')
  const health = () =>
    fetch(`http://127.0.0.1:${port}/api/health`).then(
      (r) => r.status,
      () => 0,
    )

  /** Runs the app in a headless mode with the bare PATH of a Dock app. */
  function headless(mode: string, extra: Record<string, string> = {}, bundle = app) {
    return spawnSync(join(bundle, 'Contents', 'MacOS', EXECUTABLE), [mode], {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: root,
        ASHENFALL_SERVER_ENTRY: 'server/app.mjs',
        ASHENFALL_VITE: join(DESKTOP_DIR, '__fixtures__', 'vite.mjs'),
        FIXTURE_RECORD: join(root, 'stop-requests.jsonl'),
        ...extra,
      },
    })
  }

  beforeAll(async () => {
    for (const dir of ['scripts/desktop', 'server', 'src', 'dist']) mkdirSync(join(project, dir), { recursive: true })
    writeFileSync(join(project, 'package.json'), JSON.stringify({ version }))
    for (const script of ['lib.sh', 'start.sh', 'stop.sh']) copyFileSync(join(DESKTOP_DIR, script), join(project, 'scripts/desktop', script))
    copyFileSync(join(DESKTOP_DIR, '__fixtures__', 'server.mjs'), join(project, 'server', 'app.mjs'))
    writeFileSync(join(project, 'src', 'main.ts'), '')
    writeFileSync(join(project, 'dist', 'index.html'), '')
    const past = new Date(Date.now() - 60_000)
    utimesSync(join(project, 'src', 'main.ts'), past, past)
    mkdirSync(dirname(nodePath), { recursive: true })
    symlinkSync(process.execPath, nodePath)
    port = await freePort()
    app = buildApp({ projectDir: project, nodePath, port, outDir })
    executable = join(app, 'Contents', 'MacOS', EXECUTABLE)
  }, 180_000)

  afterAll(() => {
    if (existsSync(pidFile())) {
      const pid = Number(readFileSync(pidFile(), 'utf8').trim())
      try {
        if (pid) process.kill(pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
    rmSync(root, { recursive: true, force: true })
  })

  it('is a signed bundle with the executable, the icon and the configuration', () => {
    expect(app).toBe(join(outDir, `${APP_NAME}.app`))
    const contents = join(app, 'Contents')
    expect(statSync(executable).mode & 0o111).not.toBe(0)
    expect(readFileSync(join(contents, 'PkgInfo'), 'utf8')).toBe('APPL????')
    expect(readFileSync(join(contents, 'Resources', 'AppIcon.icns')).equals(readFileSync(join(outDir, 'AppIcon.icns')))).toBe(true)

    const plist = plistToJson(join(contents, 'Info.plist'))
    expect(plist).toEqual(infoPlistValues({ projectDir: project, nodePath, port }, version))
    expect(plist).toMatchObject({ CFBundleIdentifier: BUNDLE_ID, CFBundleExecutable: EXECUTABLE, CFBundleIconFile: 'AppIcon' })

    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' })
  })

  it('is built for this Mac and the macOS version in Info.plist', () => {
    const arch = swiftTarget().split('-')[0]
    expect(execFileSync('/usr/bin/lipo', ['-archs', executable], { encoding: 'utf8' }).trim()).toBe(arch)
    expect(execFileSync('/usr/bin/otool', ['-l', executable], { encoding: 'utf8' })).toMatch(new RegExp(`minos ${MINIMUM_MACOS.replace('.', '\\.')}\\b`))
  })

  it('prints its configuration without opening a window', () => {
    const printed = headless('--print-config')
    expect(printed.stderr).toBe('')
    expect(printed.status).toBe(0)
    expect(JSON.parse(printed.stdout)).toEqual({
      projectDir: project,
      node: nodePath,
      port,
      appURL: `http://localhost:${port}/`,
      logFile: join(project, '.local', 'server.log'),
    })
  })

  it('starts the server through start.sh with the baked-in node and port, once, and stops it', { timeout: 60_000 }, async () => {
    const started = headless('--start-server')
    expect(started.stderr).toBe('')
    expect(started).toMatchObject({ status: 0, stdout: `The server is running at http://localhost:${port}/\n` })
    expect(await health()).toBe(200)
    const pid = Number(readFileSync(pidFile(), 'utf8').trim())
    expect(execFileSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' })).toContain(nodePath)

    expect(headless('--start-server')).toMatchObject({ status: 0, stdout: `The server is already running at http://localhost:${port}/\n` })
    expect(readFileSync(pidFile(), 'utf8').trim()).toBe(String(pid))

    expect(headless('--stop-server')).toMatchObject({ status: 0, stdout: 'The server has stopped.\n', stderr: '' })
    expect(existsSync(pidFile())).toBe(false)
    expect(await health()).toBe(0)
    const requests = readFileSync(join(root, 'stop-requests.jsonl'), 'utf8').trim().split('\n')
    expect(requests.map((line) => JSON.parse(line) as unknown)).toEqual([{ method: 'POST', contentType: 'application/json', body: '{}' }])
  })

  it('reports why the server did not start, in the words of start.sh', { timeout: 60_000 }, () => {
    const result = headless('--start-server', { FIXTURE_MODE: 'crash' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('The server stopped right away: Port 1234 is already in use (fixture).')
    expect(existsSync(pidFile())).toBe(false)
  })

  it('says so when the project folder is gone', () => {
    const scripts = join(project, 'scripts')
    renameSync(scripts, `${scripts}-gone`)
    try {
      const result = headless('--start-server')
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(`Can't find the Ash Log project folder: ${project}`)
    } finally {
      renameSync(`${scripts}-gone`, scripts)
    }
  })

  it('says so when Info.plist lacks its configuration', () => {
    const broken = join(root, 'broken', `${APP_NAME}.app`)
    execFileSync('/usr/bin/ditto', [app, broken])
    execFileSync('/usr/bin/plutil', ['-remove', CONFIG_KEYS.port, join(broken, 'Contents', 'Info.plist')])
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', broken], { stdio: 'pipe' })
    const result = headless('--print-config', {}, broken)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("Ash Log isn't installed correctly: AshLogPort is missing")
    expect(result.stderr).toContain('npm run app:install')
  })
})
