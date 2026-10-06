import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { isEntryPoint, nodeTsCommand, tsxLoaderUrl } from './node-command'

describe('tsxLoaderUrl', () => {
  it('is a file URL of the loader tsx exports', () => {
    expect(tsxLoaderUrl()).toMatch(/^file:\/\/\/.*\/node_modules\/tsx\/dist\/loader\.mjs$/)
  })

  it('turns a Windows path with spaces into a URL --import accepts', () => {
    const url = tsxLoaderUrl(
      () => 'C:\\Users\\Joost M\\Ash Log\\node_modules\\tsx\\dist\\loader.mjs',
      (path) => pathToFileURL(path, { windows: true }).href,
    )
    expect(url).toBe('file:///C:/Users/Joost%20M/Ash%20Log/node_modules/tsx/dist/loader.mjs')
  })
})

describe('nodeTsCommand', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ash log node-command '))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('runs a TypeScript file in one Node process, spaces in paths and arguments included', () => {
    const script = join(dir, 'hello world.ts')
    writeFileSync(
      script,
      [
        `import { isEntryPoint } from ${JSON.stringify(new URL('./node-command.ts', import.meta.url).href)}`,
        'const answer: number = 41',
        'console.log(JSON.stringify({ answer: answer + 1, args: process.argv.slice(2), main: isEntryPoint(import.meta.url, process.argv[1]), pid: process.pid }))',
        '',
      ].join('\n'),
    )
    const { command, args } = nodeTsCommand(script, ['--only=map', 'a b'])
    expect(command).toBe(process.execPath)
    const result = spawnSync(command, args, { encoding: 'utf8', cwd: dir, timeout: 30_000 })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    const out = JSON.parse(result.stdout) as { answer: number; args: string[]; main: boolean; pid: number }
    expect(out).toMatchObject({ answer: 42, args: ['--only=map', 'a b'], main: true })
    expect(out.pid).toBe(result.pid)
    // A real Node start with tsx: well over the default 5 s while the whole suite runs in parallel.
  }, 30_000)
})

describe('isEntryPoint', () => {
  const win = { platform: 'win32' as const, realpath: (p: string) => p }
  const mac = { platform: 'darwin' as const, realpath: (p: string) => p }

  it('matches the script Node was started with', () => {
    expect(isEntryPoint('file:///Users/joost/ash/scripts/sync/index.ts', '/Users/joost/ash/scripts/sync/index.ts', mac)).toBe(true)
    expect(isEntryPoint('file:///Users/joost/ash/scripts/sync/index.ts', '/Users/joost/ash/server/app.ts', mac)).toBe(false)
    expect(isEntryPoint('file:///Users/joost/ash/scripts/sync/index.ts', undefined, mac)).toBe(false)
  })

  it('ignores the case of a Windows drive letter and path', () => {
    const url = 'file:///C:/Users/Joost%20M/Ash%20Log/scripts/sync/index.ts'
    expect(isEntryPoint(url, 'c:\\Users\\Joost M\\Ash Log\\scripts\\sync\\index.ts', win)).toBe(true)
    expect(isEntryPoint(url, 'C:\\USERS\\joost m\\ash log\\scripts\\sync\\index.ts', win)).toBe(true)
    expect(isEntryPoint(url, 'C:\\Users\\Joost M\\Ash Log\\server\\app.ts', win)).toBe(false)
  })

  it('follows symlinks and junctions on both sides', () => {
    const realpath = (p: string) => p.replace('D:\\link', 'C:\\Users\\Joost\\Ash Log')
    const url = 'file:///C:/Users/Joost/Ash%20Log/server/app.ts'
    expect(isEntryPoint(url, 'D:\\link\\server\\app.ts', { platform: 'win32', realpath })).toBe(true)
  })

  it('says no to a URL that is not a file', () => {
    expect(isEntryPoint('data:text/javascript,1', '/x.ts', mac)).toBe(false)
  })
})
