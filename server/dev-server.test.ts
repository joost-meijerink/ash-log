// GET /api/server and the manifest under `npm run dev` (the Vite middleware path).

import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { handleManifest } from './manifest.ts'
import { serverPlatform } from '../src/lib/platform.ts'
import { handleDevServerApi } from './middleware.ts'

let server: Server
let port: number

function call(method: string, path: string, headers: Record<string, string> = {}, body?: string) {
  return new Promise<{ status: number; json: any }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : undefined })
      })
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const handle = async () =>
      (await handleManifest(req, res, { startUrl: '/', iconsDir: join(tmpdir(), 'ashenfall-no-icons') })) || (await handleDevServerApi(req, res))
    void handle().then((handled) => {
      if (!handled) {
        res.statusCode = 418
        res.end()
      }
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

describe('dev server', () => {
  it('reports mode dev without live mode, so the app hides those controls', async () => {
    const res = await call('GET', '/api/server')
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ mode: 'dev', platform: serverPlatform(process.platform), local: true, live: false, port, urls: [] })
    expect((await call('GET', '/api/health')).json).toEqual({ ok: true, mode: 'dev' })
  })

  it('answers the management endpoints with 409', async () => {
    const json = { 'content-type': 'application/json' }
    for (const path of ['/api/server/live', '/api/server/pairing', '/api/server/devices/revoke', '/api/server/stop']) {
      const res = await call('POST', path, json, '{"on":true}')
      expect(res.status, path).toBe(409)
      expect(res.json.error).toMatch(/alleen in de app/)
    }
    expect((await call('POST', '/api/server/live', { 'content-type': 'text/plain' }, '{}')).status).toBe(415)
  })

  it('serves a manifest with start_url / and leaves other paths alone', async () => {
    const res = await call('GET', '/manifest.webmanifest')
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ name: 'Ash Log', short_name: 'Ash Log', start_url: '/', display: 'standalone' })
    expect((await call('GET', '/api/data')).status).toBe(418)
  })
})
