// The Windows install (install.ts) and its shortcut script (shortcuts.ps1). PowerShell does
// not run here: the tests check what goes in, and that the script reads what install.ts writes.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ICON_FILE,
  installWindows,
  launcherArguments,
  nodeForShortcut,
  quoteWindowsArg,
  SHORTCUTS_SCRIPT,
  shortcutsCommand,
  shortcutSpecs,
  uninstallWindows,
  WINDOW_MINIMIZED,
  type ShortcutSpec,
  type WindowsInstallDeps,
} from './install.ts'
import { LAUNCHER_FILE } from './launcher.ts'

/**
 * How the Microsoft C runtime splits a command line into argv (what node.exe sees), for
 * checking quoteWindowsArg both ways: 2n backslashes before a quote are n backslashes and the
 * quote toggles; 2n+1 are n backslashes and a literal quote; other backslashes stay.
 */
function parseCommandLine(line: string): string[] {
  const args: string[] = []
  let current = ''
  let inQuotes = false
  let started = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (ch === '\\') {
      let n = 0
      while (line[i] === '\\') {
        n++
        i++
      }
      if (line[i] === '"') {
        current += '\\'.repeat(n >> 1)
        if (n % 2) current += '"'
        else inQuotes = !inQuotes
      } else {
        current += '\\'.repeat(n)
        i--
      }
      started = true
    } else if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i++
      } else inQuotes = !inQuotes
      started = true
    } else if ((ch === ' ' || ch === '\t') && !inQuotes) {
      if (started) args.push(current)
      current = ''
      started = false
    } else {
      current += ch
      started = true
    }
  }
  if (started) args.push(current)
  return args
}

const PROJECT = 'C:\\Users\\Jan de Vries\\OneDrive - Thuis\\Documenten\\Ash Log (kopie)'
const NODE = 'C:\\Program Files\\nodejs\\node.exe'

describe('quoteWindowsArg', () => {
  it('leaves plain arguments alone and quotes the rest', () => {
    expect(quoteWindowsArg('--gui')).toBe('--gui')
    expect(quoteWindowsArg('C:\\Users\\jan\\launcher.ts')).toBe('C:\\Users\\jan\\launcher.ts')
    expect(quoteWindowsArg('C:\\Users\\Jan de Vries\\launcher.ts')).toBe('"C:\\Users\\Jan de Vries\\launcher.ts"')
    expect(quoteWindowsArg('')).toBe('""')
    expect(quoteWindowsArg('C:\\a b\\')).toBe('"C:\\a b\\\\"')
  })

  it('round-trips through the C runtime rules, whatever is in the path', () => {
    const samples = ['C:\\Users\\Jürgen Ölçek\\Документы\\launcher.ts', 'a "quoted" b', 'ends with \\', 'x\\\\"y', '\\\\server\\share\\a b', 'tab\there', '%PATH% & ^ | < >']
    for (const sample of samples) {
      expect(parseCommandLine(['node.exe', ...[sample, '--gui'].map(quoteWindowsArg)].join(' ')).slice(1)).toEqual([sample, '--gui'])
    }
  })
})

describe('nodeForShortcut', () => {
  it('keeps a fixed node, resolves a per-shell one from fnm', () => {
    const realpath = (path: string) => (path.includes('fnm_multishells') ? 'C:\\Users\\jan\\AppData\\Roaming\\fnm\\node-versions\\v24.1.0\\installation\\node.exe' : path)
    expect(nodeForShortcut(NODE, realpath)).toBe(NODE)
    expect(nodeForShortcut('C:\\Users\\jan\\AppData\\Roaming\\nvm\\v24.1.0\\node.exe', realpath)).toBe('C:\\Users\\jan\\AppData\\Roaming\\nvm\\v24.1.0\\node.exe')
    expect(nodeForShortcut('C:\\Users\\jan\\AppData\\Local\\fnm_multishells\\1234_5678\\node.exe', realpath)).toBe(
      'C:\\Users\\jan\\AppData\\Roaming\\fnm\\node-versions\\v24.1.0\\installation\\node.exe',
    )
    const broken = () => {
      throw new Error('gone')
    }
    expect(nodeForShortcut('C:\\x\\fnm_multishells\\1\\node.exe', broken)).toBe('C:\\x\\fnm_multishells\\1\\node.exe')
  })
})

