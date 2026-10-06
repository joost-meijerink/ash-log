// X.509 certificates for Ash Log's local CA and its server certificate, made with node:crypto
// only: no openssl and no dependency, so it works the same on macOS, Windows and Linux.
//
// node:crypto makes keys and signatures but cannot build a certificate. This file encodes the
// DER (RFC 5280) for exactly these two certificates and nothing more, and reads two things back
// from an existing CA certificate: its subject, copied byte for byte into the issuer of a server
// certificate, and its subject key identifier. So a CA that the earlier openssl code made keeps
// signing, and phones that trust it keep trusting the server.
//
// x509.test.ts and tls.test.ts check the output with node:crypto, node:tls (OpenSSL), and on
// macOS also with LibreSSL, Apple's own trust code (security verify-cert) and byte for byte
// against what the old openssl code path made.

import { createHash, createPublicKey, sign, type KeyObject } from 'node:crypto'
import { isIPv4 } from 'node:net'

export const OID = {
  commonName: '2.5.4.3',
  organization: '2.5.4.10',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  subjectKeyId: '2.5.29.14',
  authorityKeyId: '2.5.29.35',
  subjectAltName: '2.5.29.17',
  nameConstraints: '2.5.29.30',
  serverAuth: '1.3.6.1.5.5.7.3.1',
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
  sha256WithRsa: '1.2.840.113549.1.1.11',
} as const

/** KeyUsage bit numbers (RFC 5280 4.2.1.3). */
export const KEY_USAGE = {
  digitalSignature: 0,
  keyEncipherment: 2,
  keyCertSign: 5,
  cRLSign: 6,
} as const

/* ------------------------------------------------------------------ */
/* DER writer                                                          */
/* ------------------------------------------------------------------ */

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n])
  const bytes: number[] = []
  for (let rest = n; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256)
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

export const tlv = (tag: number, content: Buffer): Buffer => Buffer.concat([Buffer.from([tag]), length(content.length), content])
const seq = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items))
const set = (...items: Buffer[]) => tlv(0x31, Buffer.concat(items))
const bool = (value: boolean) => tlv(0x01, Buffer.from([value ? 0xff : 0x00]))
const octets = (content: Buffer) => tlv(0x04, content)
const utf8 = (text: string) => tlv(0x0c, Buffer.from(text, 'utf8'))
const NULL = tlv(0x05, Buffer.alloc(0))
/** [n] EXPLICIT (constructed, context-specific). */
const explicit = (n: number, content: Buffer) => tlv(0xa0 | n, content)

