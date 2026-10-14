import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  test: {
    environment: 'node',
    // Component tests are `.test.tsx` and ask for a browser-like environment with a comment at
    // the top of the file (`// @vitest-environment jsdom`); everything else runs in Node.
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./vitest.setup.ts'],
    // Integration tests need a real Postgres built from the migrations:
    //   TEST_DATABASE_URL=postgres://... pnpm test
    // They are skipped (not failed) when it is not set.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    // next-auth imports `next/server` without the extension Node's ESM loader needs; let Vite resolve it.
    server: { deps: { inline: [/next-auth/, /@auth\/core/] } },
  },
});
