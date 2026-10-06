import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CODE_TTL_MS,
  COOKIE_MAX_AGE,
  MAX_FAILURES_PER_CODE,
  MAX_TRACKED_ADDRESSES,
  PAIR_ERRORS,
  Pairing,
  pairErrors,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
  deviceCookie,
  deviceNameFromUserAgent,
  hashToken,
  readCookie,
} from './pairing.ts'
import { renderPairingPage } from './pairing-page.ts'

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1'
const IPHONE_WEBAPP = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
const IPHONE_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/138.0 Mobile/15E148 Safari/604.1'
const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0 Mobile Safari/537.36'
const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15'

let dir: string
let file: string
let clock: number
let logs: string[]

const make = () => new Pairing({ file, now: () => clock, log: (l) => logs.push(l) })

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ashenfall-pairing-'))
  file = join(dir, '.local', 'server.json')
  clock = Date.parse('2026-09-28T12:00:00Z')
  logs = []
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('cookie', () => {
  it('is HttpOnly, SameSite=Lax, Path=/ and lasts about ten years, without Secure on plain http', () => {
    const cookie = deviceCookie('tok')
    expect(cookie).toBe(`logboek_device=tok; Max-Age=${COOKIE_MAX_AGE}; Path=/; HttpOnly; SameSite=Lax`)
    expect(COOKIE_MAX_AGE).toBeGreaterThan(9 * 365 * 24 * 3600)
    expect(cookie).not.toMatch(/Secure/)
  })

  it('is Secure on https', () => {
    expect(deviceCookie('tok', true)).toBe(`logboek_device=tok; Max-Age=${COOKIE_MAX_AGE}; Path=/; HttpOnly; SameSite=Lax; Secure`)
  })

  it('reads one cookie out of a header', () => {
    expect(readCookie('a=1; logboek_device=xyz; b=2', 'logboek_device')).toBe('xyz')
    expect(readCookie('logboek_device_old=1', 'logboek_device')).toBeUndefined()
    expect(readCookie(undefined, 'logboek_device')).toBeUndefined()
    expect(readCookie('logboek_device=', 'logboek_device')).toBeUndefined()
  })
})

describe('device names', () => {
  it('names the device and browser', () => {
    expect(deviceNameFromUserAgent(IPHONE_SAFARI)).toBe('iPhone (Safari)')
    expect(deviceNameFromUserAgent(IPHONE_WEBAPP)).toBe('iPhone (web-app)')
    expect(deviceNameFromUserAgent(IPHONE_CHROME)).toBe('iPhone (Chrome)')
    expect(deviceNameFromUserAgent(ANDROID_CHROME)).toBe('Android-telefoon (Chrome)')
    expect(deviceNameFromUserAgent(MAC_SAFARI)).toBe('Mac (Safari)')
    expect(deviceNameFromUserAgent(undefined)).toBe('Onbekend apparaat')
    expect(deviceNameFromUserAgent('curl/8.7.1')).toBe('Onbekend apparaat')
  })
})

