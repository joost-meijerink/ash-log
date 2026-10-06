import { EventEmitter } from 'node:events'
import { spawn as realSpawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { CAFFEINATE, ES_CONTINUOUS_SYSTEM_REQUIRED, StayAwake, SYSTEMD_INHIBIT, awakeCommand, windowsAwakeScript, windowsPowerShell } from './awake.ts'

/** A stand-in child process: records kill() and can exit or fail on demand. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { exitCode: number | null; killed: boolean; kill: ReturnType<typeof vi.fn> }
  child.exitCode = null
  child.killed = false
  child.kill = vi.fn(() => {
    child.killed = true
    return true
  })
  return child
}

function setup(platform: NodeJS.Platform = 'darwin', env: NodeJS.ProcessEnv = {}) {
  const children: ReturnType<typeof fakeChild>[] = []
  const spawn = vi.fn((_command: string, _args: string[], _options: { stdio: 'ignore'; windowsHide: true }) => {
    const child = fakeChild()
    children.push(child)
    return child as unknown as ChildProcess
  })
  const logs: string[] = []
  const awake = new StayAwake({ spawn, platform, pid: 4242, env, log: (l) => logs.push(l) })
  return { awake, spawn, children, logs }
}

const decode = (base64: string) => Buffer.from(base64, 'base64').toString('utf16le')

describe('StayAwake', () => {
  it('runs caffeinate against idle sleep on macOS, tied to the server process', () => {
    const { awake, spawn } = setup()
    awake.start()
    expect(spawn).toHaveBeenCalledWith(CAFFEINATE, ['-i', '-w', '4242'], { stdio: 'ignore', windowsHide: true })
    expect(awake.active).toBe(true)
  })

  it('starts once and stops the same process', () => {
    const { awake, spawn, children } = setup()
    awake.start()
    awake.start()
    expect(spawn).toHaveBeenCalledTimes(1)
    awake.stop()
    expect(children[0]!.kill).toHaveBeenCalledWith('SIGTERM')
    expect(awake.active).toBe(false)
    awake.stop()
    expect(children[0]!.kill).toHaveBeenCalledTimes(1)
  })

  it('starts again after the helper exited on its own', () => {
    const { awake, spawn, children } = setup()
    awake.start()
    children[0]!.exitCode = 0
    children[0]!.emit('exit', 0)
    expect(awake.active).toBe(false)
    awake.start()
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('logs a failure to run the helper and carries on', () => {
    const { awake, children, logs } = setup('linux')
    awake.start()
    children[0]!.emit('error', new Error('spawn systemd-inhibit ENOENT'))
    expect(awake.active).toBe(false)
    expect(logs[0]).toContain('spawn systemd-inhibit ENOENT')
  })

  it('logs a helper that gave up (no rights, PowerShell blocked), but not one it stopped itself', () => {
    const { awake, children, logs } = setup('win32')
    awake.start()
    children[0]!.exitCode = 1
    children[0]!.emit('exit', 1)
    expect(awake.active).toBe(false)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatch(/^Couldn't keep the computer awake: .*powershell\.exe stopped with code 1/)

    awake.start()
    awake.stop()
    children[1]!.emit('exit', 1)
    expect(logs).toHaveLength(1)
  })

  it('never throws when spawning fails outright', () => {
    const logs: string[] = []
    const awake = new StayAwake({
      platform: 'win32',
      pid: 1,
      env: {},
      log: (l) => logs.push(l),
      spawn: () => {
        throw Object.assign(new Error('spawn EACCES'), { code: 'EACCES' })
      },
    })
    expect(() => awake.start()).not.toThrow()
    expect(awake.active).toBe(false)
    expect(logs[0]).toContain('spawn EACCES')
  })

  it('does nothing on a platform without a helper', () => {
    for (const platform of ['freebsd', 'openbsd', 'aix', 'sunos'] as const) {
      const { awake, spawn } = setup(platform)
      awake.start()
      expect(spawn, platform).not.toHaveBeenCalled()
      expect(awake.active).toBe(false)
    }
  })
})

describe('awakeCommand on Windows', () => {
  it('runs Windows PowerShell by its full path, hidden, without a profile', () => {
    const cmd = awakeCommand('win32', 4242, { SystemRoot: 'D:\\Win' })!
    expect(cmd.command).toBe('D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(cmd.args.slice(0, -1)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand'])
    expect(windowsPowerShell({})).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  })

  it('asks for ES_CONTINUOUS | ES_SYSTEM_REQUIRED, checks it took, and waits for the server process', () => {
    const cmd = awakeCommand('win32', 4242, {})!
    const script = decode(cmd.args.at(-1)!)
    expect(script).toBe(windowsAwakeScript(4242))
    expect(ES_CONTINUOUS_SYSTEM_REQUIRED).toBe(0x80000001)
    expect(script).toContain(`[uint32]${0x80000001}`)
    expect(script).toContain('SetThreadExecutionState($flags) -ne $flags) { exit 2 }')
    expect(script).toContain('Wait-Process -Id 4242')
    // No display flag: the screen may still turn off.
    expect(script).not.toMatch(/0x2\b|ES_DISPLAY_REQUIRED/)
  })

  it('refuses a pid that is not a positive whole number', () => {
    for (const pid of [0, -1, 1.5, Number.NaN]) expect(() => windowsAwakeScript(pid), String(pid)).toThrow(/process id/)
  })
})

describe('awakeCommand on Linux', () => {
  it('holds a systemd-inhibit lock while the server process lives', () => {
    const cmd = awakeCommand('linux', 4242)!
    expect(cmd.command).toBe(SYSTEMD_INHIBIT)
    expect(cmd.args).toContain('--mode=block')
    expect(cmd.args).toContain('--what=idle:sleep')
    const sh = cmd.args.indexOf('sh')
    expect(cmd.args.slice(sh)).toEqual(['sh', '-c', 'while kill -0 "$1" 2>/dev/null; do sleep 10; done', 'ash-log-awake', '4242'])
  })
})

/** A real Node process that lives `ms` milliseconds, to tie a real helper to. */
function shortLived(ms: number): ChildProcess {
  return realSpawn(process.execPath, ['-e', `setTimeout(() => {}, ${ms})`], { stdio: 'ignore', windowsHide: true })
}

function exitOf(child: ChildProcess): Promise<{ code: number | null; ms: number }> {
  const t0 = Date.now()
  return new Promise((resolve) => child.once('exit', (code) => resolve({ code, ms: Date.now() - t0 })))
}

describe.runIf(process.platform === 'darwin' && existsSync(CAFFEINATE))('on this Mac', () => {
  it('caffeinate ends by itself when the server process is gone', { timeout: 20_000 }, async () => {
    const server = shortLived(800)
    let helper: ChildProcess | undefined
    const awake = new StayAwake({ pid: server.pid!, spawn: (c, a, o) => (helper = realSpawn(c, a, o)) })
    awake.start()
    expect(awake.active).toBe(true)
    const { code, ms } = await exitOf(helper!)
    expect(code).toBe(0)
    expect(ms).toBeLessThan(10_000)
    expect(awake.active).toBe(false)
  })
})

describe.runIf(process.platform === 'win32')('on this Windows computer', () => {
  it('the PowerShell helper keeps the system awake and ends when the server process is gone', { timeout: 60_000 }, async () => {
    const server = shortLived(8000)
    let helper: ChildProcess | undefined
    const logs: string[] = []
    const awake = new StayAwake({ pid: server.pid!, log: (l) => logs.push(l), spawn: (c, a, o) => (helper = realSpawn(c, a, o)) })
    awake.start()
    const { code } = await exitOf(helper!)
    // 0: Add-Type worked, the second SetThreadExecutionState call returned the flags, and
    // Wait-Process returned when the short-lived process ended (2 or 1 would mean a failure).
    expect(code).toBe(0)
    expect(logs).toEqual([])
    server.kill()
  })
})
