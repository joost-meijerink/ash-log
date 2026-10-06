/**
 * Ash Log in the Windows Start menu: what `npm run app:install` does on Windows (through
 * scripts/install.ts). Two shortcuts with the Ash Log icon, for this user only (no admin rights):
 *
 *   Ash Log           starts the server when needed and opens the window (launcher.ts --gui)
 *   Stop Ash Log      stops the server and closes the window (launcher.ts --gui --stop)
 *
 *   npm run app:install -- --desktop   also an Ash Log shortcut on the desktop
 *   npm run app:uninstall              stops Ash Log, removes the shortcuts and the browser
 *                                      profile of the window (%LOCALAPPDATA%\Ash Log)
 *
 * The shortcuts run node.exe itself, minimized, with launcher.ts: no PowerShell window and no
 * execution policy in the way, and no program of our own that Smart App Control would block.
 * They remember the project folder and this node (realpath for fnm, whose per-shell folders
 * disappear), like the Mac app does in its Info.plist: run the install again after moving the
 * project or switching Node. The port is read from .env at every start.
 *
 * The shortcuts themselves are made by shortcuts.ps1 (WScript.Shell in Windows PowerShell 5.1);
 * their details travel to it as JSON in an environment variable.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync, rmSync } from 'node:fs'
import { dirname, join, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeWindow, getEnv, LauncherError, powershellPath, PROJECT_DIR, realSystem, resolveConfig, stopServer } from './launcher.ts'

export const WINDOWS_DIR = dirname(fileURLToPath(import.meta.url))
export const SHORTCUTS_SCRIPT = join(WINDOWS_DIR, 'shortcuts.ps1')
export const ICON_FILE = join(WINDOWS_DIR, 'ash-log.ico')

export const SHORTCUT_NAMES = { open: 'Ash Log', stop: 'Stop Ash Log' } as const
/**
 * Start menu shortcuts of earlier versions (the Dutch name of the stop shortcut). Install and
 * uninstall remove them while they still start launcher.ts, so a reinstall leaves no duplicate.
 */
export const OBSOLETE_SHORTCUTS: readonly { folder: 'Programs'; name: string }[] = [{ folder: 'Programs', name: 'Ash Log stoppen' }]
/** SW_SHOWMINNOACTIVE: the console of node.exe starts minimized and closes once the window is open. */
export const WINDOW_MINIMIZED = 7

export interface ShortcutSpec {
  /** A System.Environment+SpecialFolder name: the Start menu of this user, or the desktop. */
  folder: 'Programs' | 'Desktop'
  name: string
  target: string
  arguments: string
  workingDirectory: string
  icon: string
  description: string
  windowStyle: number
}

/**
 * The node the shortcuts run: the one running this install. fnm runs node from a folder per
 * shell (fnm_multishells) that is gone after a reboot, so that one is resolved to the real path.
 * nvm-windows and the official installer keep a fixed folder, which survives an update.
 */
export function nodeForShortcut(execPath: string, realpath: (path: string) => string = realpathSync.native): string {
  if (!/[\\/]fnm_multishells[\\/]/i.test(execPath)) return execPath
  try {
    return realpath(execPath)
  } catch {
    return execPath
  }
}

/** One argument the way Node's own command line parsing on Windows reads it back (MSVCRT rules). */
export function quoteWindowsArg(arg: string): string {
  if (arg && !/[\s"]/.test(arg)) return arg
  let quoted = '"'
  let backslashes = 0
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes++
      continue
    }
    quoted += ch === '"' ? '\\'.repeat(backslashes * 2 + 1) + '"' : '\\'.repeat(backslashes) + ch
    backslashes = 0
  }
  return `${quoted}${'\\'.repeat(backslashes * 2)}"`
}

/**
 * The arguments of node.exe in a shortcut. A bare `--import tsx` resolves from the working
 * folder (the project), so a tsx update never breaks the shortcut.
 */
export function launcherArguments(launcherFile: string, extra: readonly string[] = []): string {
  return ['--import', 'tsx', launcherFile, '--gui', ...extra].map(quoteWindowsArg).join(' ')
}

export function shortcutSpecs(opts: { projectDir: string; nodePath: string; desktop: boolean; launcherFile?: string; iconFile?: string }): ShortcutSpec[] {
  const launcher = opts.launcherFile ?? join(opts.projectDir, 'scripts', 'windows', 'launcher.ts')
  const base = {
    target: opts.nodePath,
    workingDirectory: opts.projectDir,
    icon: opts.iconFile ?? join(opts.projectDir, 'scripts', 'windows', 'ash-log.ico'),
    windowStyle: WINDOW_MINIMIZED,
  }
  const open = { ...base, name: SHORTCUT_NAMES.open, arguments: launcherArguments(launcher), description: 'Ash Log: your progress log for RuneScape: Dragonwilds' }
  const specs: ShortcutSpec[] = [
    { ...open, folder: 'Programs' },
    { ...base, folder: 'Programs', name: SHORTCUT_NAMES.stop, arguments: launcherArguments(launcher, ['--stop']), description: 'Stop Ash Log: the server and the window' },
  ]
  if (opts.desktop) specs.push({ ...open, folder: 'Desktop' })
  return specs
}

