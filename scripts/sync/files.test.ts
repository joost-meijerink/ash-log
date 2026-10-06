import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PARTIAL_WRITE_PREFIX, PartialWriteError, RENAME_RETRY_DELAYS_MS, decodeText, jsonText, parseJson, readJson, replaceFile, writeJsonAtomic, writeJsonFilesAtomic } from './files'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ashenfall-files-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const tempFiles = async () => (await readdir(dir, { recursive: true })).filter((f) => String(f).endsWith('.tmp'))

describe('readJson', () => {
  it('returns the fallback for a missing file', async () => {
    await expect(readJson(join(dir, 'nope.json'), { a: 1 })).resolves.toEqual({ a: 1 })
  })

  it('names the file when the JSON is invalid', async () => {
    const path = join(dir, 'overrides.json')
    await writeFile(path, '{ "questStart": { "A": { "x": 1, "y": 2 }, } }')
    await expect(readJson(path, {})).rejects.toThrow(/^overrides\.json is not valid JSON: /)
  })

  it('reads a file a Windows editor saved: a BOM, UTF-16 and CRLF line endings', async () => {
    const json = '{\r\n  "version": 1,\r\n  "name": "Grünwald"\r\n}\r\n'
    const files: [string, Buffer][] = [
      ['utf8-bom.json', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(json, 'utf8')])],
      ['utf16le.json', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(json, 'utf16le')])],
      ['utf16be.json', Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(json, 'utf16le').swap16()])],
      ['plain.json', Buffer.from(json, 'utf8')],
    ]
    for (const [name, bytes] of files) {
      await writeFile(join(dir, name), bytes)
      await expect(readJson(join(dir, name), null), name).resolves.toEqual({ version: 1, name: 'Grünwald' })
    }
  })
})

describe('decodeText and parseJson', () => {
  it('drops a byte order mark and leaves other text alone', () => {
    expect(decodeText(Buffer.from('\ufeff{}', 'utf8'))).toBe('{}')
    expect(decodeText(Buffer.from('{"a":"\u00e9"}', 'utf8'))).toBe('{"a":"\u00e9"}')
    expect(decodeText(Buffer.alloc(0))).toBe('')
    expect(parseJson('\ufeff{"a":1}', 'x.json')).toEqual({ a: 1 })
  })
})

describe('writeJsonAtomic', () => {
  it('writes pretty JSON with a trailing newline', async () => {
    const path = join(dir, 'sub', 'a.json')
    await writeJsonAtomic(path, { a: [1, 2] })
    expect(await readFile(path, 'utf8')).toBe(jsonText({ a: [1, 2] }))
  })

  it('survives concurrent writes to the same file', async () => {
    const path = join(dir, 'progress.json')
    const short = { version: 1, quests: {} }
    const long = { version: 1, quests: { Ratcatcher: { steps: Array.from({ length: 50 }, (_, i) => `Ratcatcher:s:${i}`) } } }
    for (let round = 0; round < 50; round++) {
      const results = await Promise.allSettled([writeJsonAtomic(path, long), writeJsonAtomic(path, short)])
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled'])
      const text = await readFile(path, 'utf8')
      expect([jsonText(short), jsonText(long)]).toContain(text)
    }
    expect(await tempFiles()).toEqual([])
  })
})

