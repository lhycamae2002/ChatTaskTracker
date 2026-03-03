# ChatTaskTracker

An LLM-powered chat task tracker. Send natural-language messages; the assistant interprets them and creates, completes, or annotates tasks. A read-only web UI displays the task list and attached notes.

<video src="demo.mp4" controls width="100%"></video>

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy environment file and add your API key
cp .env.example .env
#    → edit .env, set LLM_PROVIDER and the matching API key

# 3. Start the dev server
npm run dev

# 4. Open the UI
open http://localhost:3000
```

---

## Architecture Overview

```text
┌─────────────────────────────────────────────────────────────┐
│  Browser (public/index.html)                                │
│  ┌─────────────────┐   ┌──────────────────────────────────┐ │
│  │  Task List (UI) │   │  Chat Interface                  │ │
│  │  GET /api/tasks │   │  POST /api/chat                  │ │
│  └────────┬────────┘   └──────────────┬───────────────────┘ │
└───────────┼──────────────────────────┼─────────────────────┘
            │                          │
┌───────────▼──────────────────────────▼─────────────────────┐
│  Express Server (src/index.ts)                              │
│                                                             │
│  /api/chat  → src/routes/chat.ts  → src/llm.ts             │
│  /api/tasks → src/routes/tasks.ts → src/db.ts              │
│  /admin     → src/routes/admin.ts → src/db.ts              │
└──────────────────────────────┬──────────────────────────────┘
                               │
               ┌───────────────▼──────────────┐
               │  SQLite (data/tasks.db)       │
               │  ─ tasks                      │
               │  ─ task_details               │
               │  ─ messages (history)         │
               │  ─ processed_messages (idem.) │
               └───────────────────────────────┘
                               │
               ┌───────────────▼──────────────┐
               │  Gemini / OpenRouter          │
               │  via Vercel AI SDK            │
               └───────────────────────────────┘
```

### Components

| Component       | Path                      | Responsibility                                                               |
| --------------- | ------------------------- | ---------------------------------------------------------------------------- |
| **DB layer**    | `src/db.ts`               | All SQLite I/O (synchronous, better-sqlite3)                                 |
| **LLM layer**   | `src/llm.ts`              | Provider selection, tool execution, idempotency check                        |
| **Chat route**  | `src/routes/chat.ts`      | `POST /api/chat`                                                             |
| **Tasks route** | `src/routes/tasks.ts`     | `GET /api/tasks`, `GET /api/tasks/:id`, `PATCH /api/tasks/:id/complete`      |
| **Admin route** | `src/routes/admin.ts`     | `POST /admin/reset`                                                          |
| **Web UI**      | `public/index.html`       | Single-file HTML/CSS/JS — chat + task list side by side                      |

---

## How the LLM is Used

### Prompting approach — Tool/Function Calling

Every user message goes through `src/llm.ts → processMessage()`:

1. **System prompt** is built dynamically, injecting the current task list with IDs:

   ```text
   Current Task List
     1. [ID: abc-123] "Fix login bug" — pending
     2. [ID: def-456] "Write API docs" — completed
   ```

   The LLM has full task context in every turn, enabling fuzzy matching without
   a separate retrieval step (valid because task sets are small — S3).

2. **Conversation history** — the last 20 messages are fetched from SQLite and
   prepended so the LLM has multi-turn context (S4). 20 turns is ~4,000–6,000
   tokens; well within Gemini's window and prevents runaway growth.

3. **Four tools are exposed** via the Vercel AI SDK's `tool()` helper:

   | Tool            | When the LLM calls it              | Parameters                                                    |
   | --------------- | ---------------------------------- | ------------------------------------------------------------- |
   | `create_tasks`  | Message implies new work items     | `tasks: [{title}]` — array so one call handles multiple tasks |
   | `complete_task` | User says something is done        | `task_number` — positional #N from the task list              |
   | `attach_detail` | User adds a note/update to a task  | `task_number`, `detail`                                       |
   | `delete_detail` | User removes a note from a task    | `task_number`, `detail_number`                                |

   Tasks and notes are identified by their **positional integer** (#1, #2, …) as
   shown in the system prompt — never by UUID. This eliminates hallucination errors
   that arise when the LLM tries to copy a 36-character UUID verbatim.

4. **`maxSteps: 5`** — the SDK's agentic loop. After tool execution, results
   are fed back and the LLM generates a final natural-language reply summarising
   what it did.

5. **Clarification** — if intent is ambiguous, the LLM returns plain text (no
   tool call). The system prompt instructs it to ask a short clarifying question
   in that case.

### Tool schema (abbreviated)

```typescript
create_tasks:  { tasks: Array<{ title: string }> }
complete_task: { task_number: number }
attach_detail: { task_number: number; detail: string }
delete_detail: { task_number: number; detail_number: number }
```

---

## Idempotency Approach

**Mechanism:** SHA-256 hash of the trimmed message text is stored in the
`processed_messages` table after the first successful processing. Any subsequent
request with an identical message returns the cached reply without re-invoking
the LLM or executing any tools.

Messages shorter than **20 characters** are never cached. Single-word/short
replies ("yes", "ok", "done") are inherently contextual — caching them by text
alone would replay stale responses when the same word is used in a different turn.

```text
User message
     │
     ▼
