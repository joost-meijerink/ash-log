// What a phone on the Wi-Fi can reach over plain http, before it trusts Ash Log's https:
//
//   GET /certificaat                        why, and the steps for the phone that asks (iPhone or
//                                           Android, from the user agent), the other one folded
//   GET /certificaat/ash-log.mobileconfig   configuration profile with the CA (com.apple.security.root)
//   GET /certificaat/ash-log-ca.crt         the CA certificate itself (DER), as a download: Android
//                                           and other devices install it from their settings
//
// Any other plain-http request from the network gets the secure-connection page: Ash Log uses
// https now, with links to /certificaat and to the https address. No silent redirect: without
// the certificate the https page would just fail.
//
// The certificate pages are served over every transport (loopback and https too); they only
// hold public data. Server-rendered, no scripts, no images (plain http serves nothing else).

import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ANDROID_CA_MENU, CA_CERT_FILE_NAME, phoneFromUserAgent, type PhoneKind } from '../src/lib/platform.ts'
import { sendEmpty } from './http.ts'
import { escapeHtml, renderPage, sendPage } from './pairing-page.ts'
import type { TlsMaterial } from './tls.ts'

export const CERTIFICATE_PATH = '/certificaat'
export const PROFILE_PATH = '/certificaat/ash-log.mobileconfig'
export const CA_CERT_PATH = `/certificaat/${CA_CERT_FILE_NAME}`

/** Stable, so installing the profile again (also with a new CA) replaces the old one. */
export const PROFILE_IDENTIFIER = 'nl.ashenfall.ashlog.ca'
export const PROFILE_DISPLAY_NAME = 'Ash Log certificaat'
export const PROFILE_CONTENT_TYPE = 'application/x-apple-aspen-config'
/**
 * A plain download, not application/x-x509-ca-cert: Chrome on Android hands that type to the
 * system's certificate installer, which since Android 11 refuses CA certificates that do not
 * come from Settings, and then the file is not in Downloads either. As a download it lands in
 * Downloads, where Settings > ... > CA-certificaat picks it up.
 */
export const CA_CERT_CONTENT_TYPE = 'application/octet-stream'
export { CA_CERT_FILE_NAME }

/** No scripts, no images, no forms; never framed. */
export const CERTIFICATE_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'"

export const isCertificatePath = (pathname: string) =>
  pathname === CERTIFICATE_PATH || pathname === PROFILE_PATH || pathname === CA_CERT_PATH

/* ------------------------------------------------------------------ */
/* Configuration profile                                               */
/* ------------------------------------------------------------------ */

/**
 * A UUID derived from the CA fingerprint: the same CA always gives the same profile, so
 * downloading it twice installs nothing twice. Formatted as a name-based (version 5) UUID.
 */
