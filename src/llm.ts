/**
 * llm.ts — LLM integration via Vercel AI SDK
 *
 * Supports three providers, selected via LLM_PROVIDER env var:
 *   - "gemini"     (default) — Google Gemini via @ai-sdk/google
 *   - "openai"               — OpenAI via @ai-sdk/openai
 *   - "openrouter"           — OpenRouter via @ai-sdk/openai (OpenAI-compatible)
 *
 * Flow per message:
 *   1. Fetch conversation history
 *   2. Idempotency check (sha256 of lastAssistantReply + trimmed message)
 *   3. Build system prompt with current task list (including notes)
 *   4. Call LLM with tool definitions (create_tasks, complete_task, attach_detail, delete_detail)
 *   5. SDK auto-executes tool calls and loops up to maxSteps times
 *   6. Persist user + assistant turn, mark message hash as processed
 *   7. Return final text reply
 *
 * Idempotency guarantee:
 *   sha256(message.trim()) is stored after the first successful processing.
 *   Messages shorter than MIN_IDEMPOTENCY_LENGTH (20 chars) are never cached
 *   because they are inherently contextual ("yes", "ok", "done") and caching
 *   them would replay stale responses in a later, unrelated turn.
 */

import { generateText, tool, LanguageModelV1 } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { createHash } from "crypto";
import * as db from "./db";

// ─── Provider selection ───────────────────────────────────────────────────────

type Provider = "gemini" | "openai" | "openrouter";

const PROVIDER = (process.env.LLM_PROVIDER ?? "gemini").toLowerCase() as Provider;

function createModel(): LanguageModelV1 {
  if (PROVIDER === "openai") {
    const openai = createOpenAI({
      apiKey: process.env.OPENAI_API_KEY ?? "",
    });
    const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
    console.log(`[llm] Provider: OpenAI — model: ${model}`);
    return openai(model);
  }

  if (PROVIDER === "openrouter") {
    const openrouter = createOpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: process.env.OPENROUTER_API_KEY ?? "",
      headers: {
        // Recommended by OpenRouter for usage tracking / rankings
        "HTTP-Referer": process.env.APP_URL ?? "http://localhost:3000",
        "X-Title": "ChatTaskTracker",
      },
    });
    const model = process.env.OPENROUTER_MODEL ?? "meta-llama/llama-3.3-70b-instruct:free";
    console.log(`[llm] Provider: OpenRouter — model: ${model}`);
    return openrouter(model);
  }

  // Default: Google Gemini
  const google = createGoogleGenerativeAI({
    apiKey: process.env.GEMINI_API_KEY ?? "",
  });
  const model = process.env.GEMINI_MODEL ?? "gemini-2.0-flash";
  console.log(`[llm] Provider: Gemini — model: ${model}`);
  return google(model);
}

// Create the model once at startup (env vars are read once)
const activeModel = createModel();

// ─── System prompt builder ────────────────────────────────────────────────────

