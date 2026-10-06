/**
 * Builds 'Ash Log.app' into scripts/desktop/build/ (npm run app:install builds it and copies
 * it to ~/Applications; see install-app.sh).
 *
 * The app is a small native macOS app: Swift with AppKit and WebKit (native/AshLog.swift),
 * compiled with swiftc. One Dock icon and one window that shows Ash Log in a WKWebView.
 * Starting and stopping the server stays in the shell scripts next to this file; the app
 * runs them:
 *
 *   launch             start.sh, unless an app server already answers on the port
 *   every 10 seconds   GET /api/health; when the server is gone the app offers to start it again
 *   Quit, logout       stop.sh
 *
 * Apps started from the Dock get no shell PATH, so the project folder, the absolute node path
 * and the port are baked into Info.plist (AshLogProjectDir, AshLogNode, AshLogPort). Check
 * what a build baked in with: "Ash Log.app/Contents/MacOS/AshLog" --print-config
 *
 *   npx tsx scripts/desktop/build-app.ts
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseEnv } from 'node:util'
import { parsePort } from '../../server/config.ts'
import { BUILD_DIR, DESKTOP_DIR, PROJECT_DIR, writeIcns } from './make-icons.ts'

export const APP_NAME = 'Ash Log'
export const BUNDLE_ID = 'nl.ashenfall.ashlog'
/** Contents/MacOS/<EXECUTABLE> inside the bundle. */
export const EXECUTABLE = 'AshLog'
/** LSMinimumSystemVersion and the swiftc deployment target. */
export const MINIMUM_MACOS = '13.0'
export const SWIFT_SOURCES = [join(DESKTOP_DIR, 'native', 'AshLog.swift')]

/** The Info.plist keys the app reads its configuration from (see AppConfig in AshLog.swift). */
export const CONFIG_KEYS = {
  projectDir: 'AshLogProjectDir',
  nodePath: 'AshLogNode',
  port: 'AshLogPort',
} as const

export interface AppConfig {
  /** Absolute path of the project (the folder with package.json). */
  projectDir: string
  /** Absolute path of the node binary the scripts run the server with. */
  nodePath: string
  /** Port of the app server. */
  port: number
}

/**
 * The port the app bakes in: ASHENFALL_PORT when set, else APP_PORT from .env (read with the
 * same parser as the server's loadEnv), else 5199.
 */
export function resolvePort(projectDir: string, env: NodeJS.ProcessEnv = process.env): number {
  if (env.ASHENFALL_PORT) return parsePort(env.ASHENFALL_PORT)
  const file = join(projectDir, '.env')
  return parsePort(existsSync(file) ? parseEnv(readFileSync(file, 'utf8')).APP_PORT : undefined)
}

function checkPath(label: string, value: string) {
  if (!isAbsolute(value)) throw new Error(`${label} must be an absolute path: ${value}`)
}

export type PlistValue = string | number | boolean | { [key: string]: PlistValue }

/** Everything in the app's Info.plist. */
export function infoPlistValues({ projectDir, nodePath, port }: AppConfig, version: string): Record<string, PlistValue> {
  checkPath('projectDir', projectDir)
  checkPath('nodePath', nodePath)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Not a port: ${port}`)
  return {
    CFBundleDevelopmentRegion: 'en',
    CFBundleName: APP_NAME,
    CFBundleDisplayName: APP_NAME,
    CFBundleIdentifier: BUNDLE_ID,
    CFBundleExecutable: EXECUTABLE,
    CFBundleIconFile: 'AppIcon',
    CFBundlePackageType: 'APPL',
    CFBundleInfoDictionaryVersion: '6.0',
    CFBundleShortVersionString: version,
    CFBundleVersion: version,
    LSMinimumSystemVersion: MINIMUM_MACOS,
    LSApplicationCategoryType: 'public.app-category.utilities',
    NSPrincipalClass: 'NSApplication',
    NSHighResolutionCapable: true,
    // The app must get the chance to stop the server on logout and shutdown.
    NSSupportsAutomaticTermination: false,
    NSSupportsSuddenTermination: false,
    // The window shows http://localhost:<port>.
    NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
    // The project lives in ~/Documents: the scripts the app runs read it.
    NSDocumentsFolderUsageDescription: 'Ash Log starts its local server from the project folder.',
    // For macOS the server the app starts belongs to the app, so its live mode asks in the app's name.
    NSLocalNetworkUsageDescription: 'So your phone can open Ash Log over Wi-Fi while Live on Wi-Fi is on.',
    [CONFIG_KEYS.projectDir]: projectDir,
    [CONFIG_KEYS.nodePath]: nodePath,
    [CONFIG_KEYS.port]: port,
  }
}

function xmlText(value: string): string {
  // XML 1.0 has no way to write most control characters.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new Error(`Control character in ${JSON.stringify(value)}`)
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function plistValue(value: PlistValue, indent: string): string {
  if (typeof value === 'string') return `${indent}<string>${xmlText(value)}</string>`
  if (typeof value === 'boolean') return `${indent}<${value}/>`
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new Error(`Only whole numbers go into the plist: ${value}`)
    return `${indent}<integer>${value}</integer>`
  }
  const entries = Object.entries(value).flatMap(([key, inner]) => [`${indent}\t<key>${xmlText(key)}</key>`, plistValue(inner, `${indent}\t`)])
  return [`${indent}<dict>`, ...entries, `${indent}</dict>`].join('\n')
}

/** Info.plist as XML. */
export function infoPlist(config: AppConfig, version: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
${plistValue(infoPlistValues(config, version), '')}
</plist>
`
}

