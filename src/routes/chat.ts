/**
 * chat.ts — POST /api/chat
 *
 * Accepts a user message, runs it through the LLM pipeline (with idempotency
 * check), and returns the assistant's reply plus a duplicate flag.
 */

import { Router, Request, Response } from "express";
import { processMessage } from "../llm";

const router = Router();

router.post("/", async (req: Request, res: Response): Promise<void> => {
  const { message } = req.body as { message?: string };

  if (!message || typeof message !== "string" || message.trim() === "") {
    res.status(400).json({ error: "message is required and must be a non-empty string" });
    return;
  }

  try {
    const result = await processMessage(message.trim());
    res.json({
      reply: result.reply,
      duplicate: result.duplicate,
      affectedTaskIds: result.affectedTaskIds,
    });
  } catch (err) {
    console.error("[chat] LLM error:", err);
    res.status(500).json({
      error: "LLM processing failed",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

export default router;
