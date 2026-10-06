// The page an unpaired phone sees instead of the app: server-rendered, no app bundle, no
// script. The form submits the six digits as GET /koppel?code=..., the same URL the QR
// code opens, so typing and scanning take one path.
//
// The page shell (ink background, one parchment card) is shared with the certificate pages
// (certificate-page.ts).

import type { IncomingMessage, ServerResponse } from 'node:http'
import { computerNoun, serverPlatform } from '../src/lib/platform.ts'

export const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** No scripts at all; inline styles only; never framed. */
export const PAIRING_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; manifest-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"

/** Dark leather with a parchment card, as in the app. Links styled as buttons are at least 48px high. */
const PAGE_CSS = `:root { color-scheme: dark; }
* { box-sizing: border-box; }
body {
  margin: 0; min-height: 100vh; min-height: 100dvh;
  display: flex; align-items: center; justify-content: center;
  padding: max(24px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(24px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
  background: #15120e; color: #efe2c4;
  font: 17px/1.5 'Alegreya Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
main { width: 100%; max-width: 420px; }
.brand, h1, label, button, .button { font-family: Cinzel, 'Trajan Pro', Georgia, serif; text-transform: uppercase; }
.brand { margin: 0 0 16px; text-align: center; font-size: 13px; letter-spacing: .2em; color: #c9a24a; }
.card {
  background: #efe4cc; color: #2a2118;
  border: 1px solid #3a2f22; border-radius: 10px;
  padding: 24px 20px; box-shadow: 0 12px 32px rgba(0, 0, 0, .45);
}
h1 { margin: 0 0 12px; font-size: 20px; font-weight: 600; letter-spacing: .06em; }
p { margin: 0 0 16px; }
.error { color: #a4452a; font-weight: 700; border-left: 3px solid #a4452a; padding-left: 10px; }
label { display: block; margin-bottom: 6px; font-size: 12px; letter-spacing: .14em; color: #7a561a; }
input {
  width: 100%; min-height: 52px; padding: 8px 12px 8px calc(12px + .35em);
  font: 600 26px/1 ui-monospace, 'SF Mono', Menlo, monospace; letter-spacing: .35em; text-align: center;
  color: #2a2118; background: #e2d4b3; border: 1px solid #7a561a; border-radius: 8px;
}
button, .button {
  display: flex; align-items: center; justify-content: center;
  width: 100%; min-height: 48px; margin-top: 14px; padding: 8px 16px;
  font-size: 16px; font-weight: 600; letter-spacing: .14em; text-align: center; text-decoration: none;
  color: #efe4cc; background: #7a561a; border: 0; border-radius: 8px; cursor: pointer;
}
.button.secondary { color: #7a561a; background: transparent; border: 1px solid #7a561a; }
a { color: #7a561a; font-weight: 600; }
.link { display: inline-flex; align-items: center; min-height: 44px; }
input:focus-visible, button:focus-visible, a:focus-visible, summary:focus-visible { outline: 3px solid #c9a24a; outline-offset: 2px; }
.hint { margin: 14px 0 0; font-size: 15px; opacity: .75; }
ol.steps { margin: 18px 0 0; padding-left: 1.4em; }
ol.steps li { margin-bottom: 12px; }
.mono { font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 13px; overflow-wrap: anywhere; }
details { margin-top: 10px; font-size: 15px; }
summary { display: flex; align-items: center; min-height: 44px; cursor: pointer; }`

export interface PageOptions {
  title: string
  /** HTML inside the parchment card. */
  card: string
  /** Extra tags for <head>, such as the home-screen meta tags. */
  head?: string
}

/** A complete server-rendered page: brand line, one card, no scripts. */
export function renderPage(opts: PageOptions): string {
  return `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#15120e">
${opts.head ? `${opts.head}\n` : ''}<title>${escapeHtml(opts.title)}</title>
<style>
${PAGE_CSS}
</style>
</head>
<body>
<main>
<p class="brand">Ash Log</p>
<div class="card">
${opts.card}
</div>
</main>
</body>
</html>
`
}

/** Sends a server-rendered page: never cached, never framed, no referrer. */
export function sendPage(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  html: string,
  opts: { csp: string; headers?: Record<string, string> },
) {
  res.statusCode = status
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Vary', 'Cookie')
  res.setHeader('Content-Security-Policy', opts.csp)
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  for (const [name, value] of Object.entries(opts.headers ?? {})) res.setHeader(name, value)
  res.end(req.method === 'HEAD' ? undefined : html)
}

const HOME_SCREEN_HEAD = `<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Ash Log">
<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">`

/** `platform` is process.platform of the computer the server runs on: the page names it ('je Mac', 'je pc'). */
export function renderPairingPage(opts: { error?: string; platform?: string } = {}): string {
  const error = opts.error ? `<p class="error" role="alert">${escapeHtml(opts.error)}</p>` : ''
  const computer = computerNoun(serverPlatform(opts.platform ?? process.platform))
  return renderPage({
    title: 'Koppel dit apparaat',
    head: HOME_SCREEN_HEAD,
    card: `<h1>Koppel dit apparaat</h1>
<p>Het Logboek draait op je ${computer}. Zet daar <strong>Live op wifi</strong> aan en maak een koppelcode. Scan de QR-code met je camera of typ de zes cijfers hieronder.</p>
${error}<form method="get" action="/koppel">
<label for="code">Koppelcode</label>
<input id="code" name="code" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required>
<button type="submit">Koppelen</button>
</form>
<p class="hint">Een code werkt tien minuten en maar één keer.</p>`,
  })
}

export function sendPairingPage(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  error?: string,
  headers: Record<string, string> = {},
  platform: string = process.platform,
) {
  sendPage(req, res, status, renderPairingPage({ error, platform }), { csp: PAIRING_PAGE_CSP, headers })
}
