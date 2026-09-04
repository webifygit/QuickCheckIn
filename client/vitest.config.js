import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
    include: ['src/**/*.test.{js,jsx}'],
    restoreMocks: true,

    // One jsdom environment per file is expensive, and six of them running at
    // once starve each other badly enough that tests which take ~300ms alone
    // blow past the default 5s timeout - 11 of 37 failed that way, and which
    // ones varied between runs. Serial costs about 27s for the whole suite and
    // is the same on a 2-core CI runner as it is on a laptop.
    fileParallelism: false,

    // Headroom for a cold, loaded CI machine. Tests here run in hundreds of
    // milliseconds; anything near this ceiling is genuinely stuck.
    testTimeout: 15_000,
  },
});