describe('codes', () => {
  it('are six digits, valid ten minutes and single use', async () => {
    const p = make()
    const { code, expiresAt } = p.createCode()
    expect(code).toMatch(/^\d{6}$/)
    expect(expiresAt).toBe(clock + CODE_TTL_MS)

    const first = await p.redeem(code, '192.168.1.20', IPHONE_SAFARI)
    expect(first.ok).toBe(true)
    const again = await p.redeem(code, '192.168.1.21', IPHONE_SAFARI)
    expect(again).toMatchObject({ ok: false, status: 410, error: PAIR_ERRORS.expired })
  })

  it('expire after ten minutes', async () => {
    const p = make()
    const inTime = p.createCode()
    clock += CODE_TTL_MS - 1
    expect((await p.redeem(inTime.code, '192.168.1.20', IPHONE_SAFARI)).ok).toBe(true)
    const late = p.createCode()
    clock += CODE_TTL_MS
    expect(await p.redeem(late.code, '192.168.1.20', IPHONE_SAFARI)).toMatchObject({ ok: false, status: 410, error: PAIR_ERRORS.expired })
  })

  it('replace each other: only the newest code works', async () => {
    const p = make()
    const first = p.createCode()
    const second = p.createCode()
    if (first.code !== second.code) {
      expect(await p.redeem(first.code, '192.168.1.20', undefined)).toMatchObject({ ok: false, status: 400 })
    }
    expect((await p.redeem(second.code, '192.168.1.20', undefined)).ok).toBe(true)
  })

  it('refuses malformed and wrong codes with 400', async () => {
    const p = make()
    const { code } = p.createCode()
    const wrong = code === '000000' ? '000001' : '000000'
    for (const input of ['12345', '1234567', 'abcdef', '', undefined, null, {}]) {
      expect(await p.redeem(input, '10.0.0.1', undefined), String(input)).toMatchObject({ ok: false, status: 400, error: PAIR_ERRORS.format })
    }
    expect(await p.redeem(wrong, '10.0.0.2', undefined)).toMatchObject({ ok: false, status: 400, error: PAIR_ERRORS.wrong })
    // Spaces from copy and paste are fine.
    expect((await p.redeem(`${code.slice(0, 3)} ${code.slice(3)}`, '10.0.0.3', undefined)).ok).toBe(true)
  })

  it('is wrong when no code was ever made', async () => {
    expect(await make().redeem('123456', '10.0.0.1', undefined)).toMatchObject({ ok: false, status: 400, error: PAIR_ERRORS.wrong })
  })

  it('stops working when cleared (live mode off)', async () => {
    const p = make()
    const { code } = p.createCode()
    p.clearCode()
    expect(await p.redeem(code, '10.0.0.1', undefined)).toMatchObject({ ok: false, status: 410 })
  })

  it('rate-limits wrong codes per address, even a right code after that', async () => {
    const p = make()
    const { code } = p.createCode()
    const wrong = code === '000000' ? '000001' : '000000'
    for (let i = 0; i < RATE_LIMIT_MAX; i++) expect((await p.redeem(wrong, '192.168.1.66', undefined)).ok).toBe(false)
    const blocked = await p.redeem(code, '192.168.1.66', undefined)
    expect(blocked).toMatchObject({ ok: false, status: 429, error: PAIR_ERRORS.rateLimited })
    expect(blocked.ok === false && blocked.retryAfter).toBeGreaterThan(0)
    // Another address is not affected.
    expect((await p.redeem(wrong, '192.168.1.67', undefined)).ok === false).toBe(true)
    // After the window the address may try again.
    clock += RATE_LIMIT_WINDOW_MS
    expect((await p.redeem(code, '192.168.1.66', IPHONE_SAFARI)).ok).toBe(true)
  })

  it('burns the code after too many wrong tries in total', async () => {
    const p = make()
    const { code } = p.createCode()
    const wrong = code === '000000' ? '000001' : '000000'
    for (let i = 0; i < MAX_FAILURES_PER_CODE; i++) await p.redeem(wrong, `10.0.${i}.1`, undefined)
    expect(await p.redeem(code, '10.9.9.9', undefined)).toMatchObject({ ok: false, status: 410 })
    expect(logs.some((l) => /ingetrokken/.test(l))).toBe(true)
  })

  it('forgets addresses without recent tries once many addresses were tracked', async () => {
    const p = make()
    for (let i = 0; i < MAX_TRACKED_ADDRESSES; i++) await p.redeem('000000', `fd00::${i.toString(16)}`, undefined)
    expect(p.trackedAddresses).toBe(MAX_TRACKED_ADDRESSES)
    // Within the window nothing is forgotten, so the rate limit still holds.
    await p.redeem('000000', 'fd00::ffff', undefined)
    expect(p.trackedAddresses).toBe(MAX_TRACKED_ADDRESSES + 1)
    clock += RATE_LIMIT_WINDOW_MS
    await p.redeem('000000', '10.0.0.1', undefined)
    expect(p.trackedAddresses).toBe(1)
  })
})

