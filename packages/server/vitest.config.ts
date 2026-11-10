import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

// The Worker serves the PWA from ./public; tests only need the directory to exist.
if (!existsSync('public/index.html')) {
  mkdirSync('public', { recursive: true })
  writeFileSync('public/index.html', '<!doctype html><title>Sudare</title>')
}

export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations('migrations'),
          PUBLIC_ORIGIN: 'https://sudare.test',
          ADMIN_SECRET: 'test-admin-secret-0123456789abcdef',
          ROUND_CLIENT_IDS: '',
        },
      },
    }),
  ],
  test: { setupFiles: ['./test/setup.ts'], testTimeout: 20_000 },
}))
