// Playwright config for the REAL-ELECTRON e2e suite (tests/e2e/).
// These tests launch the actual Electron app and therefore need a display
// (CI uses xvfb-run) and node_modules (electron + @playwright/test).
//
// The offline UI harness (tests/ui/) does NOT use this config — it is a plain
// node script driving Chromium with a mock bridge. See tests/ui/run.mjs.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1, // one Electron instance at a time — tabs share a profile dir
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    trace: 'retain-on-failure',
  },
});
