import { defineConfig } from 'vite';

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
});
