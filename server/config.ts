// Locations and settings of the app server (server/app.ts).

import { loadEnvFile } from '../scripts/sync/env.ts'
import { localDir, projectPaths } from './paths.ts'

export { localDir }

// The project layout (npm run app, the Swift app, the Windows launcher). The installed app
// passes its own paths to createAppServer instead (server/paths.ts).
const project = projectPaths()

/** The built app (`vite build`). Holds no wiki images: /wiki-img is served live from public/. */
export const DIST_DIR = project.distDir
export const PUBLIC_DIR = project.publicDir
/** App icons for the home screen and the manifest, served as /icons/*. */
export const APP_ICONS_DIR = project.appIconsDir

/** Machine-local server state. Not in git, and not in /data (that holds only wiki data, overrides and progress). */
export const LOCAL_DIR = project.localDir
/** Paired devices. */
export const SERVER_STATE_FILE = project.serverStateFile
/** Pid of the running app server; removed when it exits. */
export const PID_FILE = project.pidFile
/** The local certificate authority and the server certificate for https on the Wi-Fi (tls.ts). */
export const TLS_DIR = project.tlsDir

export const DEFAULT_APP_PORT = 5199

/**
 * Loads .env into process.env (existing variables win). A missing file is fine; a BOM or
 * UTF-16 from a Windows editor is too (see scripts/sync/env.ts).
 */
export function loadEnv(file = project.envFile): void {
  loadEnvFile(file)
}

/** APP_PORT as a port number, the default when unset. Throws a readable message for anything else. */
export function parsePort(value: string | undefined): number {
  const text = (value ?? '').trim()
  if (!text) return DEFAULT_APP_PORT
  const port = Number(text)
  if (!/^\d+$/.test(text) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`APP_PORT in .env is not a valid port: ${text}`)
  }
  return port
}
