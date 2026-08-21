import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:4173',
    // Headless Chromium needs software GL for WebGL.
    launchOptions: {
      args: [
        '--enable-unsafe-swiftshader',
        '--use-angle=swiftshader',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },
  webServer: {
    command: 'node test/serve.mjs',
    port: 4173,
    reuseExistingServer: !process.env.CI,
  },
  projects: [{ name: 'chromium' }],
});
