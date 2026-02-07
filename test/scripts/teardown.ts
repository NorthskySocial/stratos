#!/usr/bin/env -S deno run -A
// Teardown — deletes test accounts, stops Stratos container, and cleans up test data.

import { PROJECT_ROOT, TEST_DATA_DIR } from "./lib/config.ts";
import { section, info, pass, fail, warn } from "./lib/log.ts";
import { loadState } from "./lib/state.ts";
import { deleteAccount } from "./lib/pds.ts";

async function run() {
  section("Teardown");

  // Delete test accounts from PDS
  info("Deleting test accounts from PDS...");
  const state = await loadState();
  for (const [name, user] of Object.entries(state.users)) {
    if (!user.did) {
      info(`Skipping ${name} (no DID recorded)`);
      continue;
    }
    try {
      await deleteAccount(user.did);
      pass(`Deleted ${name} (${user.did})`);
    } catch (err) {
      warn(`Failed to delete ${name}: ${err}`);
    }
  }

  // Stop Docker Compose
  info("Stopping Stratos container...");
  try {
    const compose = new Deno.Command("docker", {
      args: [
        "compose",
        "-f", "docker-compose.test.yml",
        "down", "--volumes", "--remove-orphans",
      ],
      cwd: PROJECT_ROOT,
      stdout: "piped",
      stderr: "piped",
    });
    const result = await compose.output();
    if (result.success) {
      pass("Container stopped");
    } else {
      const stderr = new TextDecoder().decode(result.stderr);
      warn(`Docker compose down returned non-zero: ${stderr}`);
    }
  } catch (err) {
    fail("Failed to stop container", String(err));
  }

  // Clean up test data
  info("Removing test-data directory...");
  try {
    await Deno.remove(TEST_DATA_DIR, { recursive: true });
    pass("test-data removed");
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      info("test-data directory already absent");
    } else {
      warn(`Could not remove test-data: ${err}`);
    }
  }

  info("Teardown complete");
}

run().catch((err) => {
  console.error("\nTeardown failed:", err);
  Deno.exit(1);
});
