/**
 * db.ts — SQLite persistence layer via better-sqlite3
 *
 * All operations are synchronous (better-sqlite3 API).
 * Schema:
 *   tasks            — core task records
 *   task_details     — append-only notes attached to tasks
 *   messages         — conversation history for LLM context window
 *   processed_messages — idempotency log (message hash → cached response)
 */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

const DB_PATH =
  process.env.DB_PATH ?? path.join(process.cwd(), "data", "tasks.db");

// Ensure the data directory exists before opening the DB
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(DB_PATH);

// WAL mode: better concurrent read performance
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ─── Schema ──────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'completed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS task_details (
    id         TEXT PRIMARY KEY,
    task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id         TEXT PRIMARY KEY,
    role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  -- Idempotency log: sha256(trimmed message) → cached LLM response
  CREATE TABLE IF NOT EXISTS processed_messages (
    message_hash TEXT PRIMARY KEY,
    response     TEXT NOT NULL,
    processed_at TEXT NOT NULL
  );
`);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Task {
  id: string;
  title: string;
  status: "pending" | "completed";
  created_at: string;
  updated_at: string;
}

export interface TaskDetail {
  id: string;
  task_id: string;
  content: string;
  created_at: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

export interface TaskWithDetails extends Task {
  details: TaskDetail[];
}

// ─── Task operations ──────────────────────────────────────────────────────────

const stmts = {
  insertTask: db.prepare<[string, string, string, string]>(`
    INSERT INTO tasks (id, title, status, created_at, updated_at)
    VALUES (?, ?, 'pending', ?, ?)
  `),
  selectAllTasks: db.prepare(`SELECT * FROM tasks ORDER BY created_at ASC`),
  selectTaskById: db.prepare(`SELECT * FROM tasks WHERE id = ?`),
  completeTask: db.prepare<[string, string]>(`
    UPDATE tasks SET status = 'completed', updated_at = ? WHERE id = ?
  `),

  insertDetail: db.prepare<[string, string, string, string]>(`
    INSERT INTO task_details (id, task_id, content, created_at)
    VALUES (?, ?, ?, ?)
  `),
  deleteDetail: db.prepare<[string]>(`DELETE FROM task_details WHERE id = ?`),
  selectDetailsByTask: db.prepare(`
    SELECT * FROM task_details WHERE task_id = ? ORDER BY created_at ASC
  `),

  insertMessage: db.prepare<[string, string, string, string]>(`
    INSERT INTO messages (id, role, content, created_at) VALUES (?, ?, ?, ?)
  `),
  selectRecentMessages: db.prepare(`
    SELECT * FROM (
      SELECT * FROM messages ORDER BY created_at DESC LIMIT ?
    ) ORDER BY created_at ASC
  `),

  selectProcessed: db.prepare(
    `SELECT response FROM processed_messages WHERE message_hash = ?`
  ),
  insertProcessed: db.prepare<[string, string, string]>(`
    INSERT OR IGNORE INTO processed_messages (message_hash, response, processed_at)
    VALUES (?, ?, ?)
  `),
};

export function createTask(title: string): Task {
  const now = new Date().toISOString();
  const id = randomUUID();
  stmts.insertTask.run(id, title, now, now);
  return stmts.selectTaskById.get(id) as Task;
}

export function getTasks(): Task[] {
  return stmts.selectAllTasks.all() as Task[];
}

export function getTask(id: string): Task | undefined {
  return stmts.selectTaskById.get(id) as Task | undefined;
}

export function completeTask(id: string): Task | undefined {
  const now = new Date().toISOString();
  stmts.completeTask.run(now, id);
  return stmts.selectTaskById.get(id) as Task | undefined;
}

export function getTaskWithDetails(id: string): TaskWithDetails | undefined {
  const task = stmts.selectTaskById.get(id) as Task | undefined;
  if (!task) return undefined;
  const details = stmts.selectDetailsByTask.all(id) as TaskDetail[];
  return { ...task, details };
}

export function getTasksWithDetails(): TaskWithDetails[] {
  const tasks = stmts.selectAllTasks.all() as Task[];
  return tasks.map((t) => ({
    ...t,
    details: stmts.selectDetailsByTask.all(t.id) as TaskDetail[],
  }));
}

// ─── Task detail operations ───────────────────────────────────────────────────

export function attachDetail(taskId: string, content: string): TaskDetail {
  const id = randomUUID();
  const now = new Date().toISOString();
  stmts.insertDetail.run(id, taskId, content, now);
  return { id, task_id: taskId, content, created_at: now };
}

export function getTaskDetails(taskId: string): TaskDetail[] {
  return stmts.selectDetailsByTask.all(taskId) as TaskDetail[];
}

export function deleteDetail(id: string): void {
  stmts.deleteDetail.run(id);
}

// ─── Conversation history ─────────────────────────────────────────────────────

export function saveMessage(role: "user" | "assistant", content: string): void {
  stmts.insertMessage.run(randomUUID(), role, content, new Date().toISOString());
}

/**
 * Returns up to `limit` most-recent messages, in chronological order,
 * so they can be passed directly to the LLM as conversation history.
 */
export function getRecentMessages(limit = 20): Message[] {
  return stmts.selectRecentMessages.all(limit) as Message[];
}

// ─── Idempotency ──────────────────────────────────────────────────────────────

export function getProcessedMessage(hash: string): string | null {
  const row = stmts.selectProcessed.get(hash) as
    | { response: string }
    | undefined;
  return row?.response ?? null;
}

export function markMessageProcessed(hash: string, response: string): void {
  stmts.insertProcessed.run(hash, response, new Date().toISOString());
}

// ─── System reset ─────────────────────────────────────────────────────────────

export function resetAll(): void {
  db.exec(`
    DELETE FROM task_details;
    DELETE FROM tasks;
    DELETE FROM messages;
    DELETE FROM processed_messages;
  `);
}
