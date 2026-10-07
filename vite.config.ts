import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { dataMiddleware } from './server/middleware.ts'

const TEST_FILES = ['scripts/**/*.test.ts', 'src/**/*.test.ts', 'server/**/*.test.ts', 'electron/**/*.test.ts']
const PROCESS_TESTS = [
  'scripts/desktop/build-app.test.ts',
  'scripts/desktop/launcher.test.ts',
  'scripts/windows/launcher.test.ts',
  'server/app.test.ts',
  'server/awake.test.ts',
  'server/dev-server.test.ts',
  'server/live.test.ts',
  // Not a process test, but a long fuzz run of the three views (fake timers, hundreds of steps):
  // next to the server tests it sometimes slowed down past its deadline, alone it takes seconds.
  'src/views/three-views.test.ts',
]

export default defineConfig({
  plugins: [vue(), tailwindcss(), dataMiddleware()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    // public/wiki-img (tens of MB, refreshed by every sync) stays out of dist: the app server
    // serves /wiki-img and /icons live from public/, the dev server serves public/ as before.
    copyPublicDir: false,
  },
  server: {
    // Sync writes JSON and images while the dev server runs; never reload on those.
    // /wiki-img is served by the data middleware straight from disk, so images that
    // arrive while the server runs work without Vite's public-file list.
    watch: { ignored: ['**/data/**', '**/public/wiki-img/**'] },
  },
  test: {
    environment: 'node',
    // CI runners (Windows above all) start Node, tsx and servers a lot slower than a laptop.
    // Locally the defaults stay, so a test that suddenly gets slow still shows up.
    testTimeout: process.env.CI ? 30_000 : 5_000,
    hookTimeout: process.env.CI ? 60_000 : 10_000,
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: TEST_FILES, exclude: PROCESS_TESTS },
      },
      {
        // Tests that start real processes and servers and wait on timers, plus the long fuzz run of
        // the views. Under the load of the whole suite their deadlines were missed now and then, so
        // they run afterwards, one file at a time.
        extends: true,
        test: { name: 'processes', include: PROCESS_TESTS, fileParallelism: false, sequence: { groupOrder: 1 } },
      },
    ],
  },
})
