// Stand-in for the vite CLI in the Windows launcher tests: `node vite.mjs build` writes
// dist/index.html in the current folder and counts the builds in dist/build-count.
// FIXTURE_BUILD_FAIL=1 makes the build fail.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

if (process.env.FIXTURE_BUILD_FAIL) {
  console.error('build failed (fixture)')
  process.exit(1)
}
if (process.argv[2] !== 'build') process.exit(2)
mkdirSync('dist', { recursive: true })
const count = existsSync('dist/build-count') ? Number(readFileSync('dist/build-count', 'utf8')) : 0
writeFileSync('dist/build-count', String(count + 1))
writeFileSync('dist/index.html', '<!doctype html><title>fixture</title>')
console.log('built (fixture)')
