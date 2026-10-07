import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Integration tests need a real Postgres built from the migrations:
    //   TEST_DATABASE_URL=postgres://... pnpm test
    // They are skipped (not failed) when it is not set.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
