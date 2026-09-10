import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'
import { execFileSync } from 'node:child_process'

function getBuildCommitHash() {
  try {
    const commit = /^[0-9a-f]{40}$/i.test(process.env.GITHUB_SHA || '')
      ? process.env.GITHUB_SHA!.slice(0, 12)
      : execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
        encoding: 'utf8',
      }).trim()
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      encoding: 'utf8',
    }).trim()
    return dirty ? `${commit} + uncommitted changes` : commit
  } catch {
    return 'unknown'
  }
}

const buildCommitHash = getBuildCommitHash()

export default defineConfig({
  plugins: [wasm(), topLevelAwait(), react()],
  base: process.env.VITE_BASE_PATH || './',
  build: {
    target: 'esnext',
  },
  define: {
    global: 'globalThis',
    __BUILD_COMMIT_HASH__: JSON.stringify(buildCommitHash),
  },
  optimizeDeps: {
    include: ['buffer', 'process'],
  },
  resolve: {
    alias: {
      buffer: 'buffer',
      process: 'process/browser',
    },
  },
})
