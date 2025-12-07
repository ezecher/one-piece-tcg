import { defineConfig } from 'playwright/test';

export default defineConfig({
  timeout: 60000,
  use: {
    headless: true,
    viewport: { width: 1280, height: 720 },
    actionTimeout: 15000,
    navigationTimeout: 30000,
  },
});