/** A non-negative INTEGER from big-endian bytes, minimally encoded. */
function unsigned(bytes: Buffer): Buffer {
  let start = 0
  while (start < bytes.length - 1 && bytes[start] === 0) start++
  const trimmed = bytes.subarray(start)
  return tlv(0x02, trimmed[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed)
}
const smallInt = (n: number) => unsigned(Buffer.from([n]))

/** An OBJECT IDENTIFIER from dotted form. */
export function oid(dotted: string): Buffer {
  const arcs = dotted.split('.').map(Number)
  if (arcs.length < 2 || arcs.some((a) => !Number.isSafeInteger(a) || a < 0)) throw new Error(`Invalid OID: ${dotted}`)
  const out: number[] = []
  for (const arc of [arcs[0]! * 40 + arcs[1]!, ...arcs.slice(2)]) {
    const bytes = [arc % 128]
    for (let rest = Math.floor(arc / 128); rest > 0; rest = Math.floor(rest / 128)) bytes.unshift((rest % 128) | 0x80)
    out.push(...bytes)
  }
  return tlv(0x06, Buffer.from(out))
}

/** A BIT STRING of whole bytes (keys, signatures). */
const bitString = (bytes: Buffer) => tlv(0x03, Buffer.concat([Buffer.from([0]), bytes]))

/** KeyUsage as a named BIT STRING: trailing zero bits dropped, as DER wants. */
export function keyUsage(bits: readonly number[]): Buffer {
  const last = Math.max(...bits)
  const bytes = Buffer.alloc(Math.floor(last / 8) + 1)
  for (const bit of bits) bytes[bit >> 3]! |= 0x80 >> (bit & 7)
  const unused = 7 - (last & 7)
  return tlv(0x03, Buffer.concat([Buffer.from([unused]), bytes]))
}

/** UTCTime through 2049, GeneralizedTime from 2050 (RFC 5280 4.1.2.5). Whole seconds. */
function time(date: Date): Buffer {
  const year = date.getUTCFullYear()
  const digits = date.toISOString().slice(0, 19).replace(/[-:T]/g, '')
  return year >= 1950 && year < 2050 ? tlv(0x17, Buffer.from(`${digits.slice(2)}Z`, 'ascii')) : tlv(0x18, Buffer.from(`${digits}Z`, 'ascii'))
}

function ipv4Bytes(ip: string): Buffer {
  if (!isIPv4(ip)) throw new Error(`Not an IPv4 address: ${ip}`)
  return Buffer.from(ip.split('.').map(Number))
}

/** An IA5String name for dNSName: plain ASCII without spaces or control characters. */
function dnsBytes(name: string): Buffer {
  if (!/^[\x21-\x7e]+$/.test(name)) throw new Error(`Invalid name: ${JSON.stringify(name)}`)
  return Buffer.from(name, 'ascii')
}

/** GeneralName dNSName [2] and iPAddress [7] (implicit, primitive). */
const dnsName = (name: string) => tlv(0x82, dnsBytes(name))
const ipAddress = (bytes: Buffer) => tlv(0x87, bytes)

/** A distinguished name with a common name and, optionally, an organization (in that order). */
export function distinguishedName(attrs: { commonName: string; organization?: string }): Buffer {
  const rdn = (type: string, value: string) => set(seq(oid(type), utf8(value)))
  return seq(rdn(OID.commonName, attrs.commonName), ...(attrs.organization ? [rdn(OID.organization, attrs.organization)] : []))
}

const extension = (id: string, critical: boolean, value: Buffer) => seq(oid(id), ...(critical ? [bool(true)] : []), octets(value))

/* ------------------------------------------------------------------ */
/* DER reader (just enough for certificates and public keys)           */
/* ------------------------------------------------------------------ */

interface Node {
  tag: number
  start: number
  content: number
  end: number
}

function readNode(der: Buffer, offset: number, limit = der.length): Node {
  if (offset + 2 > limit) throw new Error('DER is truncated')
  const tag = der[offset]!
  if ((tag & 0x1f) === 0x1f) throw new Error('DER tag not supported')
  let len = der[offset + 1]!
  let p = offset + 2
  if (len & 0x80) {
    const n = len & 0x7f
    if (n === 0 || n > 4 || p + n > limit) throw new Error('DER length is not right')
    len = 0
    for (let i = 0; i < n; i++) len = len * 256 + der[p++]!
  }
  const end = p + len
  if (end > limit) throw new Error('DER is truncated')
  return { tag, start: offset, content: p, end }
}

function childrenOf(der: Buffer, node: Node): Node[] {
  const out: Node[] = []
  for (let p = node.content; p < node.end; ) {
    const child = readNode(der, p, node.end)
    out.push(child)
    p = child.end
  }
  return out
}

function expectTag(node: Node | undefined, tag: number, what: string): Node {
  if (!node || node.tag !== tag) throw new Error(`Unexpected certificate structure (${what})`)
  return node
}

const whole = (der: Buffer, node: Node) => Buffer.from(der.subarray(node.start, node.end))
const contentOf = (der: Buffer, node: Node) => Buffer.from(der.subarray(node.content, node.end))

/**
 * Subject key identifier as openssl's 'hash' makes it (RFC 5280 4.2.1.2, method 1): SHA-1 of
 * the subjectPublicKey bits of a SubjectPublicKeyInfo (DER).
 */
export function keyIdentifier(spki: Buffer): Buffer {
  const root = expectTag(readNode(spki, 0), 0x30, 'SubjectPublicKeyInfo')
  const bits = expectTag(childrenOf(spki, root)[1], 0x03, 'subjectPublicKey')
  return createHash('sha1').update(spki.subarray(bits.content + 1, bits.end)).digest()
}

export interface IssuerInfo {
  /** The subject Name exactly as encoded in the CA certificate. */
  subject: Buffer
  /** Its subject key identifier (or the one it would have, when the extension is missing). */
  keyId: Buffer
}

/** What a server certificate needs from the CA certificate (DER) that issues it. */
export function issuerInfo(certDer: Buffer): IssuerInfo {
  const cert = expectTag(readNode(certDer, 0), 0x30, 'Certificate')
  const tbs = expectTag(childrenOf(certDer, cert)[0], 0x30, 'TBSCertificate')
  const fields = childrenOf(certDer, tbs)
  const at = fields[0]?.tag === 0xa0 ? 1 : 0
  const subject = expectTag(fields[at + 4], 0x30, 'subject')
  const spki = expectTag(fields[at + 5], 0x30, 'subjectPublicKeyInfo')
  let keyId: Buffer | null = null
  const extensions = fields.slice(at + 6).find((f) => f.tag === 0xa3)
  if (extensions) {
    const list = expectTag(childrenOf(certDer, extensions)[0], 0x30, 'extensions')
    const skiOid = oid(OID.subjectKeyId)
    for (const ext of childrenOf(certDer, list)) {
      const parts = childrenOf(certDer, expectTag(ext, 0x30, 'extension'))
      if (!parts[0] || !whole(certDer, parts[0]).equals(skiOid)) continue
      const value = expectTag(parts.at(-1), 0x04, 'extnValue')
      keyId = contentOf(certDer, expectTag(readNode(certDer, value.content, value.end), 0x04, 'keyIdentifier'))
    }
  }
  return { subject: whole(certDer, subject), keyId: keyId ?? keyIdentifier(whole(certDer, spki)) }
}

/* ------------------------------------------------------------------ */
/* Certificates                                                        */
/* ------------------------------------------------------------------ */

/** The public key of a key object (public or private) as SubjectPublicKeyInfo DER. */
function spkiOf(key: KeyObject): Buffer {
  const pub = key.type === 'private' ? createPublicKey(key) : key
  return pub.export({ type: 'spki', format: 'der' })
}

/** SHA-256 signatures with EC (ECDSA) or RSA (PKCS#1 v1.5) keys, as Apple and browsers accept. */
function signatureAlgorithm(key: KeyObject): Buffer {
  if (key.asymmetricKeyType === 'ec') return seq(oid(OID.ecdsaWithSha256))
  if (key.asymmetricKeyType === 'rsa') return seq(oid(OID.sha256WithRsa), NULL)
  throw new Error(`Key type ${key.asymmetricKeyType ?? 'unknown'} is not supported`)
}

function checkSerial(serial: Buffer): void {
  if (!serial.length || serial.length > 20 || serial[0]! & 0x80 || serial.every((b) => b === 0)) {
    throw new Error('The serial number must be positive and at most 20 bytes')
  }
}

function checkValidity(notBefore: Date, notAfter: Date): void {
  if (!(notBefore.getTime() < notAfter.getTime())) throw new Error('Validity is not right')
}

interface TbsParts {
  serial: Buffer
  issuer: Buffer
  subject: Buffer
  notBefore: Date
  notAfter: Date
  spki: Buffer
  extensions: Buffer[]
}

/** TBSCertificate (v3), signed with `key`: the complete certificate as DER. */
function signCertificate(parts: TbsParts, key: KeyObject): Buffer {
  checkSerial(parts.serial)
  checkValidity(parts.notBefore, parts.notAfter)
  const algorithm = signatureAlgorithm(key)
  const tbs = seq(
    explicit(0, smallInt(2)),
    unsigned(parts.serial),
    algorithm,
    parts.issuer,
    seq(time(parts.notBefore), time(parts.notAfter)),
    parts.subject,
    parts.spki,
    explicit(3, seq(...parts.extensions)),
  )
  return seq(tbs, algorithm, bitString(sign('sha256', tbs, key)))
}

export interface CaCertificateOptions {
  /** The CA's private key: it signs its own certificate. */
  key: KeyObject
  commonName: string
  organization: string
  serial: Buffer
  notBefore: Date
  notAfter: Date
  /** Name constraints: DNS names (and their subdomains) and IPv4 [network, mask] ranges. */
  permitted: { dns: readonly string[]; ipv4: readonly (readonly [string, string])[] }
}

/**
 * A self-signed CA that may sign server certificates only (pathlen 0), only for the permitted
 * names: critical basicConstraints, keyUsage and nameConstraints, plus a subject key identifier.
 */
export function createCaCertificate(o: CaCertificateOptions): Buffer {
  if (!o.permitted.dns.length && !o.permitted.ipv4.length) throw new Error('A CA without names cannot sign anything')
  const spki = spkiOf(o.key)
  const name = distinguishedName({ commonName: o.commonName, organization: o.organization })
  const permitted = [
    ...o.permitted.dns.map((d) => seq(dnsName(d))),
    ...o.permitted.ipv4.map(([network, mask]) => seq(ipAddress(Buffer.concat([ipv4Bytes(network), ipv4Bytes(mask)])))),
  ]
  return signCertificate(
    {
      serial: o.serial,
      issuer: name,
      subject: name,
      notBefore: o.notBefore,
      notAfter: o.notAfter,
      spki,
      extensions: [
        extension(OID.basicConstraints, true, seq(bool(true), smallInt(0))),
        extension(OID.keyUsage, true, keyUsage([KEY_USAGE.keyCertSign, KEY_USAGE.cRLSign])),
        extension(OID.subjectKeyId, false, octets(keyIdentifier(spki))),
        // permittedSubtrees [0] IMPLICIT: a constructed context tag around the GeneralSubtrees.
        extension(OID.nameConstraints, true, seq(tlv(0xa0, Buffer.concat(permitted)))),
      ],
    },
    o.key,
  )
}

export interface LeafCertificateOptions {
  /** The CA certificate (DER) and its private key. */
  issuer: { der: Buffer; key: KeyObject }
  /** The server's key (public or private). */
  key: KeyObject
  commonName: string
  dns: readonly string[]
  ips: readonly string[]
  serial: Buffer
  notBefore: Date
  notAfter: Date
}

/**
 * A TLS server certificate: subjectAltName with the DNS names and IPv4 addresses, extended key
 * usage serverAuth, critical keyUsage digitalSignature (plus keyEncipherment for an RSA key),
 * subject and authority key identifiers. The issuer is the CA's subject, byte for byte.
 */
export function createLeafCertificate(o: LeafCertificateOptions): Buffer {
  if (!o.dns.length && !o.ips.length) throw new Error('A server certificate without names works nowhere')
  const spki = spkiOf(o.key)
  const ca = issuerInfo(o.issuer.der)
  const usage = o.key.asymmetricKeyType === 'rsa' ? [KEY_USAGE.digitalSignature, KEY_USAGE.keyEncipherment] : [KEY_USAGE.digitalSignature]
  return signCertificate(
    {
      serial: o.serial,
      issuer: ca.subject,
      subject: distinguishedName({ commonName: o.commonName }),
      notBefore: o.notBefore,
      notAfter: o.notAfter,
      spki,
      extensions: [
        extension(OID.basicConstraints, false, seq()),
        extension(OID.keyUsage, true, keyUsage(usage)),
        extension(OID.extKeyUsage, false, seq(oid(OID.serverAuth))),
        extension(OID.subjectKeyId, false, octets(keyIdentifier(spki))),
        // keyIdentifier [0] IMPLICIT OCTET STRING.
        extension(OID.authorityKeyId, false, seq(tlv(0x80, ca.keyId))),
        extension(OID.subjectAltName, false, seq(...o.dns.map(dnsName), ...o.ips.map((ip) => ipAddress(ipv4Bytes(ip))))),
      ],
    },
    o.issuer.key,
  )
}

/** PEM text for DER, in 64-character lines, as openssl writes it. */
export function toPem(der: Buffer, label = 'CERTIFICATE'): string {
  const lines = der.toString('base64').match(/.{1,64}/g) ?? []
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`
}

/** The TBSCertificate of a certificate (DER), for comparing two certificates without their signatures. */
export function tbsOf(certDer: Buffer): Buffer {
  const cert = expectTag(readNode(certDer, 0), 0x30, 'Certificate')
  return whole(certDer, expectTag(childrenOf(certDer, cert)[0], 0x30, 'TBSCertificate'))
}
