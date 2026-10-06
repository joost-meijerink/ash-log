// Keeps this computer from idle-sleeping while live mode is on: a phone can only reach the app
// server while the computer is awake, and nobody touches it while they use the phone. The
// display may still turn off, and closing a laptop lid still sleeps it. Never needs admin
// rights, and every helper ends by itself when the server process is gone, even after a crash.
//
// - macOS: caffeinate -i -w <pid>.
// - Windows: a hidden Windows PowerShell that calls SetThreadExecutionState(ES_CONTINUOUS |
//   ES_SYSTEM_REQUIRED) and then waits for the server process; the request ends with it.
// - Linux: systemd-inhibit (when there is one) around a shell loop that waits for the server.
//
// Failing to keep awake is never fatal: it is logged and live mode carries on.

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { win32 } from 'node:path'

export const CAFFEINATE = '/usr/bin/caffeinate'
export const SYSTEMD_INHIBIT = 'systemd-inhibit'

/** ES_CONTINUOUS | ES_SYSTEM_REQUIRED (winbase.h): no idle sleep while the calling thread lives. */
export const ES_CONTINUOUS_SYSTEM_REQUIRED = 0x80000001

export interface AwakeCommand {
  command: string
  args: string[]
}

/** Windows PowerShell 5.1, which every Windows 10 and 11 has, by full path (not via PATH). */
export function windowsPowerShell(env: NodeJS.ProcessEnv = process.env): string {
  return win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/** The PowerShell script: keep the system awake from this thread, then wait for `pid` to end. */
export function windowsAwakeScript(pid: number): string {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Ongeldig proces-id: ${pid}`)
  return [
    "$ErrorActionPreference = 'Stop'",
    `Add-Type -Namespace AshLog -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'`,
    `$flags = [uint32]${ES_CONTINUOUS_SYSTEM_REQUIRED}`,
    // The second call returns what the first one set: proof that it worked (the first call
    // returns the state before it, which may be 0 even on success).
    '$null = [AshLog.Power]::SetThreadExecutionState($flags)',
    'if ([AshLog.Power]::SetThreadExecutionState($flags) -ne $flags) { exit 2 }',
    // The request belongs to this thread, so it ends when this process ends: on stop() (killed)
    // or when the server is gone (Wait-Process returns, or fails because it already is).
    `try { Wait-Process -Id ${pid} } catch { }`,
  ].join('\n')
}

/** -EncodedCommand takes the script as base64 of UTF-16LE: no quoting through the command line. */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/** The helper that keeps this computer awake until `pid` exits, or null where there is none. */
export function awakeCommand(platform: NodeJS.Platform, pid: number, env: NodeJS.ProcessEnv = process.env): AwakeCommand | null {
  switch (platform) {
    case 'darwin':
      return { command: CAFFEINATE, args: ['-i', '-w', String(pid)] }
    case 'win32':
      return {
        command: windowsPowerShell(env),
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encodePowerShell(windowsAwakeScript(pid))],
      }
    case 'linux':
      return {
        command: SYSTEMD_INHIBIT,
        args: [
          '--what=idle:sleep',
          '--who=Ash Log',
          '--why=Live op wifi: je telefoon gebruikt het Logboek',
          '--mode=block',
          'sh',
          '-c',
          'while kill -0 "$1" 2>/dev/null; do sleep 10; done',
          'ash-log-awake',
          String(pid),
        ],
      }
    default:
      return null
  }
}

export interface StayAwakeOptions {
  spawn?: (command: string, args: string[], options: { stdio: 'ignore'; windowsHide: true }) => ChildProcess | undefined
  log?: (line: string) => void
  platform?: NodeJS.Platform
  pid?: number
  env?: NodeJS.ProcessEnv
}

export class StayAwake {
  private child: ChildProcess | null = null
  private readonly spawn: NonNullable<StayAwakeOptions['spawn']>
  private readonly log: (line: string) => void
  private readonly platform: NodeJS.Platform
  private readonly pid: number
  private readonly env: NodeJS.ProcessEnv

  constructor(opts: StayAwakeOptions = {}) {
    this.spawn = opts.spawn ?? nodeSpawn
    this.log = opts.log ?? (() => {})
    this.platform = opts.platform ?? process.platform
    this.pid = opts.pid ?? process.pid
    this.env = opts.env ?? process.env
  }

  get active(): boolean {
    return this.child !== null
  }

  /** Starts preventing idle sleep. Does nothing when already active or on a platform without a helper. */
  start(): void {
    if (this.child) return
    const cmd = awakeCommand(this.platform, this.pid, this.env)
    if (!cmd) return
    let child: ChildProcess | undefined
    try {
      child = this.spawn(cmd.command, cmd.args, { stdio: 'ignore', windowsHide: true })
    } catch (err) {
      this.log(`Wakker houden lukt niet: ${(err as Error).message}`)
      return
    }
    if (!child) return
    child.on('error', (err) => {
      this.log(`Wakker houden lukt niet: ${err.message}`)
      if (this.child === child) this.child = null
    })
    child.on('exit', (code) => {
      if (this.child !== child) return
      this.child = null
      // Not stopped by us: the helper could not do its work (no rights, blocked PowerShell).
      if (code !== null && code !== 0) this.log(`Wakker houden lukt niet: ${cmd.command} stopte met code ${code}. De computer kan nu in slaap vallen.`)
    })
    this.child = child
  }

  /** Lets the computer sleep again. */
  stop(): void {
    const child = this.child
    this.child = null
    if (!child || child.exitCode !== null || child.killed) return
    try {
      child.kill('SIGTERM')
    } catch {
      // Already gone.
    }
  }
}
