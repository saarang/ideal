import { defineConfig } from 'vitest/config';
import path from 'path';
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30000,
    hookTimeout: 60000,
  },
  resolve: { alias: { '@': path.resolve(__dirname, '.') } },
});
