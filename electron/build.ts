/**
 * Bundles the desktop app's Node code to plain JavaScript, so the installed app needs no tsx:
 *
 *   npx tsx electron/build.ts     writes build/electron/main.mjs and build/electron/sync.mjs
 *
 * main.mjs is the Electron main process (with the app server inside); sync.mjs is the sync, which
 * the app runs as a separate process (its own executable with ELECTRON_RUN_AS_NODE=1).
 * Electron and Node's built-ins stay external; everything else (qrcode and our own code) is inlined.
 */
import { rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
export const OUT_DIR = join(ROOT, 'build', 'electron')

// CommonJS dependencies (qrcode) call require() for Node built-ins; give the ESM bundle one.
const BANNER = "import { createRequire as __ashCreateRequire } from 'node:module'; const require = __ashCreateRequire(import.meta.url);"

export async function bundle(): Promise<void> {
  rmSync(OUT_DIR, { recursive: true, force: true })
  await build({
    absWorkingDir: ROOT,
    entryPoints: { main: 'electron/main.ts', sync: 'scripts/sync/index.ts' },
    outdir: OUT_DIR,
    outExtension: { '.js': '.mjs' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['electron'],
    banner: { js: BANNER },
    sourcemap: 'linked',
    legalComments: 'none',
    logLevel: 'warning',
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await bundle()
  console.log(`bundled: ${OUT_DIR}`)
}
