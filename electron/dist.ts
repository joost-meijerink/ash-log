/**
 * Runs electron-builder with its output outside the project, then copies the installers back:
 *
 *   npx tsx electron/dist.ts --dir           unpacked app for this platform (smoke tests)
 *   npx tsx electron/dist.ts --mac --win     installers in release/
 *
 * Why outside: a project in iCloud Drive (macOS Documents) gives every new file extended
 * attributes, and codesign refuses those ("resource fork, Finder information, or similar
 * detritus not allowed"). The build folder is printed; installers end up in release/.
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
export const BUILD_DIR = join(tmpdir(), 'ash-log-release')
export const RELEASE_DIR = join(ROOT, 'release')
const INSTALLER = /\.(dmg|exe|AppImage|blockmap)$/

export function dist(args: string[]): number {
  rmSync(BUILD_DIR, { recursive: true, force: true })
  const cli = join(dirname(createRequire(import.meta.url).resolve('electron-builder/package.json')), 'cli.js')
  const run = spawnSync(process.execPath, [cli, ...args, `-c.directories.output=${BUILD_DIR}`], { cwd: ROOT, stdio: 'inherit' })
  if (run.status !== 0) return run.status ?? 1
  const installers = readdirSync(BUILD_DIR).filter((name) => INSTALLER.test(name))
  if (installers.length) {
    mkdirSync(RELEASE_DIR, { recursive: true })
    for (const name of installers) copyFileSync(join(BUILD_DIR, name), join(RELEASE_DIR, name))
    console.log(`installers: ${installers.map((n) => join(RELEASE_DIR, n)).join(', ')}`)
  }
  console.log(`build folder: ${BUILD_DIR}`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = dist(process.argv.slice(2))
}
