// Stand-in for server/app.ts in the launcher tests. Listens on 127.0.0.1:APP_PORT and
// answers GET /api/health and POST /api/server/stop like the app server does.
//
// FIXTURE_MODE: 'ok' (default), 'crash' (exits right away with a message), 'ignore-stop'
// (accepts the stop request but keeps running). FIXTURE_RECORD: a file that gets one JSON
// line per stop request ({ method, contentType, body }).
import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'

const port = Number(process.env.APP_PORT)
const mode = process.env.FIXTURE_MODE ?? 'ok'

if (mode === 'crash') {
  console.error('Port 1234 is already in use (fixture)')
  process.exit(1)
}

process.on('SIGTERM', () => process.exit(0))

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, mode: 'app' }))
    return
  }
  if (req.url === '/api/server/stop') {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      if (process.env.FIXTURE_RECORD) {
        const record = { method: req.method, contentType: req.headers['content-type'] ?? null, body }
        appendFileSync(process.env.FIXTURE_RECORD, `${JSON.stringify(record)}\n`)
      }
      res.writeHead(202, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      if (mode !== 'ignore-stop') setTimeout(() => server.close(() => process.exit(0)), 50)
    })
    return
  }
  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'Unknown' }))
})

server.listen(port, '127.0.0.1', () => console.log(`fixture server on port ${port}`))