describe('shortcuts', () => {
  const launcher = `${PROJECT}\\scripts\\windows\\launcher.ts`
  const icon = `${PROJECT}\\scripts\\windows\\ash-log.ico`

  it('start node.exe with tsx and the launcher, quoted once', () => {
    expect(launcherArguments(launcher)).toBe(`--import tsx "${launcher}" --gui`)
    expect(launcherArguments(launcher, ['--stop'])).toBe(`--import tsx "${launcher}" --gui --stop`)
    expect(parseCommandLine(`node.exe ${launcherArguments(launcher, ['--stop'])}`)).toEqual(['node.exe', '--import', 'tsx', launcher, '--gui', '--stop'])
  })

  it('are Ash Log and Ash Log stoppen in the Start menu, minimized, with the icon', () => {
    const specs = shortcutSpecs({ projectDir: PROJECT, nodePath: NODE, desktop: false, launcherFile: launcher, iconFile: icon })
    expect(specs).toEqual([
      {
        folder: 'Programs',
        name: 'Ash Log',
        target: NODE,
        arguments: `--import tsx "${launcher}" --gui`,
        workingDirectory: PROJECT,
        icon,
        description: 'Ash Log: je logboek voor RuneScape: Dragonwilds',
        windowStyle: WINDOW_MINIMIZED,
      },
      {
        folder: 'Programs',
        name: 'Ash Log stoppen',
        target: NODE,
        arguments: `--import tsx "${launcher}" --gui --stop`,
        workingDirectory: PROJECT,
        icon,
        description: 'Ash Log stoppen: de server en het venster',
        windowStyle: WINDOW_MINIMIZED,
      },
    ])
    const withDesktop = shortcutSpecs({ projectDir: PROJECT, nodePath: NODE, desktop: true, launcherFile: launcher, iconFile: icon })
    expect(withDesktop[2]).toEqual({ ...specs[0], folder: 'Desktop' })
  })

  it('travel to Windows PowerShell as JSON in the environment', () => {
    const specs = shortcutSpecs({ projectDir: PROJECT, nodePath: NODE, desktop: false, launcherFile: launcher, iconFile: icon })
    const command = shortcutsCommand('Install', specs, { SystemRoot: 'C:\\WINDOWS', Path: 'x' })
    expect(command.command).toBe('C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(command.args).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SHORTCUTS_SCRIPT, '-Action', 'Install'])
    expect(JSON.parse(String(command.env.ASH_LOG_SHORTCUTS))).toEqual(specs)
    expect(command.env.Path).toBe('x')
  })
})

describe('shortcuts.ps1', () => {
  const script = readFileSync(SHORTCUTS_SCRIPT, 'utf8')

  it('is plain ASCII, so Windows PowerShell 5.1 reads it right without a BOM', () => {
    expect([...script].filter((ch) => ch.charCodeAt(0) > 0x7e || (ch.charCodeAt(0) < 0x20 && ch !== '\n' && ch !== '\r'))).toEqual([])
  })

  it('reads every field install.ts writes, and nothing else', () => {
    const fields = new Set([...script.matchAll(/\$shortcut\.(\w+)/g)].map((m) => m[1]))
    const spec: ShortcutSpec = shortcutSpecs({ projectDir: PROJECT, nodePath: NODE, desktop: false })[0]!
    expect([...fields].sort()).toEqual(Object.keys(spec).sort())
  })

  it('removes only shortcuts that start this launcher', () => {
    expect(script).toContain("-like '*launcher.ts*'")
    expect(launcherArguments(LAUNCHER_FILE)).toContain('launcher.ts')
    expect(script).toMatch(/\[ValidateSet\('Install', 'Uninstall'\)\]/)
  })

  it('parses the JSON as an argument (in a pipeline, PowerShell 5.1 would hand over the array as one item)', () => {
    expect(script).toContain('ConvertFrom-Json -InputObject $env:ASH_LOG_SHORTCUTS')
  })
})

describe('installWindows and uninstallWindows', () => {
  interface Fake extends WindowsInstallDeps {
    calls: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv }[]
    removed: string[]
    lines: string[]
    stops: number
  }
  const ENV = { SystemRoot: 'C:\\WINDOWS', LOCALAPPDATA: 'C:\\Users\\Jan de Vries\\AppData\\Local' }
  function fake(opts: { missing?: string; code?: number; stopError?: Error } = {}): Fake {
    const deps: Fake = {
      projectDir: PROJECT,
      execPath: 'C:\\Users\\jan\\AppData\\Local\\fnm_multishells\\1_2\\node.exe',
      env: ENV,
      calls: [],
      removed: [],
      lines: [],
      stops: 0,
      exists: (path) => !opts.missing || !path.endsWith(opts.missing),
      realpath: () => NODE,
      run(command, args, env) {
        deps.calls.push({ command, args, env })
        return opts.code ?? 0
      },
      removeDir: (path) => deps.removed.push(path),
      async stop() {
        deps.stops++
        if (opts.stopError) throw opts.stopError
      },
      out: (line) => deps.lines.push(line),
      err: (line) => deps.lines.push(`ERR ${line}`),
    }
    return deps
  }

  it('makes the shortcuts with the real node path and says how to use them', async () => {
    const deps = fake()
    expect(await installWindows({ desktop: true }, deps)).toBe(0)
    expect(deps.calls).toHaveLength(1)
    expect(deps.calls[0]!.command).toBe('C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(deps.calls[0]!.args.at(-1)).toBe('Install')
    const specs = JSON.parse(String(deps.calls[0]!.env.ASH_LOG_SHORTCUTS)) as ShortcutSpec[]
    expect(specs.map((s) => `${s.folder}/${s.name}`)).toEqual(['Programs/Ash Log', 'Programs/Ash Log stoppen', 'Desktop/Ash Log'])
    expect(specs.every((s) => s.target === NODE && s.workingDirectory === PROJECT)).toBe(true)
    expect(specs[0]!.icon).toBe(join(PROJECT, 'scripts', 'windows', 'ash-log.ico'))
    expect(deps.lines).toContain('Ash Log staat in je Startmenu en op je bureaublad.')
    expect(deps.lines).toContain(`  Node:    ${NODE}`)
  })

  it('stops before it starts when something is missing', async () => {
    for (const [missing, message] of [
      ['tsx', /tsx ontbreekt\. Draai eerst npm install/],
      ['launcher.ts', /Launcher niet gevonden/],
      ['ash-log.ico', /Icoon niet gevonden/],
      ['powershell.exe', /Windows PowerShell niet gevonden/],
    ] as const) {
      const deps = fake({ missing })
      expect(await installWindows({ desktop: false }, deps)).toBe(1)
      expect(deps.calls).toEqual([])
      expect(deps.lines.join('\n')).toMatch(message)
    }
  })

  it('reports a failed PowerShell run and the way around it', async () => {
    const deps = fake({ code: 1 })
    expect(await installWindows({ desktop: false }, deps)).toBe(1)
    expect(deps.lines).toContain('ERR Snelkoppelingen maken is mislukt (zie hierboven).')
  })

  it('stops Ash Log, then removes every shortcut and the browser profile', async () => {
    const deps = fake()
    expect(await uninstallWindows(deps)).toBe(0)
    expect(deps.stops).toBe(1)
    expect(deps.calls[0]!.args.at(-1)).toBe('Uninstall')
    const specs = JSON.parse(String(deps.calls[0]!.env.ASH_LOG_SHORTCUTS)) as ShortcutSpec[]
    expect(specs.map((s) => `${s.folder}/${s.name}`)).toEqual(['Programs/Ash Log', 'Programs/Ash Log stoppen', 'Desktop/Ash Log'])
    expect(deps.removed).toEqual(['C:\\Users\\Jan de Vries\\AppData\\Local\\Ash Log'])
  })

  it('leaves out the browser profile when there is none', async () => {
    const deps = fake({ missing: 'Ash Log' })
    expect(await uninstallWindows(deps)).toBe(0)
    expect(deps.removed).toEqual([])
    expect(deps.lines.join('\n')).not.toMatch(/Weggehaald/)
  })

  it('goes on when stopping fails, and reports what it could not do', async () => {
    const deps = fake({ stopError: new Error('kapot'), code: 1 })
    expect(await uninstallWindows(deps)).toBe(1)
    expect(deps.lines[0]).toBe('ERR Ash Log stoppen lukte niet: kapot')
    expect(deps.removed).toHaveLength(1)
    expect(deps.lines.join('\n')).toMatch(/Haal Ash Log en Ash Log stoppen zelf uit het Startmenu/)
  })
})

describe('the icon', () => {
  it('is the one make-icons writes', () => {
    expect(ICON_FILE).toBe(join(LAUNCHER_FILE, '..', 'ash-log.ico'))
  })
})
