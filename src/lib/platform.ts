// The computer the app server runs on (ServerStatus.platform) and the phone a page talks to.
// Shared by the server (certificate pages, log lines) and the app (live dialog), so both name
// things alike.

import type { PhoneKind, ServerPlatform } from './types.ts'

export type { PhoneKind, ServerPlatform }

export const PHONE_KINDS: readonly PhoneKind[] = ['iphone', 'android']

/** ServerStatus.platform from Node's process.platform. */
export function serverPlatform(nodePlatform: string): ServerPlatform {
  if (nodePlatform === 'darwin') return 'mac'
  if (nodePlatform === 'win32') return 'windows'
  if (nodePlatform === 'linux') return 'linux'
  return 'other'
}

/** How texts name the computer: 'Mac', 'pc' or 'computer', as in 'je Mac' or 'deze pc'. */
export function computerNoun(platform: ServerPlatform | undefined): string {
  if (platform === 'mac') return 'Mac'
  if (platform === 'windows') return 'pc'
  return 'computer'
}

/**
 * iPhone (also iPod and an iPad that says so) or Android from a user agent; null for anything
 * else, such as a desktop browser or an iPad that presents itself as a Mac.
 */
export function phoneFromUserAgent(userAgent: string | undefined): PhoneKind | null {
  const ua = userAgent ?? ''
  if (/Android/i.test(ua)) return 'android'
  if (/iPhone|iPad|iPod/.test(ua)) return 'iphone'
  return null
}

/** A PhoneKind from a query parameter or request body; null for anything else. */
export function parsePhoneKind(value: unknown): PhoneKind | null {
  return typeof value === 'string' && (PHONE_KINDS as readonly string[]).includes(value) ? (value as PhoneKind) : null
}

/* ------------------------------------------------------------------ */
/* Installing the certificate on a phone                               */
/* ------------------------------------------------------------------ */

/** The CA certificate as an Android phone downloads it (GET /certificaat/ash-log-ca.crt). */
export const CA_CERT_FILE_NAME = 'ash-log-ca.crt'

/**
 * Where Android installs a CA certificate (Pixel, Android 14 and up). Other phones name the
 * menus a little differently; the texts say so and suggest searching Settings instead.
 */
export const ANDROID_CA_MENU = [
  'Instellingen',
  'Beveiliging en privacy',
  'Meer beveiligingsinstellingen',
  'Versleuteling en inloggegevens',
  'Certificaat installeren',
  'CA-certificaat',
] as const
