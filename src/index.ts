/**
 * index.ts — Express server entry point
 *
 * Routes:
 *   POST   /api/chat              — send a message, receive LLM reply
 *   GET    /api/tasks             — list all tasks with details
 *   GET    /api/tasks/:id         — single task with details
 *   PATCH  /api/tasks/:id/complete — complete task from UI (bonus)
 *   POST   /admin/reset           — wipe all data (S5)
 *   GET    /                      — serves public/index.html (chat + task UI)
 */

import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";

import chatRouter from "./routes/chat";
import tasksRouter from "./routes/tasks";
import adminRouter from "./routes/admin";

const app = express();
const PORT = Number(process.env.PORT ?? 3000);

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json());

// Serve the combined chat + task list UI
app.use(express.static(path.join(__dirname, "..", "public")));

// ─── API Routes ───────────────────────────────────────────────────────────────

app.use("/api/chat", chatRouter);
app.use("/api/tasks", tasksRouter);
app.use("/admin", adminRouter);

// ─── Health check ─────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║       ChatTaskTracker is running         ║
╠══════════════════════════════════════════╣
║  Web UI  →  http://localhost:${PORT}        ║
║  API     →  http://localhost:${PORT}/api    ║
║  Reset   →  POST /admin/reset            ║
╚══════════════════════════════════════════╝
  `);
});
