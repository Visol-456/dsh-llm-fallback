/**
 * Vitest config: the node-side suites run in the default node environment;
 * client component suites opt into jsdom per file (see
 * tests/section.client.spec.tsx). The `@deepseek-ai` packages resolve to
 * their built lib/, so their CSS imports must be inlined into vite's
 * transform pipeline instead of being left for Node's loader, and the
 * browser-only store engine (`@deepseek-ai/dsh-client-store`) is aliased to a
 * faithful Node-side test double under tests/support/.
 */
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/dsh-client-store': fileURLToPath(new URL('./tests/support/client-runtime.ts', import.meta.url)),
      '@deepseek-ai/dsh-client-ui-primitives': fileURLToPath(new URL('./tests/support/ui-primitives.tsx', import.meta.url)),
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