describe('writeJsonFilesAtomic', () => {
  it('writes every file', async () => {
    await writeJsonFilesAtomic([
      [join(dir, 'map.json'), { m: 1 }],
      [join(dir, 'meta.json'), { n: 2 }],
    ])
    expect(JSON.parse(await readFile(join(dir, 'map.json'), 'utf8'))).toEqual({ m: 1 })
    expect(JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'))).toEqual({ n: 2 })
    expect(await tempFiles()).toEqual([])
  })

  it('leaves every target untouched when staging fails', async () => {
    await writeFile(join(dir, 'map.json'), 'old map')
    // A file where a directory should be: staging the second entry fails.
    await writeFile(join(dir, 'blocker'), 'x')
    await expect(
      writeJsonFilesAtomic([
        [join(dir, 'map.json'), { m: 1 }],
        [join(dir, 'blocker', 'quests.json'), { q: 1 }],
      ]),
    ).rejects.toThrow()
    expect(await readFile(join(dir, 'map.json'), 'utf8')).toBe('old map')
    expect(await tempFiles()).toEqual([])
  })

  it('lists the files already replaced when a later rename fails', async () => {
    // A directory where quests.json should be: its rename fails after map.json was replaced.
    await mkdir(join(dir, 'quests.json'))
    await writeFile(join(dir, 'quests.json', 'keep'), 'x')
    const error = await writeJsonFilesAtomic([
      [join(dir, 'map.json'), { m: 1 }],
      [join(dir, 'quests.json'), { q: 1 }],
      [join(dir, 'meta.json'), { n: 1 }],
    ]).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PartialWriteError)
    expect((error as PartialWriteError).written).toEqual(['map.json'])
    expect((error as Error).message.startsWith(`${PARTIAL_WRITE_PREFIX} (map.json)`)).toBe(true)
    await expect(readFile(join(dir, 'meta.json'), 'utf8')).rejects.toThrow()
    expect(await tempFiles()).toEqual([])
  })

  it('rethrows the plain error when the first rename fails', async () => {
    await mkdir(join(dir, 'map.json'))
    await writeFile(join(dir, 'map.json', 'keep'), 'x')
    const error = await writeJsonFilesAtomic([
      [join(dir, 'map.json'), { m: 1 }],
      [join(dir, 'meta.json'), { n: 1 }],
    ]).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(PartialWriteError)
    await expect(readFile(join(dir, 'meta.json'), 'utf8')).rejects.toThrow()
    expect(await tempFiles()).toEqual([])
  })
})

describe('replaceFile', () => {
  const busy = (code: string) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code })

  it('retries on Windows while a scanner or sync client holds the target', async () => {
    const calls: string[] = []
    let failures = 2
    const waits: number[] = []
    await replaceFile('a.tmp', 'a.json', {
      platform: 'win32',
      rename: async (from, to) => {
        calls.push(`${from}>${to}`)
        if (failures-- > 0) throw busy(failures ? 'EPERM' : 'EBUSY')
      },
      sleep: async (ms) => {
        waits.push(ms)
      },
    })
    expect(calls).toHaveLength(3)
    expect(waits).toEqual(RENAME_RETRY_DELAYS_MS.slice(0, 2))
  })

  it('gives up after about a second and a half with the last error', async () => {
    let calls = 0
    const error = await replaceFile('a.tmp', 'a.json', {
      platform: 'win32',
      rename: async () => {
        calls++
        throw busy('EACCES')
      },
      sleep: async () => {},
    }).catch((e: unknown) => e)
    expect((error as NodeJS.ErrnoException).code).toBe('EACCES')
    expect(calls).toBe(RENAME_RETRY_DELAYS_MS.length + 1)
    const total = RENAME_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)
    expect(total).toBeGreaterThanOrEqual(1000)
    expect(total).toBeLessThanOrEqual(2000)
  })

  it('never retries elsewhere, nor other errors on Windows', async () => {
    for (const [platform, code] of [['darwin', 'EPERM'], ['linux', 'EACCES'], ['win32', 'ENOENT'], ['win32', 'EXDEV']] as const) {
      let calls = 0
      const error = await replaceFile('a.tmp', 'a.json', {
        platform,
        rename: async () => {
          calls++
          throw busy(code)
        },
        sleep: async () => {},
      }).catch((e: unknown) => e)
      expect((error as NodeJS.ErrnoException).code, `${platform} ${code}`).toBe(code)
      expect(calls, `${platform} ${code}`).toBe(1)
    }
  })

  it('replaces an existing file for real', async () => {
    const target = join(dir, 'progress.json')
    await writeFile(target, 'old')
    await writeFile(join(dir, 'new.tmp'), 'new')
    await replaceFile(join(dir, 'new.tmp'), target)
    expect(await readFile(target, 'utf8')).toBe('new')
    expect(await tempFiles()).toEqual([])
  })
})
