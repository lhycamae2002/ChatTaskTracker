/**
 * scripts/reset.ts — CLI system reset
 *
 * Usage:  npm run reset
 *
 * Clears all tasks, details, conversation history, and the idempotency log.
 * Equivalent to POST /admin/reset but runnable without a live server.
 */

import "dotenv/config";
import * as db from "../src/db";

db.resetAll();
console.log("✅ System reset complete — all data cleared.");
process.exit(0);
