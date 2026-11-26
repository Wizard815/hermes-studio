import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'
import { taskArtifactPath } from './scripts/task-artifacts.mjs'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'packages/client/src'),
      electron: resolve(__dirname, 'tests/mocks/electron.ts'),
      'dbus-next': resolve(__dirname, 'tests/mocks/dbus-next.ts'),
      'electron-updater': resolve(__dirname, 'tests/mocks/electron-updater.ts'),
      '/logo.png': resolve(__dirname, 'packages/client/public/logo.png'),
      '/relay-logo.png': resolve(__dirname, 'packages/client/public/relay-logo.png'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    passWithNoTests: true,
    // The fork keeps some pre-reset regression tests that rely on these globals and mocks.
    setupFiles: ['tests/setup.ts'],
    coverage: {
      reportsDirectory: taskArtifactPath(__dirname, 'coverage'),
      exclude: [
        '**/dist/**',
        'packages/desktop/release/**',
      ],
    },
  },
})
