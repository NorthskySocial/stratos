#!/usr/bin/env -S deno run -A
// Enrollment test — drives the PDS OAuth flow via Playwright to enroll each user.

import { chromium, type Page, type Browser } from "npm:playwright@1.58.2";
import { TEST_USERS, STRATOS_URL } from "./lib/config.ts";
import { enrollmentStatus } from "./lib/stratos.ts";
import { loadState, saveState } from "./lib/state.ts";
import { section, info, pass, fail, warn, dim } from "./lib/log.ts";

const SCREENSHOT_DIR = new URL("../../test-data/screenshots", import.meta.url).pathname;

async function screenshotOnFailure(page: Page, name: string) {
  try {
    await Deno.mkdir(SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}.png`, fullPage: true });
    dim(`Screenshot saved: test-data/screenshots/${name}.png`);
  } catch {
    // best effort
  }
}

/**
 * Drive the PDS OAuth sign-in + consent flow for one user.
 *
 * Flow:
 *   1. GET /oauth/authorize?handle=<handle> → Stratos starts PAR, redirects to PDS
 *   2. PDS shows sign-in form (loginHint pre-fills username, may be readonly)
 *   3. Enter password + submit
 *   4. PDS shows consent/authorize page
 *   5. Click "Accept" / "Authorize" / "Allow"
 *   6. PDS redirects back to /oauth/callback → Stratos enrolls user
 *   7. Final page shows JSON with {success: true}
 */
async function enrollUser(
  browser: Browser,
  handle: string,
  password: string,
  label: string,
): Promise<{ success: boolean; did?: string; error?: string }> {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();

  try {
    // Step 1: Navigate to Stratos OAuth entry point
    info(`${label}: Navigating to OAuth authorize...`);
    const authorizeUrl = `${STRATOS_URL}/oauth/authorize?handle=${encodeURIComponent(handle)}`;
    
    // Stratos will redirect to PDS OAuth page — may take a moment
    await page.goto(authorizeUrl, { waitUntil: "networkidle", timeout: 30_000 });

    dim(`${label}: Current URL: ${page.url()}`);
    await screenshotOnFailure(page, `${label}-01-after-redirect`);

    // Step 2: We should now be on the PDS sign-in page
    // The PDS OAuth UI may use either the old or new frontend.
    // Handle pre-fills the username via loginHint — we just need to enter the password.

    // Wait for any form to appear
    await page.waitForSelector(
      'input[name="password"], input[type="password"]',
      { timeout: 15_000 },
    );

    dim(`${label}: Sign-in form detected`);

    // If username IS required (not pre-filled), fill it
    const usernameInput =
      (await page.$('input[name="username"]:not([readonly]):not([disabled])')) ??
      (await page.$('input[name="identifier"]:not([readonly]):not([disabled])'));
    if (usernameInput) {
      info(`${label}: Username field found, filling handle...`);
      await usernameInput.fill(handle);
    }

    // Fill password
    const passwordInput =
      (await page.$('input[name="password"]')) ??
      (await page.$('input[type="password"]'));
    if (!passwordInput) {
      throw new Error("Could not find password input on sign-in page");
    }
    await passwordInput.fill(password);

    dim(`${label}: Credentials entered, submitting...`);
    await screenshotOnFailure(page, `${label}-02-credentials-filled`);

    // Submit sign-in form — try multiple strategies
    const signInButton =
      (await page.$('button[type="submit"]')) ??
      (await page.$('button:has-text("Sign in")'));
    
    if (signInButton) {
      await signInButton.click();
    } else {
      // Fall back to pressing Enter on the password field
      await passwordInput.press("Enter");
    }

    // Step 3: Wait for navigation — either to consent page or directly to callback
    await page.waitForURL(
      (url) => {
        const s = url.toString();
        return s.includes("/oauth/callback") || s.includes("authorize") || s.includes("consent");
      },
      { timeout: 15_000 },
    );

    dim(`${label}: After sign-in URL: ${page.url()}`);
    await screenshotOnFailure(page, `${label}-03-after-signin`);

    // Step 4: If we're on a consent/authorize page, click the authorize button
    if (!page.url().includes("/oauth/callback")) {
      // Look for an accept/authorize button
      // Wait a moment for the consent page to render
      await page.waitForTimeout(1_000);

      const acceptButton =
        (await page.$('button:has-text("Accept")')) ??
        (await page.$('button:has-text("Authorize")')) ??
        (await page.$('button:has-text("Allow")')) ??
        (await page.$('button[type="submit"]'));

      if (acceptButton) {
        dim(`${label}: Clicking authorize/accept button...`);
        await acceptButton.click();
      } else {
        warn(`${label}: No authorize button found, trying submit...`);
        await page.keyboard.press("Enter");
      }

      // Wait for final redirect to callback
      await page.waitForURL(
        (url) => url.toString().includes(STRATOS_URL),
        { timeout: 15_000 },
      );
    }

    dim(`${label}: Final URL: ${page.url()}`);
    await screenshotOnFailure(page, `${label}-04-final`);

    // Step 5: Read the response — Stratos returns JSON on the callback page
    // Wait for the page to settle
    await page.waitForTimeout(1_000);

    // Try to extract JSON from the page body
    const bodyText = await page.textContent("body");
    dim(`${label}: Response body: ${bodyText?.substring(0, 200)}`);

    if (bodyText?.includes('"success":true') || bodyText?.includes('"enrolled"')) {
      try {
        // Try to parse JSON from <pre> or body
        const preText = (await page.textContent("pre")) ?? bodyText;
        const json = JSON.parse(preText!);
        return { success: true, did: json.did };
      } catch {
        return { success: true };
      }
    }

    // Even if we can't parse the response, check enrollment via API
    return { success: true };

  } catch (err) {
    await screenshotOnFailure(page, `${label}-error`);
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await context.close();
  }
}

async function run() {
  section("Phase 2: OAuth Enrollment");

  const state = await loadState();
  if (Object.keys(state.users).length === 0) {
    fail("No users in state — run setup.ts first");
    Deno.exit(1);
  }

  info("Launching headless browser...");
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  let passed = 0;
  let failed = 0;

  try {
    for (const [key, userDef] of Object.entries(TEST_USERS)) {
      const userState = state.users[key];
      if (!userState) {
        fail(`No state for user ${key} — skipping`);
        failed++;
        continue;
      }

      // Check if already enrolled
      try {
        const status = await enrollmentStatus(userState.did);
        if (status.enrolled) {
          warn(`${userDef.name} (${userState.did}) already enrolled — skipping`);
          userState.enrolled = true;
          passed++;
          continue;
        }
      } catch {
        // enrollment status check failed, try enrolling anyway
      }

      info(`Enrolling ${userDef.name} (${userState.handle})...`);
      const result = await enrollUser(
        browser,
        userState.handle,
        userState.password,
        key,
      );

      if (result.success) {
        // Verify enrollment via status API
        try {
          const status = await enrollmentStatus(userState.did);
          if (status.enrolled) {
            userState.enrolled = true;
            pass(`${userDef.name} enrolled successfully`, userState.did);
            passed++;
          } else {
            fail(`${userDef.name} enrollment — OAuth succeeded but status shows not enrolled`);
            failed++;
          }
        } catch (err) {
          fail(`${userDef.name} enrollment — status check failed: ${err}`);
          failed++;
        }
      } else {
        fail(`${userDef.name} enrollment failed`, result.error);
        failed++;
      }
    }
  } finally {
    await browser.close();
  }

  await saveState(state);
  
  section("Enrollment Summary");
  info(`${passed} enrolled, ${failed} failed`);

  if (failed > 0) {
    info("Check test-data/screenshots/ for debugging screenshots");
    Deno.exit(1);
  }
}

run().catch((err) => {
  console.error("\nEnrollment test failed:", err);
  Deno.exit(1);
});
