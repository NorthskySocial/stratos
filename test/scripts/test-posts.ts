#!/usr/bin/env -S deno run -A
// Post CRUD + boundary access control tests.
//
// Test matrix:
//   Rei writes a post with "swordsmith" boundary.
//   Rei can read own post (owner access).
//   Sakura (swordsmith boundary) can read Rei's post (shared boundary).
//   kaoruko (aekea boundary) CANNOT read Rei's post (no intersection).
//   Unauthenticated caller CANNOT read Rei's post.
//   listRecords filters correctly per boundary.

import { TEST_USERS } from "./lib/config.ts";
import {
  createRecord,
  getRecord,
  tryGetRecord,
  listRecords,
  deleteRecord,
} from "./lib/stratos.ts";
import { loadState, saveState } from "./lib/state.ts";
import { section, info, pass, fail, dim, summary } from "./lib/log.ts";

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string, detail?: string): void {
  if (condition) {
    pass(testName, detail);
    passed++;
  } else {
    fail(testName, detail);
    failed++;
  }
}

async function run() {
  section("Phase 4: Post CRUD & Boundary Tests");

  const state = await loadState();
  const rei = state.users.rei;
  const sakura = state.users.sakura;
  const kaoruko = state.users.kaoruko;

  if (!rei || !sakura || !kaoruko) {
    fail("Missing user state — run setup.ts + test-enrollment.ts first");
    Deno.exit(1);
  }

  // ─────────────────────────────────────────────────────────────
  // Test 1: Rei writes a post with swordsmith boundary
  // ─────────────────────────────────────────────────────────────
  section("Test 1: Create post with boundary");

  let postUri: string;
  let postRkey: string;
  let postCid: string;

  try {
    const result = await createRecord(rei.did, "app.stratos.feed.post", {
      $type: "app.stratos.feed.post",
      text: "Forging a new katana in the swordsmith workshop",
      boundary: { values: [{ value: "swordsmith" }] },
      createdAt: new Date().toISOString(),
    });

    postUri = result.uri;
    postCid = result.cid;
    postRkey = postUri.split("/").pop()!;

    assert(!!postUri && !!postCid, "Rei created post", postUri);

    // Save to state for later phases
    rei.records["post1"] = { uri: postUri, cid: postCid, rkey: postRkey };
    await saveState(state);
  } catch (err) {
    fail("Rei create post failed", String(err));
    failed++;
    Deno.exit(1);
  }

  // ─────────────────────────────────────────────────────────────
  // Test 2: Owner (Rei) can retrieve own post
  // ─────────────────────────────────────────────────────────────
  section("Test 2: Owner retrieves own post");

  try {
    const record = await getRecord(
      rei.did,
      "app.stratos.feed.post",
      postRkey,
      rei.did,
    );

    assert(record.uri === postUri, "Rei reads own post — URI matches");

    const value = record.value as Record<string, unknown>;
    assert(
      value.text === "Forging a new katana in the swordsmith workshop",
      "Rei reads own post — text matches",
    );

    const boundary = value.boundary as { values: Array<{ value: string }> } | undefined;
    assert(
      boundary?.values?.[0]?.value === "swordsmith",
      "Rei reads own post — boundary is swordsmith",
    );
  } catch (err) {
    fail("Rei get own post failed", String(err));
    failed++;
  }

  // ─────────────────────────────────────────────────────────────
  // Test 3: Same-boundary user (Sakura) can retrieve Rei's post
  // ─────────────────────────────────────────────────────────────
  section("Test 3: Same-boundary user reads post");

  try {
    const record = await getRecord(
      rei.did,
      "app.stratos.feed.post",
      postRkey,
      sakura.did,
    );

    assert(
      record.uri === postUri,
      "Sakura reads Rei's post (shared swordsmith boundary)",
      record.uri,
    );
  } catch (err) {
    fail("Sakura get Rei's post failed (should have access)", String(err));
    failed++;
  }

  // ─────────────────────────────────────────────────────────────
  // Test 4: Cross-boundary user (kaoruko) CANNOT retrieve Rei's post
  // ─────────────────────────────────────────────────────────────
  section("Test 4: Cross-boundary user denied");

  {
    const result = await tryGetRecord(
      rei.did,
      "app.stratos.feed.post",
      postRkey,
      kaoruko.did,
    );

    if (!result.ok) {
      assert(
        result.error.includes("RecordNotFound") || result.status === 400,
        "kaoruko denied Rei's post (aekea ≠ swordsmith)",
        `status=${result.status}`,
      );
    } else {
      fail(
        "kaoruko should NOT see Rei's post",
        `got: ${JSON.stringify(result.data.value).substring(0, 100)}`,
      );
      failed++;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Test 5: Unauthenticated caller CANNOT retrieve Rei's post
  // ─────────────────────────────────────────────────────────────
  section("Test 5: Unauthenticated access denied");

  {
    const result = await tryGetRecord(
      rei.did,
      "app.stratos.feed.post",
      postRkey,
      // no caller DID — unauthenticated
    );

    if (!result.ok) {
      assert(
        result.error.includes("RecordNotFound") || result.status === 400,
        "Unauthenticated caller denied",
        `status=${result.status}`,
      );
    } else {
      fail(
        "Unauthenticated caller should NOT see the post",
        `got: ${JSON.stringify(result.data.value).substring(0, 100)}`,
      );
      failed++;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Test 6: listRecords boundary filtering
  // ─────────────────────────────────────────────────────────────
  section("Test 6: listRecords boundary filtering");

  // Sakura (swordsmith) should see the post
  try {
    const sakuraList = await listRecords(
      rei.did,
      "app.stratos.feed.post",
      sakura.did,
    );
    assert(
      sakuraList.records.length > 0,
      "Sakura listRecords — sees Rei's post",
      `count=${sakuraList.records.length}`,
    );
  } catch (err) {
    fail("Sakura listRecords failed", String(err));
    failed++;
  }

  // kaoruko (aekea) should NOT see the post
  try {
    const kaorukoList = await listRecords(
      rei.did,
      "app.stratos.feed.post",
      kaoruko.did,
    );
    assert(
      kaorukoList.records.length === 0,
      "kaoruko listRecords — empty (no swordsmith boundary)",
      `count=${kaorukoList.records.length}`,
    );
  } catch (err) {
    fail("kaoruko listRecords failed", String(err));
    failed++;
  }

  // Unauthenticated should see nothing
  try {
    const anonList = await listRecords(
      rei.did,
      "app.stratos.feed.post",
    );
    assert(
      anonList.records.length === 0,
      "Unauthenticated listRecords — empty",
      `count=${anonList.records.length}`,
    );
  } catch (err) {
    fail("Unauthenticated listRecords failed", String(err));
    failed++;
  }

  // ─────────────────────────────────────────────────────────────
  // Test 7: kaoruko writes a post in aekea (own boundary)
  // ─────────────────────────────────────────────────────────────
  section("Test 7: kaoruko writes aekea-scoped post");

  let kaorukoPostRkey: string;

  try {
    const result = await createRecord(kaoruko.did, "app.stratos.feed.post", {
      $type: "app.stratos.feed.post",
      text: "Shopping at the Aekea marketplace",
      boundary: { values: [{ value: "aekea" }] },
      createdAt: new Date().toISOString(),
    });

    kaorukoPostRkey = result.uri.split("/").pop()!;
    assert(!!result.uri, "kaoruko created aekea post", result.uri);

    kaoruko.records["post1"] = {
      uri: result.uri,
      cid: result.cid,
      rkey: kaorukoPostRkey,
    };
    await saveState(state);
  } catch (err) {
    fail("kaoruko create aekea post failed", String(err));
    failed++;
    // Can still continue other tests
    kaorukoPostRkey = "";
  }

  // Rei (swordsmith only) should NOT see kaoruko's aekea post
  if (kaorukoPostRkey) {
    const reiResult = await tryGetRecord(
      kaoruko.did,
      "app.stratos.feed.post",
      kaorukoPostRkey,
      rei.did,
    );

    if (!reiResult.ok) {
      assert(
        reiResult.error.includes("RecordNotFound") || reiResult.status === 400,
        "Rei denied kaoruko's aekea post (swordsmith ≠ aekea)",
        `status=${reiResult.status}`,
      );
    } else {
      fail("Rei should NOT see kaoruko's aekea post");
      failed++;
    }

    // kaoruko can read own post
    try {
      const own = await getRecord(
        kaoruko.did,
        "app.stratos.feed.post",
        kaorukoPostRkey,
        kaoruko.did,
      );
      assert(
        own.uri === kaoruko.records["post1"].uri,
        "kaoruko reads own aekea post",
      );
    } catch (err) {
      fail("kaoruko read own aekea post failed", String(err));
      failed++;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Test 8: Delete record (cleanup)
  // ─────────────────────────────────────────────────────────────
  section("Test 8: Delete records");

  try {
    await deleteRecord(rei.did, "app.stratos.feed.post", postRkey);
    pass("Rei's swordsmith post deleted");
    passed++;

    // Verify it's gone
    const result = await tryGetRecord(
      rei.did,
      "app.stratos.feed.post",
      postRkey,
      rei.did,
    );
    assert(!result.ok, "Rei's post no longer retrievable after delete");
  } catch (err) {
    fail("Delete Rei's post failed", String(err));
    failed++;
  }

  if (kaorukoPostRkey) {
    try {
      await deleteRecord(kaoruko.did, "app.stratos.feed.post", kaorukoPostRkey);
      pass("kaoruko's aekea post deleted");
      passed++;
    } catch (err) {
      fail("Delete kaoruko's post failed", String(err));
      failed++;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Summary
  // ─────────────────────────────────────────────────────────────
  summary(passed, failed);

  if (failed > 0) {
    Deno.exit(1);
  }
}

run().catch((err) => {
  console.error("\nPost tests failed:", err);
  Deno.exit(1);
});
