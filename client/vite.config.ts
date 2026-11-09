import { defineConfig } from 'vitest/config';
import { canvasDev } from './dev/plugin';

// The bundle is served by the canvas service under /_canvas/_/ (see docs/protocol.md).
export default defineConfig({
  base: process.env.CANVAS_BASE ?? '/_canvas/_/',
  plugins: [canvasDev()],
  server: {
    port: Number(process.env.PORT ?? 5173),
    strictPort: true,
    host: '127.0.0.1',
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
