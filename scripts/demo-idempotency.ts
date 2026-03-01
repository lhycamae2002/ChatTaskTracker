/**
 * scripts/demo-idempotency.ts — Idempotency demonstration
 *
 * Usage:  npm run demo:idempotency
 *         (server must be running: npm run dev)
 *
 * This script proves S2 — no duplicate effects when the same message is
 * submitted more than once.
 *
 * Steps:
 *   1. Reset the system to a clean slate
 *   2. Send message A → tasks are created, count = N
 *   3. Send message A again (exact duplicate) → idempotent replay, count still = N
 *   4. Send message B (different) → tasks are created, count = N + M
 *   5. Print a summary table
 */

const BASE_URL = process.env.SERVER_URL ?? "http://localhost:3000";

async function post(path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function getTasks(): Promise<Array<{ id: string; title: string; status: string }>> {
  const res = await fetch(`${BASE_URL}/api/tasks`);
  return res.json() as Promise<Array<{ id: string; title: string; status: string }>>;
}

async function main() {
  console.log("=".repeat(60));
  console.log(" Idempotency Demo — ChatTaskTracker");
  console.log("=".repeat(60));

  // ── Step 1: Reset ───────────────────────────────────────────────
  console.log("\n[1] Resetting system to clean slate…");
  await post("/admin/reset");
  const initial = await getTasks();
  console.log(`    Task count after reset: ${initial.length} (expected: 0)`);
  assert(initial.length === 0, "Expected 0 tasks after reset");

  // ── Step 2: First send of message A ────────────────────────────
  const MESSAGE_A =
    "I need to fix the authentication bug and also set up CI/CD pipeline";
  console.log(`\n[2] Sending message A (first time)…`);
  console.log(`    Message: "${MESSAGE_A}"`);
  const resp1 = (await post("/api/chat", { message: MESSAGE_A })) as {
    reply: string;
    duplicate: boolean;
  };
  console.log(`    Reply:   "${resp1.reply.slice(0, 80)}…"`);
  console.log(`    Duplicate flag: ${resp1.duplicate} (expected: false)`);
  assert(!resp1.duplicate, "First send should NOT be flagged as duplicate");

  const afterFirstSend = await getTasks();
  const countAfterFirst = afterFirstSend.length;
  console.log(`    Tasks after first send: ${countAfterFirst}`);
  console.log(`    Tasks: ${afterFirstSend.map(t => `"${t.title}"`).join(", ")}`);

  // ── Step 3: Same message A again ───────────────────────────────
  console.log(`\n[3] Sending message A AGAIN (duplicate)…`);
  console.log(`    Message: "${MESSAGE_A}"`);
  const resp2 = (await post("/api/chat", { message: MESSAGE_A })) as {
    reply: string;
    duplicate: boolean;
  };
  console.log(`    Reply:   "${resp2.reply.slice(0, 80)}…"`);
  console.log(`    Duplicate flag: ${resp2.duplicate} (expected: true)`);
  assert(resp2.duplicate, "Second send MUST be flagged as duplicate");

  const afterSecondSend = await getTasks();
  const countAfterSecond = afterSecondSend.length;
  console.log(`    Tasks after duplicate send: ${countAfterSecond} (expected: ${countAfterFirst})`);
  assert(
    countAfterSecond === countAfterFirst,
    `Duplicate message must NOT create new tasks (expected ${countAfterFirst}, got ${countAfterSecond})`
  );

  // ── Step 4: Different message B ────────────────────────────────
  const MESSAGE_B = "Also need to write unit tests for the payment module";
  console.log(`\n[4] Sending message B (new, different message)…`);
  console.log(`    Message: "${MESSAGE_B}"`);
  const resp3 = (await post("/api/chat", { message: MESSAGE_B })) as {
    reply: string;
    duplicate: boolean;
  };
  console.log(`    Reply:   "${resp3.reply.slice(0, 80)}…"`);
  console.log(`    Duplicate flag: ${resp3.duplicate} (expected: false)`);
  assert(!resp3.duplicate, "Different message should NOT be flagged as duplicate");

  const afterMessageB = await getTasks();
  console.log(`    Tasks after message B: ${afterMessageB.length} (expected: > ${countAfterFirst})`);
  assert(
    afterMessageB.length > countAfterFirst,
    "New message must create additional tasks"
  );

  // ── Summary ────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(60));
  console.log(" IDEMPOTENCY PROOF SUMMARY");
  console.log("=".repeat(60));
  console.log(` After reset:           0 tasks`);
  console.log(` After message A:       ${countAfterFirst} tasks`);
  console.log(` After duplicate A:     ${countAfterSecond} tasks  ← same, no duplicates ✅`);
  console.log(` After message B:       ${afterMessageB.length} tasks`);
  console.log("\n✅ All idempotency assertions passed!\n");
}

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`\n❌ ASSERTION FAILED: ${message}\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Demo failed:", err);
  process.exit(1);
});
