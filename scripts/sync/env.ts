// Reads .env into process.env, for the sync and the app server.
//
// process.loadEnvFile() alone trips over files made on Windows: Notepad and PowerShell 5.1
// (Set-Content -Encoding UTF8) put a byte order mark before the first name, so WIKI_USER_AGENT
// silently goes missing, and `echo ... > .env` in PowerShell 5.1 writes UTF-16. This reads
// UTF-8 with or without a BOM and UTF-16 with a BOM, in any line ending, and then parses with
// Node's own .env parser (util.parseEnv).

import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { decodeText } from './files.ts'

/** The text of a .env file: UTF-8 (BOM or not) or UTF-16 LE/BE with a BOM (see decodeText). */
export const decodeEnvText = decodeText

/** Names and values from .env text. Values keep no carriage return. */
export function parseEnvText(text: string): Record<string, string> {
  return parseEnv(text.replace(/\r\n?/g, '\n')) as Record<string, string>
}

/**
 * Loads a .env file into `env` (process.env); variables that are already set win. Returns
 * false when the file does not exist. Other read errors are thrown.
 */
export function loadEnvFile(file: string, env: NodeJS.ProcessEnv = process.env): boolean {
  let bytes: Buffer
  try {
    bytes = readFileSync(file)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
  for (const [name, value] of Object.entries(parseEnvText(decodeEnvText(bytes)))) {
    if (env[name] === undefined) env[name] = value
  }
  return true
}
