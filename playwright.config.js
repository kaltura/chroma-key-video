import { defineConfig } from '@playwright/test';

// Headless Chromium needs software GL for WebGL; these flags are
// Chromium-only, so they live on the Chromium projects rather than globally.
const chromiumLaunch = {
  args: [
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    '--autoplay-policy=no-user-gesture-required',
  ],
};

export default defineConfig({
  testDir: './test',
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:4173',
  },
  webServer: {
    command: 'node test/serve.mjs',
    port: 4173,
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    {
      name: 'chromium',
      testMatch: /(e2e|footage)\.spec\.js/,
      use: { browserName: 'chromium', launchOptions: chromiumLaunch },
    },
    // Benchmarks run on demand (npm run bench / bench:all), not with the
    // default suite. One project per engine; results are written to
    // bench-results[-{engine}][-footage].json by the spec.
    {
      name: 'bench',
      testMatch: /bench\.spec\.js/,
      timeout: 180_000,
      use: { browserName: 'chromium', launchOptions: chromiumLaunch },
    },
    {
      name: 'bench-firefox',
      testMatch: /bench\.spec\.js/,
      timeout: 180_000,
      use: {
        browserName: 'firefox',
        launchOptions: {
          firefoxUserPrefs: {
            'media.autoplay.default': 0,
            'media.autoplay.blocking_policy': 0,
          },
        },
      },
    },
    {
      name: 'bench-webkit',
      testMatch: /bench\.spec\.js/,
      timeout: 180_000,
      use: { browserName: 'webkit' },
    },
  ],
});