/** The swiftc target for this Mac, e.g. arm64-apple-macos13.0. */
export function swiftTarget(arch: string = process.arch): string {
  return `${arch === 'x64' ? 'x86_64' : arch}-apple-macos${MINIMUM_MACOS}`
}

/** swiftc flags shared by the build and the tests. */
export function swiftcFlags(): string[] {
  return ['-parse-as-library', '-swift-version', '6', '-target', swiftTarget(), '-framework', 'AppKit', '-framework', 'WebKit']
}

/** Runs a tool quietly; a failure throws with the tool's stderr in the message. */
function run(command: string, args: string[]) {
  execFileSync(command, args, { stdio: 'pipe' })
}

export interface BuildOptions extends Omit<AppConfig, 'port'> {
  /** Port of the app server (default: resolvePort). */
  port?: number
  /** Folder the .app goes into (default scripts/desktop/build). */
  outDir?: string
  /** An existing .icns to use; rendered from the icon sources when left out. */
  icnsPath?: string
}

/**
 * Builds the app bundle and returns its path. macOS only; needs swiftc (Xcode or the
 * Command Line Tools).
 *
 * The bundle is assembled and signed in a temporary folder and then copied to `outDir`
 * without extended attributes: the project lives in ~/Documents, which iCloud Drive may
 * sync, and its file provider puts Finder info on bundle folders there that codesign
 * refuses. install-app.sh signs the installed copy again for the same reason.
 */
export function buildApp(options: BuildOptions): string {
  const outDir = options.outDir ?? BUILD_DIR
  const version = (JSON.parse(readFileSync(join(options.projectDir, 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0'
  if (!existsSync(options.nodePath)) throw new Error(`Node not found at ${options.nodePath}`)
  const config: AppConfig = {
    projectDir: options.projectDir,
    nodePath: options.nodePath,
    port: options.port ?? resolvePort(options.projectDir),
  }
  const plist = infoPlist(config, version)

  mkdirSync(outDir, { recursive: true })
  const icns = options.icnsPath ?? writeIcns(outDir)

  const staging = mkdtempSync(join(tmpdir(), 'ash-log-app-'))
  try {
    const staged = join(staging, `${APP_NAME}.app`)
    const contents = join(staged, 'Contents')
    mkdirSync(join(contents, 'MacOS'), { recursive: true })
    mkdirSync(join(contents, 'Resources'), { recursive: true })

    run('/usr/bin/swiftc', ['-O', ...swiftcFlags(), '-o', join(contents, 'MacOS', EXECUTABLE), ...SWIFT_SOURCES])
    writeFileSync(join(contents, 'Info.plist'), plist)
    run('/usr/bin/plutil', ['-lint', '-s', join(contents, 'Info.plist')])
    writeFileSync(join(contents, 'PkgInfo'), 'APPL????')
    copyFileSync(icns, join(contents, 'Resources', 'AppIcon.icns'))

    // Ad-hoc signature over the whole bundle (Info.plist included), so macOS accepts it as one app.
    run('/usr/bin/xattr', ['-cr', staged])
    run('/usr/bin/codesign', ['--force', '--sign', '-', staged])
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged])

    const app = join(outDir, `${APP_NAME}.app`)
    rmSync(app, { recursive: true, force: true })
    run('/usr/bin/ditto', ['--noextattr', '--norsrc', staged, app])
    return app
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = resolvePort(PROJECT_DIR)
  const app = buildApp({ projectDir: PROJECT_DIR, nodePath: process.execPath, port })
  console.log(`built: ${app}`)
  console.log(`node: ${process.execPath}`)
  console.log(`port: ${port}`)
}
