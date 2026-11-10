import preact from '@preact/preset-vite'
import { defineConfig } from 'vite'

const target = 'http://localhost:8787' // wrangler dev
const proxied = ['/authorize', '/oauth', '/.well-known', '/mcp']

export default defineConfig({
  plugins: [preact()],
  build: { outDir: '../server/public', emptyOutDir: true, target: 'es2022', sourcemap: false },
  server: {
    proxy: {
      '/api': { target, ws: true },
      ...Object.fromEntries(proxied.map((p) => [p, { target }])),
    },
  },
})