export function stableUuid(fingerprint: string, purpose: string): string {
  const bytes = createHash('sha256').update(`${PROFILE_IDENTIFIER}:${purpose}:${fingerprint}`).digest().subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex').toUpperCase()
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const xml = (text: string) => escapeHtml(text)

/**
 * An iOS configuration profile that installs the CA certificate as a trusted root (after the
 * user turns it on). `computer` names the computer in its description ('Mac', 'pc').
 */
export function renderMobileconfig(ca: { der: Buffer; fingerprint: string }, computer = 'computer'): string {
  const base64 = ca.der.toString('base64').replace(/.{1,64}/g, (line) => `\t\t\t${line}\n`)
  const description = `Hiermee vertrouwt dit apparaat de beveiligde verbinding met Ash Log op je ${computer}. Het certificaat geldt alleen voor .local-adressen en adressen in je eigen netwerk.`
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>PayloadContent</key>
\t<array>
\t\t<dict>
\t\t\t<key>PayloadCertificateFileName</key>
\t\t\t<string>ash-log-ca.cer</string>
\t\t\t<key>PayloadContent</key>
\t\t\t<data>
${base64}\t\t\t</data>
\t\t\t<key>PayloadDescription</key>
\t\t\t<string>${xml(description)}</string>
\t\t\t<key>PayloadDisplayName</key>
\t\t\t<string>${xml(PROFILE_DISPLAY_NAME)}</string>
\t\t\t<key>PayloadIdentifier</key>
\t\t\t<string>${PROFILE_IDENTIFIER}.root</string>
\t\t\t<key>PayloadType</key>
\t\t\t<string>com.apple.security.root</string>
\t\t\t<key>PayloadUUID</key>
\t\t\t<string>${stableUuid(ca.fingerprint, 'root')}</string>
\t\t\t<key>PayloadVersion</key>
\t\t\t<integer>1</integer>
\t\t</dict>
\t</array>
\t<key>PayloadDescription</key>
\t<string>${xml(description)}</string>
\t<key>PayloadDisplayName</key>
\t<string>${xml(PROFILE_DISPLAY_NAME)}</string>
\t<key>PayloadIdentifier</key>
\t<string>${PROFILE_IDENTIFIER}</string>
\t<key>PayloadOrganization</key>
\t<string>Ash Log</string>
\t<key>PayloadRemovalDisallowed</key>
\t<false/>
\t<key>PayloadType</key>
\t<string>Configuration</string>
\t<key>PayloadUUID</key>
\t<string>${stableUuid(ca.fingerprint, 'profile')}</string>
\t<key>PayloadVersion</key>
\t<integer>1</integer>
</dict>
</plist>
`
}

/* ------------------------------------------------------------------ */
/* Pages                                                               */
/* ------------------------------------------------------------------ */

/** The address to open once the certificate is trusted, shown and linked as a button. */
function httpsButton(httpsUrl: string, label: string): string {
  return `<a class="button secondary" href="${escapeHtml(httpsUrl)}">${escapeHtml(label)}</a>
<p class="hint mono">${escapeHtml(httpsUrl)}</p>`
}

const menuPath = (items: readonly string[]) => items.map(escapeHtml).join(' &gt; ')

/** Where the https button is from the steps: right after them, or above (folded steps). */
type LinkAt = 'below' | 'above'
const linkStep = (prefix: string, at: LinkAt) => `${prefix} de beveiligde link${at === 'below' ? ':' : ' hierboven.'}`

/** One phone's part of the page: the button and steps, and hints that go after the https link. */
interface PhoneSteps {
  steps: string
  hints: string
}

/** The iPhone steps: the profile, then trust it; the last step points at the https button. */
function iphoneSteps(computer: string, at: LinkAt): PhoneSteps {
  return {
    steps: `<a class="button" href="${PROFILE_PATH}">Profiel downloaden</a>
<ol class="steps">
<li>Tik op <strong>Sta toe</strong>. Open dan Instellingen, tik op <strong>Profiel gedownload</strong> en installeer het.</li>
<li>Ga naar Instellingen &gt; Algemeen &gt; Info &gt; Instellingen voor certificaatvertrouwen (helemaal onderaan) en zet <strong>Ash Log</strong> aan.</li>
<li>${linkStep('Open daarna', at)}</li>
</ol>`,
    hints: `<p class="hint">Je iPhone meldt dat het profiel niet is ondertekend. Dat klopt: je ${escapeHtml(computer)} heeft het certificaat zelf gemaakt.</p>`,
  }
}

/** The Android steps: download the certificate, install it from Settings as a CA certificate. */
function androidSteps(at: LinkAt): PhoneSteps {
  return {
    steps: `<a class="button" href="${CA_CERT_PATH}" download="${CA_CERT_FILE_NAME}">Certificaat downloaden</a>
<ol class="steps">
<li>Het bestand <strong>${CA_CERT_FILE_NAME}</strong> komt in je Downloads.</li>
<li>Open ${menuPath(ANDROID_CA_MENU)}.</li>
<li>Tik op <strong>Toch installeren</strong>, kies <strong>${CA_CERT_FILE_NAME}</strong> en bevestig met je pincode.</li>
<li>${linkStep('Open daarna in Chrome', at)}</li>
</ol>`,
    hints: `<p class="hint">Heten de menu's op jouw telefoon anders? Zoek in Instellingen op <strong>CA-certificaat</strong> of <strong>Certificaat installeren</strong>.</p>
<p class="hint">Andere browsers dan Chrome vertrouwen het certificaat soms niet.</p>`,
  }
}

/** Folded parts show that they open: a chevron that turns. Inline, like the rest of the page. */
const DISCLOSURE_CSS = `<style>
summary { gap: .6em; color: #7a561a; font-weight: 600; list-style: none; }
summary::-webkit-details-marker { display: none; }
summary::before {
  content: ''; flex: none; width: .45em; height: .45em; margin: 0 .15em;
  border-right: 2px solid currentColor; border-bottom: 2px solid currentColor;
  transform: rotate(-45deg); transition: transform .15s;
}
details[open] > summary::before { transform: rotate(45deg); }
details[data-phone] { border-top: 1px solid rgba(122, 86, 26, .25); margin-top: 18px; padding-top: 4px; }
</style>`

/**
 * GET /certificaat. The steps for the phone that asks come first (iPhone for anything that is
 * not Android, such as an iPad or a computer); the other phone's steps are one tap away.
 * Without a fingerprint the certificate is not there (it could not be made).
 */
export function renderCertificatePage(opts: { httpsUrl: string; fingerprint?: string; phone?: PhoneKind | null; computer?: string }): string {
  const computer = opts.computer ?? 'computer'
  if (!opts.fingerprint) {
    return renderPage({
      title: 'Certificaat installeren',
      card: `<h1>Certificaat installeren</h1>
<p class="error" role="alert">Het certificaat is er nog niet. Kijk op je ${escapeHtml(computer)} of Ash Log goed draait en zet Live op wifi opnieuw aan.</p>`,
    })
  }
  const android = opts.phone === 'android'
  const first = android ? androidSteps('below') : iphoneSteps(computer, 'below')
  const other = android ? iphoneSteps(computer, 'above') : androidSteps('above')
  return renderPage({
    title: 'Certificaat installeren',
    head: DISCLOSURE_CSS,
    card: `<h1>Certificaat installeren</h1>
<p>Ash Log gebruikt op je wifi een beveiligde verbinding. Zo kan de app op je telefoon ook iets laten zien als je ${escapeHtml(computer)} uit staat. Daarvoor moet je telefoon één keer het certificaat van je ${escapeHtml(computer)} vertrouwen. Het geldt alleen voor adressen in je eigen netwerk.</p>
<section data-phone="${android ? 'android' : 'iphone'}">
${first.steps}
${httpsButton(opts.httpsUrl, 'Open Ash Log')}
${first.hints}
</section>
<details data-phone="${android ? 'iphone' : 'android'}">
<summary>${android ? 'Heb je een iPhone?' : 'Heb je een Android-telefoon?'}</summary>
${other.steps}
${other.hints}
</details>
<details>
<summary>Vingerafdruk (SHA-256)</summary>
<p class="mono">${escapeHtml(opts.fingerprint)}</p>
</details>`,
  })
}

/** Any other plain-http request from the network. */
export function renderSecureConnectionPage(opts: { httpsUrl: string; computer?: string }): string {
  const computer = opts.computer ?? 'computer'
  return renderPage({
    title: 'Beveiligde verbinding',
    card: `<h1>Beveiligde verbinding</h1>
<p>Ash Log gebruikt op je wifi nu een beveiligde verbinding. Installeer eerst één keer het certificaat op dit apparaat en open daarna het beveiligde adres.</p>
<a class="button" href="${CERTIFICATE_PATH}">Certificaat installeren</a>
${httpsButton(opts.httpsUrl, 'Beveiligd openen')}
<p class="hint">Stond Ash Log al op je beginscherm? Koppel opnieuw met de nieuwe QR-code op je ${escapeHtml(computer)} en zet Ash Log opnieuw op je beginscherm. Het oude icoon werkt niet meer.</p>`,
  })
}

export function sendSecureConnectionPage(req: IncomingMessage, res: ServerResponse, httpsUrl: string, computer?: string) {
  sendPage(req, res, 403, renderSecureConnectionPage({ httpsUrl, computer }), { csp: CERTIFICATE_PAGE_CSP })
}

/**
 * Serves the certificate paths. `material` is the TLS state in use (null when no certificate
 * could be made); `httpsUrl` the https address for the same host; `computer` how texts name
 * the computer ('Mac', 'pc'). Returns false for any other path.
 */
export function handleCertificate(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  ctx: { material: TlsMaterial | null; httpsUrl: string; computer?: string },
): boolean {
  if (!isCertificatePath(pathname)) return false
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendEmpty(res, 405, { Allow: 'GET, HEAD' })
    return true
  }
  const { material } = ctx
  if (pathname === CERTIFICATE_PATH) {
    const html = renderCertificatePage({
      httpsUrl: ctx.httpsUrl,
      fingerprint: material?.caFingerprint,
      phone: phoneFromUserAgent(req.headers['user-agent']),
      computer: ctx.computer,
    })
    sendPage(req, res, material ? 200 : 503, html, { csp: CERTIFICATE_PAGE_CSP, headers: { Vary: 'Cookie, User-Agent' } })
    return true
  }
  if (!material) {
    sendEmpty(res, 503)
    return true
  }
  const profile = pathname === PROFILE_PATH
  const body = profile ? Buffer.from(renderMobileconfig({ der: material.caDer, fingerprint: material.caFingerprint }, ctx.computer), 'utf8') : material.caDer
  res.statusCode = 200
  res.setHeader('Content-Type', profile ? PROFILE_CONTENT_TYPE : CA_CERT_CONTENT_TYPE)
  if (!profile) res.setHeader('Content-Disposition', `attachment; filename="${CA_CERT_FILE_NAME}"`)
  res.setHeader('Content-Length', String(body.length))
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.end(req.method === 'HEAD' ? undefined : body)
  return true
}
