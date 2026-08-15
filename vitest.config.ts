/**
 * Vitest config: the node-side suites run in the default node environment;
 * client component suites opt into jsdom per file (see
 * tests/section.client.spec.tsx). The `@deepseek-ai` packages resolve to
 * their built lib/, so their CSS imports must be inlined into vite's
 * transform pipeline instead of being left for Node's loader, and the
 * browser-only bundles (dsh-client-runtime/client, dsh-client-web-react)
 * are aliased to faithful test doubles under tests/support/.
 */
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/dsh-client-runtime/client': fileURLToPath(new URL('./tests/support/client-runtime.ts', import.meta.url)),
      '@deepseek-ai/dsh-client-web-react': fileURLToPath(new URL('./tests/support/web-react.ts', import.meta.url)),
    },
  },
  test: {
    server: {
      deps: {
        inline: [/@deepseek-ai\//],
      },
    },
  },
})
