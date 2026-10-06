import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { decodeEnvText, loadEnvFile, parseEnvText } from './env'

const dir = mkdtempSync(join(tmpdir(), 'ashenfall-env-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const AGENT = 'AshLog/0.1 (joost@example.org)'
const text = `# Ash Log\r\nWIKI_USER_AGENT="${AGENT}"\r\nAPP_PORT=5200\r\n`

function utf16be(s: string): Buffer {
  const b = Buffer.from(s, 'utf16le')
  b.swap16()
  return b
}

describe('.env from Windows editors', () => {
  it('reads UTF-8 with and without a BOM, and UTF-16 with a BOM', () => {
    for (const bytes of [
      Buffer.from(text, 'utf8'),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]),
      Buffer.concat([Buffer.from([0xfe, 0xff]), utf16be(text)]),
    ]) {
      expect(parseEnvText(decodeEnvText(bytes))).toEqual({ WIKI_USER_AGENT: AGENT, APP_PORT: '5200' })
    }
  })

  it('keeps no carriage return in a value', () => {
    expect(parseEnvText('A=1\r\nB=two words\r\n')).toEqual({ A: '1', B: 'two words' })
    expect(parseEnvText('A=1\rB=2')).toEqual({ A: '1', B: '2' })
  })

  it('loads into the environment, where variables already set win', () => {
    const file = join(dir, 'bom.env')
    writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]))
    const env: NodeJS.ProcessEnv = { APP_PORT: '5300' }
    expect(loadEnvFile(file, env)).toBe(true)
    expect(env).toEqual({ APP_PORT: '5300', WIKI_USER_AGENT: AGENT })
  })

  it('is fine without a .env file', () => {
    const env: NodeJS.ProcessEnv = {}
    expect(loadEnvFile(join(dir, 'missing.env'), env)).toBe(false)
    expect(env).toEqual({})
  })
})
