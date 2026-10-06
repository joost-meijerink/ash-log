// Stand-in for server/app.ts in the Windows launcher tests. Listens on 127.0.0.1:APP_PORT and
// answers GET /api/health, GET /api/server and POST /api/server/stop like the app server does,
// and writes its pid to $ASH_LOG_LOCAL_DIR/server.pid once it listens (the real server does too).
//
// FIXTURE_MODE: 'ok' (default), 'crash' (exits right away with a message), 'ignore-stop'
// (accepts the stop request but keeps running). FIXTURE_LIVE=1: Live on Wi-Fi is on.
// FIXTURE_RECORD: a file that gets one JSON line per stop request ({ method, contentType, body }).
import { appendFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'

const port = Number(process.env.APP_PORT)
const mode = process.env.FIXTURE_MODE ?? 'ok'

if (mode === 'crash') {
  console.error('Port 1234 is in use by another program (fixture).')
  console.error('    at stack frame that should not show')
  process.exit(1)
}

process.on('SIGTERM', () => process.exit(0))

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/health') return json(res, 200, { ok: true, mode: 'app' })
  if (req.method === 'GET' && req.url === '/api/server') {
    return json(res, 200, { mode: 'app', local: true, live: process.env.FIXTURE_LIVE === '1', port, urls: [] })
  }
  if (req.url === '/api/server/stop') {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      if (process.env.FIXTURE_RECORD) {
        const record = { method: req.method, contentType: req.headers['content-type'] ?? null, body }
        appendFileSync(process.env.FIXTURE_RECORD, `${JSON.stringify(record)}\n`)
      }
      json(res, 202, { ok: true })
      if (mode !== 'ignore-stop') setTimeout(() => server.close(() => process.exit(0)), 50)
    })
    return
  }
  json(res, 404, { error: 'Unknown' })
})

server.listen(port, '127.0.0.1', () => {
  if (process.env.ASH_LOG_LOCAL_DIR) writeFileSync(join(process.env.ASH_LOG_LOCAL_DIR, 'server.pid'), `${process.pid}\n`)
  console.log(`fixture server on port ${port}`)
})
