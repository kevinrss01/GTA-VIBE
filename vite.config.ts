// `vitest/config` re-exports Vite's own `defineConfig` widened to accept the
// `test` block below. The build reads this file through Vite as before.
import { defineConfig } from 'vitest/config';

// The game is a static single-page bundle. Three.js is split into its own chunk so
// the engine can be cached independently of frequently-changing world/build code.
export default defineConfig({
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: (id: string): string | undefined =>
          id.includes('node_modules/three') ? 'three' : undefined,
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  preview: {
    port: 4183,
    strictPort: true,
  },
  test: {
    /*
     * `.claude/worktrees` holds full checkouts of this repository made by
     * agent tooling. Vitest's default excludes cover `node_modules` and `dist`
     * but not those, so without this line a stale copy of every test runs
     * alongside the real one - twice the wall clock, and a green run that is
     * partly reporting on code nobody has edited in days.
     */
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/**'],
  },
});
