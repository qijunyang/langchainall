/**
 * Phase 5 — Persistent multi-chat (Option C): one stateless agent + an external
 * checkpointer keyed by thread_id, with per-user ownership. ChatGPT-style.
 *
 * The agent itself lives in ./chat/agent.ts (shared with the HTTP server).
 * This file is just the CLI front-end; it streams the reply token by token.
 *
 * Usage (invoke tsx directly — `npm run chat -- --user ...` drops the flags
 * under PowerShell, where npm's `--` forwarding is broken):
 *   npx tsx src/05-chat.ts --user u1 --thread t1 "Hi, my name is Bob"
 *   npx tsx src/05-chat.ts --user u1 --thread t1 "What's my name?"   # recalls "Bob"
 *   npx tsx src/05-chat.ts --user u1 --list                          # list u1's chats
 *   npx tsx src/05-chat.ts --user u1 "New chat without a thread id"  # mints a thread id
 */
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { streamChat } from "./chat/agent.js";
import { ensureSchema, listThreads, closeStore } from "./chat/store.js";

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
  let started = false;
  for await (const token of streamChat(userId, threadId, question)) {
    if (!started) {
      process.stdout.write(`\n[${userId} @ ${threadId}]\n> ${question}\n< `);
      started = true;
    }
    process.stdout.write(token);
  }
  if (started) process.stdout.write("\n");
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
