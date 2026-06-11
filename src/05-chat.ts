/**
 * Phase 5 — Persistent multi-chat (Option C): one stateless agent + an external
 * checkpointer keyed by thread_id, with per-user ownership. ChatGPT-style.
 *
 * Each run is a SEPARATE process, so history MUST live in a durable store
 * (Postgres here) — that's the whole point: memory survives across runs.
 *
 * Usage:
 *   npm run chat -- --user u1 --thread t1 "Hi, my name is Bob"
 *   npm run chat -- --user u1 --thread t1 "What's my name?"   # recalls "Bob"
 *   npm run chat -- --user u1 --thread t2 "What's my name?"   # different chat: doesn't know
 *   npm run chat -- --user u2 --thread t1 "..."               # rejected: not u2's thread
 *   npm run chat -- --user u1 --list                          # list u1's chats
 *   npm run chat -- --user u1 "New chat without a thread id"  # mints a thread id
 */
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { createAgent, createMiddleware } from "langchain";
import { HumanMessage, trimMessages } from "@langchain/core/messages";
import { createModel } from "./config.js";
import {
  DATABASE_URL,
  ensureSchema,
  authorizeOrCreate,
  touchThread,
  listThreads,
  closeStore,
} from "./chat/store.js";

// How many recent messages to keep in the PROMPT (sliding window). The full
// history still persists in the checkpointer — this only bounds what the model
// sees each turn, so context-window/latency/cost stay flat as a thread grows.
const CHAT_MAX_MESSAGES = Number(process.env.CHAT_MAX_MESSAGES ?? 10);

// Middleware: trim history right before each model call. wrapModelCall sees the
// rehydrated messages and we shrink them to the last N — without touching what
// gets stored back to the checkpointer.
const trimHistory = createMiddleware({
  name: "TrimHistory",
  wrapModelCall: async (request, handler) => {
    const trimmed = await trimMessages(request.messages, {
      strategy: "last",
      maxTokens: CHAT_MAX_MESSAGES, // "tokens" counted as messages, see below
      tokenCounter: (msgs) => msgs.length,
      startOn: "human", // keep the window starting on a human turn
      includeSystem: true,
    });
    if (process.env.CHAT_DEBUG === "1") {
      console.error(
        `[trim] ${request.messages.length} -> ${trimmed.length} messages sent to model`,
      );
    }
    return handler({ ...request, messages: trimmed });
  },
});

function parseCli(): {
  user: string;
  thread?: string;
  list: boolean;
  question?: string;
} {
  const { values, positionals } = parseArgs({
    options: {
      user: { type: "string" },
      thread: { type: "string" },
      list: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  if (!values.user) {
    throw new Error("Missing required --user <userId>");
  }
  return {
    user: values.user,
    thread: values.thread,
    list: values.list ?? false,
    question: positionals.join(" ").trim() || undefined,
  };
}

async function runList(userId: string): Promise<void> {
  const threads = await listThreads(userId);
  if (threads.length === 0) {
    console.log(`No chats yet for user "${userId}".`);
    return;
  }
  console.log(`Chats for "${userId}" (most recent first):`);
  for (const t of threads) {
    console.log(`  ${t.threadId}  —  "${t.title}"  (updated ${t.updatedAt})`);
  }
}

async function runChat(
  userId: string,
  threadId: string,
  question: string,
): Promise<void> {
  // Authorize (or create the thread on first use). Title = first message.
  await authorizeOrCreate(threadId, userId, question.slice(0, 60));

  // The checkpointer is the external, durable state store keyed by thread_id.
  const checkpointer = PostgresSaver.fromConnString(DATABASE_URL);
  await checkpointer.setup(); // idempotent: creates checkpoint tables if needed

  // One stateless agent; state lives in the checkpointer, selected per-invoke.
  // No tools here: this is a pure conversational agent, so the model focuses on
  // chatting instead of being tempted to emit tool calls on small talk.
  const agent = createAgent({
    model: createModel(),
    tools: [],
    checkpointer,
    middleware: [trimHistory],
  });

  // NOTE (single-shot CLI): no per-thread lock needed — one process = one
  // invoke. In a server you'd serialize concurrent runs on the SAME thread_id
  // (in-process mutex for one node; a DISTRIBUTED lock when multi-instance).

  // Pass ONLY the new message; the checkpointer rehydrates prior history.
  const result = await agent.invoke(
    { messages: [new HumanMessage(question)] },
    { configurable: { thread_id: threadId } },
  );

  await touchThread(threadId);

  const last = result.messages[result.messages.length - 1];
  console.log(`\n[${userId} @ ${threadId}]`);
  console.log(`> ${question}`);
  console.log(`< ${typeof last.content === "string" ? last.content : JSON.stringify(last.content)}`);
}

async function main(): Promise<void> {
  const { user, thread, list, question } = parseCli();
  await ensureSchema();

  if (list) {
    await runList(user);
    return;
  }
  if (!question) {
    throw new Error('Provide a message, e.g. --user u1 --thread t1 "hello"');
  }

  const threadId = thread ?? randomUUID();
  if (!thread) console.log(`(no --thread given; new chat: ${threadId})`);

  await runChat(user, threadId, question);
}

main()
  .catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeStore());
