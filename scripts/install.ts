/**
 * npm run app:install: Ash Log as an app on this computer.
 *
 *   macOS    builds Ash Log.app and puts it in ~/Applications (scripts/desktop/install-app.sh)
 *   Windows  Ash Log and Stop Ash Log in the Start menu (scripts/windows/install.ts)
 *   other    not supported: npm run app starts the server in a terminal
 *
 *   npm run app:install -- --desktop   Windows: also a shortcut on the desktop
 *   npm run app:uninstall              (= npm run app:install -- --uninstall) removes it again
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isEntryPoint } from './sync/node-command.ts'

export const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))
export const MAC_INSTALLER = join(SCRIPTS_DIR, 'desktop', 'install-app.sh')

export const INSTALL_USAGE = [
  'Usage: npm run app:install [-- option]',
  '  --desktop     Windows: also a shortcut on the desktop',
  '  --uninstall   remove Ash Log again (also: npm run app:uninstall)',
].join('\n')

export interface InstallArgs {
  uninstall: boolean
  desktop: boolean
  help: boolean
}

export function parseInstallArgs(argv: readonly string[]): InstallArgs | { error: string } {
  const args: InstallArgs = { uninstall: false, desktop: false, help: false }
  for (const arg of argv) {
    if (arg === '--uninstall') args.uninstall = true
    else if (arg === '--desktop') args.desktop = true
    else if (arg === '--help' || arg === '-h') args.help = true
    else return { error: `Unknown option: ${arg}` }
  }
  if (args.uninstall && args.desktop) return { error: '--desktop goes with installing, not with --uninstall' }
  return args
}

export interface InstallDeps {
  platform: NodeJS.Platform
  /** Runs scripts/desktop/install-app.sh; returns its exit code. */
  installMac(): number | null
  installWindows(opts: { desktop: boolean }): Promise<number>
  uninstallWindows(): Promise<number>
  out(line: string): void
  err(line: string): void
}

export const MAC_UNINSTALL =
  'To remove Ash Log from your Mac: quit the app (Cmd+Q) and drag Ash Log from Applications in your home folder (~/Applications) to the Trash.'

export const UNSUPPORTED = [
  "Ash Log doesn't have an app for this system (yet). Start the server yourself in a terminal:",
  '  npm run app',
  'Then open http://localhost:5199 in your browser (or the port from APP_PORT in .env). Ctrl+C stops the server.',
].join('\n')

export async function runInstall(argv: readonly string[], deps: InstallDeps): Promise<number> {
  const args = parseInstallArgs(argv)
  if ('error' in args) {
    deps.err(args.error)
    deps.err(INSTALL_USAGE)
    return 2
  }
  if (args.help) {
    deps.out(INSTALL_USAGE)
    return 0
  }
  switch (deps.platform) {
    case 'darwin':
      if (args.uninstall) {
        deps.out(MAC_UNINSTALL)
        return 0
      }
      if (args.desktop) deps.out('--desktop is for Windows. On your Mac, drag Ash Log to the Dock yourself.')
      return deps.installMac() ?? 1
    case 'win32':
      return args.uninstall ? deps.uninstallWindows() : deps.installWindows({ desktop: args.desktop })
    default:
      deps.err(UNSUPPORTED)
      return 1
  }
}

export function realDeps(): InstallDeps {
  return {
    platform: process.platform,
    installMac: () => spawnSync('/bin/sh', [MAC_INSTALLER], { stdio: 'inherit' }).status,
    // Loaded only on Windows: the Windows installer has nothing to do elsewhere.
    installWindows: async (opts) => (await import('./windows/install.ts')).installWindows(opts),
    uninstallWindows: async () => (await import('./windows/install.ts')).uninstallWindows(),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  }
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  runInstall(process.argv.slice(2), realDeps()).then(
    (code) => {
      process.exitCode = code
    },
    (err: unknown) => {
      console.error(err)
      process.exitCode = 1
    },
  )
}