length < 20? → skip cache entirely (always process fresh)
     │
     ▼
sha256(message.trim())
     │
     ├─ found in processed_messages? → return cached reply (duplicate: true)
     │
     └─ not found → call LLM → execute tools → store hash+reply → return
```

**Why it works:**

- The hash check happens *before* any DB mutation.
- The hash insert uses `INSERT OR IGNORE` — safe even if two concurrent requests
  race (SQLite serialises writes, so one will insert and the other will be
  ignored on the next read).
- The result is only cached when tools succeeded OR when it was a pure
  conversational reply — phantom tool calls (LLM claimed success without calling
  a tool) are never cached so the user can retry.
- The UI shows an **"idempotent replay"** badge on duplicated replies so it's
  visually obvious.

**Tradeoff:** Hashing only the message text means a user who genuinely wants to
re-send the same text (after a reset, for example) will get the stale cached
reply. After a system reset, `processed_messages` is also cleared, so this only
applies within a session. In production, you'd scope the hash to a user/session
ID as well.

### Prove it

With the server running:

```bash
npm run demo:idempotency
```

The script:

1. Resets the system
2. Sends a message → tasks created
3. Sends the same message again → `duplicate: true`, no new tasks
4. Sends a different message → new tasks created normally
5. Prints a pass/fail summary

---

## API Reference

| Method  | Path                        | Description                                                     |
| ------- | --------------------------- | --------------------------------------------------------------- |
| `POST`  | `/api/chat`                 | `{ message: string }` → `{ reply: string, duplicate: boolean }` |
| `GET`   | `/api/tasks`                | Returns all tasks with their details                            |
| `GET`   | `/api/tasks/:id`            | Single task with details                                        |
| `PATCH` | `/api/tasks/:id/complete`   | Complete a task from the web UI                                 |
| `POST`  | `/admin/reset`              | Wipe all data                                                   |
| `GET`   | `/health`                   | Health check                                                    |

---

## Demo Path

### 1 — Create multiple tasks from one message

> *"I need to fix the login bug, write unit tests for the auth module, and update the deployment docs"*

The LLM calls `create_tasks` with all three titles in a single array. Three tasks appear instantly in the left panel.

### 2 — Complete a task with natural language

> *"The login bug is done"* (or *"mark the bug fix as complete"*)

The LLM identifies the matching task by title similarity and calls `complete_task`. The task gets a strikethrough and green dot in the UI.

### 3 — Attach a detail to a task

> *"The login bug turned out to be a JWT expiry issue in the auth middleware"*

The LLM calls `attach_detail` with the note. Click the task card to expand and see the attached note.

### 4 — Idempotency

After run server, on other terminal.
```bash
npm run demo:idempotency
```

---

## System Reset

Three ways to reset:

```bash
# CLI (no server needed)
npm run reset

