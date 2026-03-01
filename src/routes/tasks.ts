/**
 * tasks.ts — Read-only task API + bonus complete-from-UI endpoint
 *
 * GET  /api/tasks          — list all tasks with their details
 * GET  /api/tasks/:id      — single task with details
 * PATCH /api/tasks/:id/complete — mark task complete from the web UI (bonus)
 */

import { Router, Request, Response } from "express";
import * as db from "../db";

const router = Router();

// GET /api/tasks
router.get("/", (_req: Request, res: Response): void => {
  try {
    const tasks = db.getTasksWithDetails();
    res.json(tasks);
  } catch (err) {
    console.error("[tasks] list error:", err);
    res.status(500).json({ error: "Failed to fetch tasks" });
  }
});

// GET /api/tasks/:id
router.get("/:id", (req: Request, res: Response): void => {
  try {
    const task = db.getTaskWithDetails(req.params.id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    res.json(task);
  } catch (err) {
    console.error("[tasks] get error:", err);
    res.status(500).json({ error: "Failed to fetch task" });
  }
});

// PATCH /api/tasks/:id/complete  (bonus: complete from web UI)
router.patch("/:id/complete", (req: Request, res: Response): void => {
  try {
    const task = db.completeTask(req.params.id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    res.json(task);
  } catch (err) {
    console.error("[tasks] complete error:", err);
    res.status(500).json({ error: "Failed to complete task" });
  }
});

export default router;
