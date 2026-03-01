/**
 * admin.ts — System administration endpoints
 *
 * POST /admin/reset — wipe all tasks, details, messages, and the
 *                     idempotency log so tests can start from a clean slate.
 *
 * S5 requirement: "provide a simple way to reset the system state."
 * Also exposed via `npm run reset` (scripts/reset.ts).
 */

import { Router, Request, Response } from "express";
import * as db from "../db";

const router = Router();

router.post("/reset", (_req: Request, res: Response): void => {
  try {
    db.resetAll();
    console.log("[admin] System reset — all data cleared.");
    res.json({ message: "System reset. All tasks, details, and history have been cleared." });
  } catch (err) {
    console.error("[admin] reset error:", err);
    res.status(500).json({ error: "Reset failed" });
  }
});

export default router;