export function shortcutsCommand(
  action: 'Install' | 'Uninstall',
  specs: ShortcutSpec[],
  env: NodeJS.ProcessEnv,
  script = SHORTCUTS_SCRIPT,
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  return {
    command: powershellPath(env),
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', action],
    env: { ...env, ASH_LOG_SHORTCUTS: JSON.stringify(specs), ASH_LOG_OBSOLETE_SHORTCUTS: JSON.stringify(OBSOLETE_SHORTCUTS) },
  }
}

export interface WindowsInstallDeps {
  projectDir: string
  execPath: string
  env: NodeJS.ProcessEnv
  exists(path: string): boolean
  realpath(path: string): string
  /** Runs a program in this console (output straight to the terminal). Returns its exit code. */
  run(command: string, args: readonly string[], env: NodeJS.ProcessEnv): number | null
  removeDir(path: string): void
  /** Stops Ash Log: the server and the window. */
  stop(): Promise<void>
  out(line: string): void
  err(line: string): void
}

export function realInstallDeps(): WindowsInstallDeps {
  return {
    projectDir: PROJECT_DIR,
    execPath: process.execPath,
    env: process.env,
    exists: existsSync,
    realpath: realpathSync.native,
    run: (command, args, env) => spawnSync(command, args, { env, stdio: 'inherit' }).status,
    removeDir: (path) => rmSync(path, { recursive: true, force: true, maxRetries: 3 }),
    async stop() {
      const sys = realSystem()
      const cfg = resolveConfig({ platform: sys.platform })
      await stopServer(cfg, sys)
      await closeWindow(cfg, sys)
    },
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  }
}

/** Makes the shortcuts. Resolves with the exit code. */
export async function installWindows(opts: { desktop: boolean }, deps: WindowsInstallDeps = realInstallDeps()): Promise<number> {
  const { projectDir } = deps
  const launcher = join(projectDir, 'scripts', 'windows', 'launcher.ts')
  const icon = join(projectDir, 'scripts', 'windows', 'ash-log.ico')
  const powershell = powershellPath(deps.env)
  const problems: [boolean, string][] = [
    [deps.exists(join(projectDir, 'node_modules', 'tsx')), `tsx is missing. Run npm install in ${projectDir} first.`],
    [deps.exists(launcher), `Launcher not found: ${launcher}`],
    [deps.exists(icon), `Icon not found: ${icon}`],
    [deps.exists(powershell), `Windows PowerShell not found at ${powershell}. It comes with Windows 10 and 11.`],
  ]
  const problem = problems.find(([ok]) => !ok)
  if (problem) {
    deps.err(problem[1])
    return 1
  }

  const nodePath = nodeForShortcut(deps.execPath, deps.realpath)
  const specs = shortcutSpecs({ projectDir, nodePath, desktop: opts.desktop, launcherFile: launcher, iconFile: icon })
  const { command, args, env } = shortcutsCommand('Install', specs, deps.env)
  const code = deps.run(command, args, env)
  if (code !== 0) {
    deps.err("Couldn't create the shortcuts (see above).")
    deps.err('You can also start without them: npm run app, then open http://localhost:5199 in your browser.')
    return 1
  }
  deps.out('')
  deps.out(`Ash Log is in your Start menu${opts.desktop ? ' and on your desktop' : ''}.`)
  deps.out('  Start:   click Ash Log. The window opens (the first time after a short build).')
  deps.out('  Stop:    close the window, or choose Stop Ash Log in the Start menu.')
  deps.out(`  Node:    ${nodePath}`)
  deps.out(`  Project: ${projectDir}`)
  deps.out('Moved the project folder or switched to another Node? Then run npm run app:install again.')
  return 0
}

/** Stops Ash Log and removes the shortcuts and the browser profile. Resolves with the exit code. */
export async function uninstallWindows(deps: WindowsInstallDeps = realInstallDeps()): Promise<number> {
  try {
    await deps.stop()
  } catch (err) {
    deps.err(err instanceof LauncherError ? err.message : `Couldn't stop Ash Log: ${(err as Error).message}`)
  }

  let failed = false
  const powershell = powershellPath(deps.env)
  if (deps.exists(powershell)) {
    // Every place a shortcut can be; shortcuts.ps1 skips the ones that are missing or not ours.
    const specs = shortcutSpecs({ projectDir: deps.projectDir, nodePath: deps.execPath, desktop: true })
    const { command, args, env } = shortcutsCommand('Uninstall', specs, deps.env)
    if (deps.run(command, args, env) !== 0) {
      deps.err("Couldn't remove the shortcuts (see above). Remove Ash Log and Stop Ash Log from the Start menu yourself.")
      failed = true
    }
  } else {
    deps.err(`Windows PowerShell not found at ${powershell}. Remove Ash Log and Stop Ash Log from the Start menu yourself.`)
    failed = true
  }

  const localAppData = getEnv(deps.env, 'LOCALAPPDATA', 'win32')
  const appData = localAppData ? win32.join(localAppData, 'Ash Log') : null
  if (appData && deps.exists(appData)) {
    try {
      deps.removeDir(appData)
      deps.out(`Removed: ${appData}`)
    } catch (err) {
      deps.err(`Can't remove ${appData} (${(err as Error).message}). Close the Ash Log window and try again.`)
      failed = true
    }
  }

  deps.out('')
  deps.out('Ash Log is removed from this PC. Your progress is still in data\\progress.json in the project folder.')
  return failed ? 1 : 0
}
