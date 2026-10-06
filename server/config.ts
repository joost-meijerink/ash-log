// Locations and settings of the app server (server/app.ts).

import { join, resolve } from 'node:path'
import { loadEnvFile } from '../scripts/sync/env.ts'
import { ROOT } from '../scripts/sync/paths.ts'

/** The built app (`vite build`). Holds no wiki images: /wiki-img is served live from public/. */
export const DIST_DIR = join(ROOT, 'dist')
export const PUBLIC_DIR = join(ROOT, 'public')
/** App icons for the home screen and the manifest, served as /icons/*. */
export const APP_ICONS_DIR = join(PUBLIC_DIR, 'icons')

/**
 * Where the machine-local server state lives: .local in the project, or ASH_LOG_LOCAL_DIR (for
 * tests and CI only, so a test server never touches the real paired devices or certificate).
 */
export function localDir(env: NodeJS.ProcessEnv = process.env, root = ROOT): string {
  const override = env.ASH_LOG_LOCAL_DIR?.trim()
  return override ? resolve(root, override) : join(root, '.local')
}

/** Machine-local server state. Not in git, and not in /data (that holds only wiki data, overrides and progress). */
export const LOCAL_DIR = localDir()
/** Paired devices. */
export const SERVER_STATE_FILE = join(LOCAL_DIR, 'server.json')
/** Pid of the running app server; removed when it exits. */
export const PID_FILE = join(LOCAL_DIR, 'server.pid')
/** The local certificate authority and the server certificate for https on the Wi-Fi (tls.ts). */
export const TLS_DIR = join(LOCAL_DIR, 'tls')

export const DEFAULT_APP_PORT = 5199

/**
 * Loads .env into process.env (existing variables win). A missing file is fine; a BOM or
 * UTF-16 from a Windows editor is too (see scripts/sync/env.ts).
 */
export function loadEnv(file = join(ROOT, '.env')): void {
  loadEnvFile(file)
}

/** APP_PORT as a port number, the default when unset. Throws a Dutch message for anything else. */
export function parsePort(value: string | undefined): number {
  const text = (value ?? '').trim()
  if (!text) return DEFAULT_APP_PORT
  const port = Number(text)
  if (!/^\d+$/.test(text) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`APP_PORT in .env is geen geldige poort: ${text}`)
  }
  return port
}