# HTTP
curl -X POST http://localhost:3000/admin/reset

# UI — click the "Reset" button in the top-right corner
```

---

## Key Tradeoffs & What I'd Improve Next

### Tradeoffs Made

| Decision                              | Why                                          | Tradeoff                                                                          |
| ------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------- |
| **SQLite**                            | Zero-ops, file-based, no server              | Doesn't scale to concurrent writers                                               |
| **Hash = message text only**          | Simple, effective for retry prevention       | Same message after a reset gives stale cached reply (solved by clearing hash on reset) |
| **Full task list in system prompt**   | No retrieval complexity; works for small sets | Would break at thousands of tasks                                                |
| **20-message history window**         | Simple, predictable token usage              | Loses very old context; could summarise instead                                   |
| **Synchronous DB (better-sqlite3)**   | Simpler code, no async/await chains          | Blocks the event loop on heavy writes (fine for this scale)                       |

### What I'd Improve Next

1. **Streaming replies** — use `streamText` instead of `generateText` for a better chat UX (text appears word by word).
2. **Session / user scoping** — scope idempotency hashes and conversation history to a user or session ID.
3. **Smarter context management** — summarise old conversation turns instead of dropping them.
4. **Optimistic UI updates** — show the task immediately while the LLM is thinking; reconcile with server state on response.
5. **Postgres migration** — add a `DATABASE_URL` env var and swap `better-sqlite3` for `pg` + `drizzle-orm` for horizontal scale.
6. **Rate limiting & auth** — the `/admin/reset` endpoint is currently open.
7. **Task ordering / priority** — let users assign priority and sort the task list.

---

## Environment Variables

### Provider selection

| Variable       | Default    | Description                              |
| -------------- | ---------- | ---------------------------------------- |
| `LLM_PROVIDER` | `gemini`   | `gemini`, `openai`, or `openrouter`      |

### Google Gemini (`LLM_PROVIDER=gemini`)

| Variable       | Default              | Description                                                                    |
| -------------- | -------------------- | ------------------------------------------------------------------------------ |
| `GEMINI_API_KEY` | *(required)*       | API key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| `GEMINI_MODEL`   | `gemini-2.0-flash` | Any Gemini model ID                                                            |

### OpenAI (`LLM_PROVIDER=openai`)

| Variable       | Default       | Description                                                                    |
| -------------- | ------------- | ------------------------------------------------------------------------------ |
| `OPENAI_API_KEY` | *(required)* | API key from [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| `OPENAI_MODEL`   | `gpt-4o-mini` | Any OpenAI model ID that supports tool calling                                |

### OpenRouter (`LLM_PROVIDER=openrouter`)

| Variable            | Default                           | Description                                                              |
| ------------------- | --------------------------------- | ------------------------------------------------------------------------ |
| `OPENROUTER_API_KEY` | *(required)*                    | API key from [openrouter.ai/keys](https://openrouter.ai/keys)            |
| `OPENROUTER_MODEL`   | `meta-llama/llama-3.3-70b-instruct:free` | Any model from [openrouter.ai/models](https://openrouter.ai/models) — must support tool calling |
| `APP_URL`            | `http://localhost:3000`          | Sent as `HTTP-Referer` (recommended by OpenRouter)                       |

**Free-tier OpenRouter models that support tool calling:**

- `meta-llama/llama-3.3-70b-instruct:free` ← default
- `mistralai/mistral-small-3.1-24b-instruct:free`
- `google/gemini-2.0-flash-001` (stable, not `:free` — may incur small cost)

### Server

| Variable  | Default           | Description               |
| --------- | ----------------- | ------------------------- |
| `PORT`    | `3000`            | Server port               |
| `DB_PATH` | `./data/tasks.db` | SQLite database file path |
