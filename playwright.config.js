import { defineConfig, devices } from '@playwright/test';

const CLIENT_URL = 'http://localhost:5173';
const SERVER_URL = 'http://localhost:4000';

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.js',
  globalTeardown: './e2e/global-teardown.js',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // One worker: every spec shares the same database.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: CLIENT_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      // The full Chromium build - the lighter headless-shell binary fails to
      // start on some Windows installs.
      use: { ...devices['Desktop Chrome'], channel: 'chromium' },
    },
  ],
  webServer: [
    {
      command: 'npm --prefix server run start',
      url: `${SERVER_URL}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'npm --prefix client run dev -- --port 5173 --strictPort',
      url: CLIENT_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