describe('devices', () => {
  it('stores only the sha256 of the token, and the token logs in', async () => {
    const p = make()
    const result = await p.redeem(p.createCode().code, '192.168.1.20', IPHONE_SAFARI)
    if (!result.ok) throw new Error('pairing failed')
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const text = await readFile(file, 'utf8')
    expect(text).not.toContain(result.token)
    expect(text).toContain(hashToken(result.token))
    expect(JSON.parse(text).devices[0]).toMatchObject({ id: result.device.id, name: 'iPhone (Safari)', tokenHash: hashToken(result.token) })

    expect(p.authenticate(result.token)?.id).toBe(result.device.id)
    expect(p.authenticate(result.token + 'x')).toBeUndefined()
    expect(p.authenticate(undefined)).toBeUndefined()
    expect(p.devices()).toEqual([{ id: result.device.id, name: 'iPhone (Safari)', pairedAt: '2026-09-28T12:00:00.000Z', lastSeenAt: '2026-09-28T12:00:00.000Z' }])
    expect(p.devices()[0]).not.toHaveProperty('tokenHash')
  })

  it('survives a restart and forgets a revoked device', async () => {
    const p = make()
    const a = await p.redeem(p.createCode().code, '192.168.1.20', IPHONE_SAFARI)
    const b = await p.redeem(p.createCode().code, '192.168.1.21', IPHONE_SAFARI)
    if (!a.ok || !b.ok) throw new Error('pairing failed')
    expect(b.device.name).toBe('iPhone (Safari) 2')

    const restarted = make()
    await restarted.load()
    expect(restarted.devices().map((d) => d.id)).toEqual([a.device.id, b.device.id])
    expect(restarted.authenticate(a.token)?.id).toBe(a.device.id)

    expect(await restarted.revoke(a.device.id)).toBe(true)
    expect(await restarted.revoke('nope')).toBe(false)
    expect(restarted.authenticate(a.token)).toBeUndefined()
    const again = make()
    await again.load()
    expect(again.devices().map((d) => d.id)).toEqual([b.device.id])
  })

  it('writes lastSeenAt now and then, and on flush', async () => {
    const p = make()
    const r = await p.redeem(p.createCode().code, '192.168.1.20', IPHONE_SAFARI)
    if (!r.ok) throw new Error('pairing failed')
    clock += 60_000
    p.authenticate(r.token)
    expect(p.devices()[0]!.lastSeenAt).toBe('2026-09-28T12:01:00.000Z')
    expect(JSON.parse(await readFile(file, 'utf8')).devices[0].lastSeenAt).toBe('2026-09-28T12:00:00.000Z')
    await p.flush()
    expect(JSON.parse(await readFile(file, 'utf8')).devices[0].lastSeenAt).toBe('2026-09-28T12:01:00.000Z')
  })

  it('moves an unreadable server.json aside and says so', async () => {
    const p = make()
    const r = await p.redeem(p.createCode().code, '192.168.1.20', IPHONE_SAFARI)
    expect(r.ok).toBe(true)
    await writeFile(file, '{ "devices": [ }')
    const broken = make()
    await broken.load()
    expect(broken.devices()).toEqual([])
    expect(logs.some((l) => /server\.json is geen geldige JSON/.test(l))).toBe(true)
    const files = await readdir(join(dir, '.local'))
    expect(files.some((f) => f.startsWith('server.json.ongeldig-'))).toBe(true)
  })

  it('skips entries without a valid token hash', async () => {
    const good = { id: 'a1', name: 'iPhone (Safari)', pairedAt: '2026-01-01T00:00:00.000Z', tokenHash: hashToken('t') }
    await mkdir(join(dir, '.local'), { recursive: true })
    await writeFile(file, JSON.stringify({ version: 1, devices: [good, { id: 'b', tokenHash: 'short' }, 'x', null] }))
    const p = make()
    await p.load()
    expect(p.devices().map((d) => d.id)).toEqual(['a1'])
    expect(p.authenticate('t')?.id).toBe('a1')
    // authenticate() writes lastSeenAt in the background; let it land before the temp dir goes.
    await p.flush()
  })
})

describe('texts that name the computer', () => {
  it('say Mac on macOS, pc on Windows and computer elsewhere', () => {
    expect(pairErrors('darwin').expired).toBe('Deze code is niet meer geldig. Maak op je Mac een nieuwe.')
    expect(pairErrors('win32').expired).toBe('Deze code is niet meer geldig. Maak op je pc een nieuwe.')
    expect(pairErrors('linux').expired).toBe('Deze code is niet meer geldig. Maak op je computer een nieuwe.')
    expect(PAIR_ERRORS).toEqual(pairErrors(process.platform))
  })

  it('a Pairing on Windows answers an expired code with the pc text', async () => {
    const p = new Pairing({ file, now: () => clock, platform: 'win32' })
    const { code } = p.createCode()
    clock += CODE_TTL_MS
    expect(await p.redeem(code, '192.168.1.20', ANDROID_CHROME)).toMatchObject({ ok: false, status: 410, error: pairErrors('win32').expired })
  })

  it('the pairing page tells where the Logboek runs', () => {
    expect(renderPairingPage({ platform: 'win32' })).toContain('Het Logboek draait op je pc.')
    expect(renderPairingPage({ platform: 'darwin' })).toContain('Het Logboek draait op je Mac.')
    expect(renderPairingPage({ platform: 'linux', error: 'Deze code klopt niet' })).toContain('Het Logboek draait op je computer.')
  })
})
