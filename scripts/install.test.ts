// npm run app:install: the dispatcher per platform (scripts/install.ts).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type InstallDeps, MAC_INSTALLER, MAC_UNINSTALL, parseInstallArgs, runInstall, SCRIPTS_DIR, UNSUPPORTED } from './install.ts'

function fake(platform: NodeJS.Platform, codes: { mac?: number | null; windows?: number } = {}) {
  const calls: string[] = []
  const lines: string[] = []
  const deps: InstallDeps = {
    platform,
    installMac: () => {
      calls.push('mac')
      return codes.mac === undefined ? 0 : codes.mac
    },
    installWindows: async (opts) => {
      calls.push(`windows desktop=${opts.desktop}`)
      return codes.windows ?? 0
    },
    uninstallWindows: async () => {
      calls.push('windows uninstall')
      return codes.windows ?? 0
    },
    out: (line) => lines.push(line),
    err: (line) => lines.push(`ERR ${line}`),
  }
  return { deps, calls, lines }
}

describe('parseInstallArgs', () => {
  it('knows --desktop, --uninstall and --help', () => {
    expect(parseInstallArgs([])).toEqual({ uninstall: false, desktop: false, help: false })
    expect(parseInstallArgs(['--desktop'])).toEqual({ uninstall: false, desktop: true, help: false })
    expect(parseInstallArgs(['--uninstall'])).toEqual({ uninstall: true, desktop: false, help: false })
    expect(parseInstallArgs(['--uninstall', '--desktop'])).toHaveProperty('error')
    expect(parseInstallArgs(['--Desktop'])).toEqual({ error: 'Unknown option: --Desktop' })
  })
})

describe('runInstall', () => {
  it('builds the Mac app on macOS and passes on its exit code', async () => {
    const ok = fake('darwin')
    expect(await runInstall([], ok.deps)).toBe(0)
    expect(ok.calls).toEqual(['mac'])
    expect(await runInstall([], fake('darwin', { mac: 3 }).deps)).toBe(3)
    expect(await runInstall([], fake('darwin', { mac: null }).deps)).toBe(1)
  })

  it('explains how to remove the Mac app instead of deleting it', async () => {
    const { deps, calls, lines } = fake('darwin')
    expect(await runInstall(['--uninstall'], deps)).toBe(0)
    expect(calls).toEqual([])
    expect(lines).toEqual([MAC_UNINSTALL])
  })

  it('notes that --desktop is for Windows, and installs anyway', async () => {
    const { deps, calls, lines } = fake('darwin')
    expect(await runInstall(['--desktop'], deps)).toBe(0)
    expect(calls).toEqual(['mac'])
    expect(lines[0]).toMatch(/--desktop is for Windows/)
  })

  it('makes or removes the shortcuts on Windows', async () => {
    const install = fake('win32')
    expect(await runInstall(['--desktop'], install.deps)).toBe(0)
    expect(install.calls).toEqual(['windows desktop=true'])
    const uninstall = fake('win32', { windows: 1 })
    expect(await runInstall(['--uninstall'], uninstall.deps)).toBe(1)
    expect(uninstall.calls).toEqual(['windows uninstall'])
  })

  it('points to npm run app elsewhere', async () => {
    const { deps, calls, lines } = fake('linux')
    expect(await runInstall([], deps)).toBe(1)
    expect(calls).toEqual([])
    expect(lines).toEqual([`ERR ${UNSUPPORTED}`])
  })

  it('refuses unknown options with the usage, and prints the usage on --help', async () => {
    const bad = fake('win32')
    expect(await runInstall(['--force'], bad.deps)).toBe(2)
    expect(bad.calls).toEqual([])
    expect(bad.lines[0]).toBe('ERR Unknown option: --force')
    const help = fake('win32')
    expect(await runInstall(['--help'], help.deps)).toBe(0)
    expect(help.lines[0]).toMatch(/^Usage: npm run app:install/)
  })
})

describe('package.json', () => {
  const pkg = JSON.parse(readFileSync(join(SCRIPTS_DIR, '..', 'package.json'), 'utf8')) as { scripts: Record<string, string>; engines?: { node?: string } }

  it('runs this dispatcher for app:install and app:uninstall', () => {
    expect(pkg.scripts['app:install']).toBe('tsx scripts/install.ts')
    expect(pkg.scripts['app:uninstall']).toBe('tsx scripts/install.ts --uninstall')
    expect(existsSync(MAC_INSTALLER)).toBe(true)
  })

  it('asks for a Node that Vite and the scripts run on', () => {
    expect(pkg.engines?.node).toBe('>=22.12.0')
    const [major, minor] = process.versions.node.split('.').map(Number)
    expect(major! > 22 || (major === 22 && minor! >= 12)).toBe(true)
  })
})
