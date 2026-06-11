/**
 * HTTP API for the chat UI. Wraps the shared chat agent (src/chat/agent.ts).
 *
 *   GET  /api/conversations?userId=...      -> list the user's chats (sidebar)
 *   POST /api/chat  { userId, threadId?, message }
 *        -> streams the reply as NDJSON events (one JSON object per line):
 *           {type:"token"} ... then {type:"interrupt"} | {type:"done"} |
 *           {type:"error"}. A new chat (no threadId) gets a minted id in the
 *           `X-Thread-Id` response header.
 *   POST /api/chat/resume  { userId, threadId, decision: "approve" | "reject" }
 *        -> resume a run paused for human approval; streams events the same way.
 *
 * Start: npm run api   (defaults to http://localhost:3100)
 */
import { randomUUID } from "node:crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import {
  streamChat,
  resumeChat,
  type ChatEvent,
  type ResumeDecision,
} from "./chat/agent.js";
import { ensureSchema, listThreads } from "./chat/store.js";

// Stream agent events to the client as newline-delimited JSON (NDJSON). Each
// line is a ChatEvent ({type:"token"|"interrupt"}) plus a final {type:"done"}
// (or {type:"error"} once streaming has started).
async function pipeEvents(
  res: Response,
  threadId: string,
  events: AsyncGenerator<ChatEvent>,
): Promise<void> {
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("X-Thread-Id", threadId);

  let aborted = false;
  res.on("close", () => {
    if (!res.writableFinished) aborted = true;
  });

  const write = (ev: object) => res.write(JSON.stringify(ev) + "\n");

  try {
    for await (const ev of events) {
      if (aborted) break;
      if (process.env.CHAT_DEBUG === "1") console.log("[api] event:", ev.type);
      write(ev);
    }
    if (!aborted) write({ type: "done" });
    res.end();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) {
      res.status(403).json({ error: msg }); // authz/validation: before any write
    } else {
      write({ type: "error", value: msg });
      res.end();
    }
  }
}

const app = express();
app.use(express.json());

// List a user's conversations for the left panel.
app.get("/api/conversations", async (req: Request, res: Response) => {
  const userId = String(req.query.userId ?? "").trim();
  if (!userId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }
  const threads = await listThreads(userId);
  res.json(threads);
});

// Stream a chat turn as NDJSON events. A new chat (no threadId) gets a minted
// id returned in X-Thread-Id. The run may end with an `interrupt` event (the
// agent is awaiting human approval) instead of `done`.
app.post("/api/chat", async (req: Request, res: Response) => {
  const userId = String(req.body?.userId ?? "").trim();
  const message = String(req.body?.message ?? "").trim();
  const threadId = String(req.body?.threadId ?? "").trim() || randomUUID();

  if (!userId || !message) {
    res.status(400).json({ error: "userId and message are required" });
    return;
  }
  await pipeEvents(res, threadId, streamChat(userId, threadId, message));
});

// Resume an interrupted run with a human decision (approve | reject).
app.post("/api/chat/resume", async (req: Request, res: Response) => {
  const userId = String(req.body?.userId ?? "").trim();
  const threadId = String(req.body?.threadId ?? "").trim();
  const decisionType = String(req.body?.decision ?? "").trim();

  if (!userId || !threadId || (decisionType !== "approve" && decisionType !== "reject")) {
    res.status(400).json({
      error: "userId, threadId and decision (approve|reject) are required",
    });
    return;
  }
  const decision: ResumeDecision =
    decisionType === "approve"
      ? { type: "approve" }
      : { type: "reject", message: "User declined." };
  await pipeEvents(res, threadId, resumeChat(userId, threadId, decision));
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("API error:", err);
  if (!res.headersSent) res.status(500).json({ error: "internal error" });
});

const PORT = Number(process.env.API_PORT ?? 3100);

async function start(): Promise<void> {
  await ensureSchema();
  app.listen(PORT, () => {
    console.log(`Chat API listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
