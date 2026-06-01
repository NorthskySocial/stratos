import { defineConfig, devices } from '@playwright/test'

/**
 * When E2E_BASE_URL is set (e.g. running against an externally managed dev
 * server such as the docker-compose `webapp` service), Playwright targets that
 * URL and does NOT spawn its own dev server. Otherwise it defaults to a local
 * vite dev server on port 5173 that it starts itself.
 *
 * See https://playwright.dev/docs/test-configuration.
 */
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173'
const useExternalServer = !!process.env.E2E_BASE_URL

export default defineConfig({
  testDir: './tests/e2e',
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: [['html'], ['list']],
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL,

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on',

    /* Screenshot and video on failure */
    screenshot: 'on',
    video: 'on',
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },

    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },

    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],

  /* Run your local dev server before starting the tests (unless one is
   * already provided externally via E2E_BASE_URL). */
  webServer: useExternalServer
    ? undefined
    : {
        command: 'pnpm run dev',
        url: 'http://localhost:5173',
        reuseExistingServer: !process.env.CI,
        cwd: './',
      },
})
