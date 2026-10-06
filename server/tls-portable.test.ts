// Certificates on Windows (and Linux): no openssl, no other program. This file pretends to be
// win32 and makes every child_process function throw; the CA and server certificate must still
// come out right. Never touches .local.

import { X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const spawned = vi.hoisted(() => [] as string[])
vi.mock('node:child_process', () => {
  const refuse = (name: string) =>
    vi.fn((...args: unknown[]) => {
      spawned.push(`${name} ${String(args[0])}`)
      throw new Error(`${name} must not run`)
    })
  const fns = ['exec', 'execFile', 'execFileSync', 'execSync', 'fork', 'spawn', 'spawnSync']
  const mod = Object.fromEntries(fns.map((name) => [name, refuse(name)]))
  return { ...mod, default: mod }
})

const { LocalTls, certNames } = await import('./tls.ts')

describe('certificates on simulated Windows', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  let dir: string

  beforeAll(async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    dir = await mkdtemp(join(tmpdir(), 'ashenfall-tls-win-'))
  })
  afterAll(async () => {
    Object.defineProperty(process, 'platform', platform)
    await rm(dir, { recursive: true, force: true })
  })

  it('makes the CA and the server certificate without starting any program', async () => {
    expect(process.platform).toBe('win32')
    const names = certNames('DESKTOP-7Q2LK3M', ['192.168.178.23'])
    const material = await new LocalTls({ dir: join(dir, 'tls') }).ensure(names)
    const ca = new X509Certificate(material.caPem)
    const leaf = new X509Certificate(material.cert)
    expect(ca.ca).toBe(true)
    expect(leaf.checkIssued(ca)).toBe(true)
    expect(leaf.verify(ca.publicKey)).toBe(true)
    expect(leaf.subjectAltName).toBe('DNS:DESKTOP-7Q2LK3M.local, DNS:localhost, IP Address:127.0.0.1, IP Address:192.168.178.23')
    expect(spawned).toEqual([])
  })

  it('has no child_process and no Unix paths in the certificate code', () => {
    for (const name of ['tls.ts', 'x509.ts', 'certificate-page.ts']) {
      const source = readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8')
      expect(source, name).not.toMatch(/node:child_process|require\(|\b(execFile|execFileSync|spawn|exec)\(/)
      expect(source, name).not.toMatch(/['"`]\/(usr|bin|sbin)\//)
    }
  })
})