function buildSystemPrompt(tasks: db.TaskWithDetails[]): string {
  const taskList =
    tasks.length > 0
      ? tasks
          .map((t, i) => {
            let entry = `  #${i + 1}. "${t.title}" — ${t.status}`;
            if (t.details.length > 0) {
              const notes = t.details
                .map((d, j) => `    Note ${j + 1}: "${d.content}"`)
                .join("\n");
              entry += "\n" + notes;
            }
            return entry;
          })
          .join("\n")
      : "  (no tasks yet)";

  return `You are a task management assistant. You help users create, complete, and annotate tasks through natural conversation.

## Current Task List
${taskList}

## Available Tools
- create_tasks   — Create one or more tasks from the user's message
- complete_task  — Mark a task as completed using its NUMBER from the list above (e.g. task_number: 2)
- attach_detail  — Append a free-text note or update to a task using its NUMBER (e.g. task_number: 2)
- delete_detail  — Delete a specific note from a task using task NUMBER and note NUMBER (e.g. task_number: 2, detail_number: 1)

## Behaviour Rules
CRITICAL: You MUST call the appropriate tool BEFORE claiming any action was taken.
Never say "I've marked X as completed", "I've added a note", or similar unless you
have actually called the corresponding tool (complete_task, attach_detail, etc.)
in this exact turn. If you did not call a tool, do not claim you did.

1. Parse the user's message holistically. A single message may imply multiple tasks
   (e.g. "fix the bug and write docs" → 2 tasks). Create all of them in one tool call.
2. For completing or annotating a task, use the #N number shown in the list above.
   Match the task by closest title similarity, then pass that number to the tool.
3. For deleting a note, identify which task and which Note N the user means from context.
4. If the request is ambiguous (multiple tasks could match), respond with
   a short clarifying question WITHOUT calling any tool.
5. Do NOT create tasks for purely conversational messages (greetings, questions about
   yourself, etc.).
6. After executing tools, respond with a concise, friendly summary of exactly what
   was done (list created tasks, confirm completions, confirm note attachments/deletions).
7. Keep responses short — 1-4 sentences maximum.`;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export interface ProcessResult {
  reply: string;
  /** true when this exact message was already processed (idempotent replay) */
  duplicate: boolean;
  /** IDs of tasks created/completed/annotated in this turn — used by the UI to auto-expand */
  affectedTaskIds: string[];
}

// Messages shorter than this are never cached. Single-word/short replies like
// "yes", "ok", "done", "really?" are inherently contextual — caching them by
// text alone would replay stale responses when the same word is used later in
// a completely different turn.
const MIN_IDEMPOTENCY_LENGTH = 20;

export async function processMessage(
  userMessage: string
): Promise<ProcessResult> {
  // ── 1. Idempotency check ──────────────────────────────────────────────────
  // Only cache messages long enough to be unambiguous. Short contextual words
  // ("yes", "ok") skip the cache entirely so they are always processed fresh.
  const trimmed = userMessage.trim();
  const isIdempotent = trimmed.length >= MIN_IDEMPOTENCY_LENGTH;
  const hash = createHash("sha256").update(trimmed).digest("hex");
  if (isIdempotent) {
    const cached = db.getProcessedMessage(hash);
    if (cached !== null) {
      return { reply: cached, duplicate: true, affectedTaskIds: [] };
    }
  }

  // ── 2. Build context ──────────────────────────────────────────────────────
  const history = db.getRecentMessages(20); // last 20 turns to cap prompt size
  const tasks = db.getTasksWithDetails();

  // Build messages array: history + current user turn
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: userMessage },
  ];

  // ── 4. Call LLM with tools ────────────────────────────────────────────────
  // Collect IDs of every task touched during this turn so the UI can auto-expand them
  const affectedTaskIds: string[] = [];

  const result = await generateText({
    model: activeModel,
    system: buildSystemPrompt(tasks),
    messages,
    maxSteps: 5, // allow tool call → result → final text in one go
    tools: {
      /**
       * create_tasks — creates one or more tasks in a single call.
       * The LLM passes an array so that "fix bug and write docs" →
       * two task objects in one invocation.
       */
      create_tasks: tool({
        description:
          "Create one or more tasks. Use a single call with all tasks in the array.",
        parameters: z.object({
          tasks: z
            .array(
              z.object({
                title: z
                  .string()
                  .describe("Clear, action-oriented task title (≤ 80 chars)"),
              })
            )
            .min(1)
            .describe("List of tasks to create"),
        }),
        execute: async ({ tasks: newTasks }) => {
          const created = newTasks.map((t) => db.createTask(t.title));
          created.forEach((t) => affectedTaskIds.push(t.id));
          return {
            created: created.map((t) => ({ id: t.id, title: t.title })),
          };
        },
      }),

      /**
       * complete_task — marks a single task as completed.
       * The LLM uses the task NUMBER (#N) shown in the system prompt — never a UUID.
       * Using an integer eliminates ID-copy errors entirely.
       */
      complete_task: tool({
        description: "Mark a task as completed. Use the task's #N number from the task list.",
        parameters: z.object({
          task_number: z
            .number()
            .int()
            .min(1)
            .describe("The #N position of the task in the current task list (e.g. 2 for #2)"),
        }),
        execute: async ({ task_number }) => {
          const allTasks = db.getTasks();
          const task = allTasks[task_number - 1];
          if (!task) return { error: `No task at position #${task_number}` };
          const completed = db.completeTask(task.id);
          if (!completed) return { error: `Failed to complete task #${task_number}` };
          affectedTaskIds.push(completed.id);
          return { completed: { number: task_number, title: completed.title } };
        },
      }),

      /**
       * attach_detail — appends a free-text note to a task.
       * The LLM uses the task NUMBER (#N) shown in the system prompt — never a UUID.
       */
      attach_detail: tool({
        description:
          "Append a free-text note, update, or detail to a task. Use the task's #N number from the task list.",
        parameters: z.object({
          task_number: z
            .number()
            .int()
            .min(1)
            .describe("The #N position of the task in the current task list (e.g. 2 for #2)"),
          detail: z
            .string()
            .describe("The note or detail to attach (free text)"),
        }),
        execute: async ({ task_number, detail }) => {
          const allTasks = db.getTasks();
          const task = allTasks[task_number - 1];
          if (!task) return { error: `No task at position #${task_number}` };
          const d = db.attachDetail(task.id, detail);
          affectedTaskIds.push(task.id);
          return { attached: { number: task_number, task_title: task.title, detail: d.content } };
        },
      }),

      /**
       * delete_detail — removes a specific note from a task.
       * Both task and note are identified by their position numbers shown in
       * the system prompt, so the LLM never needs to handle UUIDs.
       */
      delete_detail: tool({
        description:
          "Delete a specific note from a task. Use the task's #N number and the Note N number shown in the task list.",
        parameters: z.object({
          task_number: z
            .number()
            .int()
            .min(1)
            .describe("The #N position of the task in the current task list"),
          detail_number: z
            .number()
            .int()
            .min(1)
            .describe("The Note N number of the note to delete (as shown under the task)"),
        }),
        execute: async ({ task_number, detail_number }) => {
          const allTasks = db.getTasksWithDetails();
          const task = allTasks[task_number - 1];
          if (!task) return { error: `No task at position #${task_number}` };
          const detail = task.details[detail_number - 1];
          if (!detail)
            return { error: `No Note ${detail_number} on task #${task_number}` };
          db.deleteDetail(detail.id);
          affectedTaskIds.push(task.id);
          return {
            deleted: {
              task_number,
              task_title: task.title,
              detail_number,
              content: detail.content,
            },
          };
        },
      }),
    },
  });

  const rawReply = result.text?.trim() || "Done.";
  const toolCallsMade = result.steps.some((s) => s.toolCalls.length > 0);
  const anyToolSucceeded = affectedTaskIds.length > 0;

  // ── Phantom-tool-call guard ───────────────────────────────────────────────
  // If the LLM claims to have performed an action but no tool was actually
  // called, append a warning. This surfaces the model's hallucination to the
  // user immediately rather than leaving them to discover it in the UI.
  const actionClaimed = /\b(i['']ve (marked|added|created|completed|deleted|updated|attached|removed)|done[.!])\b/i.test(rawReply);
  const reply =
    actionClaimed && !toolCallsMade
      ? rawReply + "\n\n⚠️ (Warning: no tool was actually called — the task state may not have changed. Please retry.)"
      : rawReply;

  // ── 5. Persist history & idempotency record ───────────────────────────────
  db.saveMessage("user", userMessage);
  db.saveMessage("assistant", reply);
  // Cache when the message is long enough to be idempotent AND one of:
  //   a) No tools were called AND the LLM didn't phantom-claim an action
  //      (i.e. a genuine conversational response — safe to cache)
  //   b) Tools were called and at least one succeeded
  const phantomAction = actionClaimed && !toolCallsMade;
  const safeTocache =
    isIdempotent &&
    ((!toolCallsMade && !phantomAction) || anyToolSucceeded);
  if (safeTocache) {
    db.markMessageProcessed(hash, reply);
  }

  return { reply, duplicate: false, affectedTaskIds };
}
