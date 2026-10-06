// The configuration profile and the plain-http pages. The profile is checked with macOS's own
// plutil (macOS only); the CA comes from tls.ts in a temp dir.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CA_CERT_CONTENT_TYPE,
  CA_CERT_FILE_NAME,
  CA_CERT_PATH,
  CERTIFICATE_PATH,
  PROFILE_DISPLAY_NAME,
  PROFILE_IDENTIFIER,
  PROFILE_PATH,
  isCertificatePath,
  renderCertificatePage,
  renderMobileconfig,
  renderSecureConnectionPage,
  stableUuid,
} from './certificate-page.ts'
import { LocalTls, type TlsMaterial } from './tls.ts'

const run = promisify(execFile)
const PLUTIL = '/usr/bin/plutil'
const UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-5[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/
const FINGERPRINT = 'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89'
const HTTPS = 'https://MacBook-Pro-van-Joost.local:5199/'

describe('paths', () => {
  it('are the page, the profile and the CA certificate only', () => {
    for (const path of [CERTIFICATE_PATH, PROFILE_PATH, CA_CERT_PATH]) expect(isCertificatePath(path), path).toBe(true)
    for (const path of ['/certificate/', '/certificate/ca.key', '/certificaten', '/']) expect(isCertificatePath(path), path).toBe(false)
    expect(PROFILE_PATH).toBe('/certificate/ash-log.mobileconfig')
    expect(CA_CERT_PATH).toBe('/certificate/ash-log-ca.crt')
  })
})

describe('stable UUIDs', () => {
  it('follow from the CA fingerprint and the payload', () => {
    const root = stableUuid(FINGERPRINT, 'root')
    const profile = stableUuid(FINGERPRINT, 'profile')
    expect(root).toMatch(UUID)
    expect(profile).toMatch(UUID)
    expect(root).not.toBe(profile)
    expect(stableUuid(FINGERPRINT, 'root')).toBe(root)
    expect(stableUuid(FINGERPRINT.replace('AB', '00'), 'root')).not.toBe(root)
  })
})

describe.skipIf(!existsSync(PLUTIL))('configuration profile', () => {
  let dir: string
  let material: TlsMaterial
  let file: string
  const extract = async (key: string) => (await run(PLUTIL, ['-extract', key, 'raw', '-o', '-', file])).stdout.trim()

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ashenfall-profile-'))
    material = await new LocalTls({ dir: join(dir, 'tls') }).ensure({ dns: ['MacBook-Pro-van-Joost.local', 'localhost'], ips: ['127.0.0.1'] })
    file = join(dir, 'ash-log.mobileconfig')
    await writeFile(file, renderMobileconfig({ der: material.caDer, fingerprint: material.caFingerprint }, 'Mac'))
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('is a valid property list', async () => {
    const { stdout } = await run(PLUTIL, ['-lint', file])
    expect(stdout.trim()).toBe(`${file}: OK`)
  })

  it('holds the CA certificate as DER in a com.apple.security.root payload', async () => {
    expect(await extract('PayloadContent.0.PayloadType')).toBe('com.apple.security.root')
    expect(await extract('PayloadContent.0.PayloadContent')).toBe(material.caDer.toString('base64'))
    expect(await extract('PayloadContent.0.PayloadCertificateFileName')).toBe('ash-log-ca.cer')
    expect(await extract('PayloadContent.0.PayloadVersion')).toBe('1')
    expect(await extract('PayloadType')).toBe('Configuration')
    expect(await extract('PayloadVersion')).toBe('1')
    expect(await extract('PayloadRemovalDisallowed')).toBe('false')
  })

  it('has the display name and stable identifiers', async () => {
    expect(await extract('PayloadDisplayName')).toBe(PROFILE_DISPLAY_NAME)
    expect(PROFILE_DISPLAY_NAME).toBe('Ash Log certificate')
    expect(await extract('PayloadIdentifier')).toBe('nl.ashenfall.ashlog.ca')
    expect(await extract('PayloadContent.0.PayloadIdentifier')).toBe(`${PROFILE_IDENTIFIER}.root`)
    expect(await extract('PayloadUUID')).toBe(stableUuid(material.caFingerprint, 'profile'))
    expect(await extract('PayloadContent.0.PayloadUUID')).toBe(stableUuid(material.caFingerprint, 'root'))
    // The same CA always gives the same profile.
    expect(renderMobileconfig({ der: material.caDer, fingerprint: material.caFingerprint })).toBe(
      renderMobileconfig({ der: material.caDer, fingerprint: material.caFingerprint }),
    )
  })

  it('says in English what it does, without em-dashes', async () => {
    const description = await extract('PayloadDescription')
    expect(description).toContain('Ash Log on your Mac')
    expect(description).toContain('your own network')
    expect(description).not.toMatch(/\u2014/)
  })
})

describe('the profile text', () => {
  it('names the computer it runs on', () => {
    const ca = { der: Buffer.from([0x30, 0x00]), fingerprint: FINGERPRINT }
    expect(renderMobileconfig(ca, 'PC')).toContain('to Ash Log on your PC.')
    expect(renderMobileconfig(ca)).toContain('to Ash Log on your computer.')
  })
})

/** The text between two markers, for checking one part of a page. */
const between = (html: string, from: string, to: string) => {
  const start = html.indexOf(from)
  return start < 0 ? '' : html.slice(start, html.indexOf(to, start + from.length))
}

describe('pages', () => {
  it('certificate page on an iPhone: the profile button, the three iOS steps and the https link, no scripts', () => {
    const html = renderCertificatePage({ httpsUrl: HTTPS, fingerprint: FINGERPRINT, phone: 'iphone', computer: 'Mac' })
    expect(html).toContain('<html lang="en">')
    const first = between(html, '<section data-phone="iphone">', '</section>')
    expect(first).toContain(`<a class="button" href="${PROFILE_PATH}">Download Profile</a>`)
    const steps = between(first, '<ol class="steps">', '</ol>')
    expect(steps.match(/<li>/g)).toHaveLength(3)
    expect(steps).toContain('<strong>Allow</strong>')
    expect(steps).toContain('<strong>Profile Downloaded</strong>')
    expect(steps).toContain('Settings &gt; General &gt; About &gt; Certificate Trust Settings')
    expect(steps).toContain('turn on <strong>Ash Log</strong>')
    expect(steps).toContain('Then open the secure link:')
    expect(first).toContain('your Mac made the certificate itself')
    expect(html).toContain('trust the certificate of your Mac once')
    expect(html).toContain(`href="${HTTPS}"`)
    // Android one tap away.
    const other = between(html, '<details data-phone="android">', '</details>')
    expect(other).toContain('<summary>Got an Android phone?</summary>')
    expect(other).toContain(`href="${CA_CERT_PATH}"`)
    expect(html.indexOf('data-phone="iphone"')).toBeLessThan(html.indexOf('data-phone="android"'))
    expect(html).toContain(FINGERPRINT)
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('manifest')
    expect(html).not.toMatch(/\u2014/)
  })

  it('certificate page on an Android phone: the download, the Settings route and the iPhone steps folded', () => {
    const html = renderCertificatePage({ httpsUrl: HTTPS, fingerprint: FINGERPRINT, phone: 'android', computer: 'PC' })
    const first = between(html, '<section data-phone="android">', '</section>')
    expect(first).toContain(`<a class="button" href="${CA_CERT_PATH}" download="${CA_CERT_FILE_NAME}">Download certificate</a>`)
    const steps = between(first, '<ol class="steps">', '</ol>')
    expect(steps.match(/<li>/g)).toHaveLength(4)
    expect(steps).toContain(
      'Open Settings &gt; Security &amp; privacy &gt; More security settings &gt; Encryption &amp; credentials &gt; Install a certificate &gt; CA certificate.',
    )
    expect(steps).toContain('<strong>Install anyway</strong>')
    expect(steps).toContain(`<strong>${CA_CERT_FILE_NAME}</strong>`)
    expect(steps).toContain('Then open the secure link in Chrome:')
    expect(first).toContain("Browsers other than Chrome sometimes don't trust the certificate.")
    expect(first).toContain('Search Settings for <strong>CA certificate</strong>')
    expect(first).not.toContain(PROFILE_PATH)
    const other = between(html, '<details data-phone="iphone">', '</details>')
    expect(other).toContain('<summary>Got an iPhone?</summary>')
    expect(other).toContain(`href="${PROFILE_PATH}"`)
    expect(other).toContain('Then open the secure link above.')
    expect(html).toContain('trust the certificate of your PC once')
    expect(html).not.toMatch(/\bMac\b/)
    expect(html).not.toMatch(/\u2014/)
  })

  it('certificate page on anything else (an iPad as a Mac, a computer): iPhone first', () => {
    const html = renderCertificatePage({ httpsUrl: HTTPS, fingerprint: FINGERPRINT, phone: null })
    expect(html).toContain('<section data-phone="iphone">')
    expect(html).toContain('<details data-phone="android">')
    expect(html).toContain('trust the certificate of your computer once')
  })

  it('certificate page without a certificate says so', () => {
    const html = renderCertificatePage({ httpsUrl: HTTPS, computer: 'PC' })
    expect(html).toContain("The certificate isn't there yet. Check on your PC that Ash Log is running")
    expect(html).not.toContain(PROFILE_PATH)
    expect(html).not.toContain(CA_CERT_PATH)
  })

  it('serves the CA certificate as a download Android keeps in Downloads', () => {
    expect(CA_CERT_PATH).toBe(`/certificate/${CA_CERT_FILE_NAME}`)
    // Never application/x-x509-ca-cert: Chrome on Android would hand that to the installer, which refuses it.
    expect(CA_CERT_CONTENT_TYPE).toBe('application/octet-stream')
  })

  it('secure-connection page: links to the certificate and the https address, escaped', () => {
    const html = renderSecureConnectionPage({ httpsUrl: `${HTTPS}map?focus=a&b="x"`, computer: 'PC' })
    expect(html).toContain('href="/certificate"')
    expect(html).toContain(`href="${HTTPS}map?focus=a&amp;b=&quot;x&quot;"`)
    expect(html).toContain('home screen')
    expect(html).toContain('QR code on your PC')
    expect(html).not.toContain('<script')
    expect(html).not.toMatch(/\u2014/)
  })
})
