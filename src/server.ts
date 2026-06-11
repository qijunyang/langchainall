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

// Max wall-clock per turn before the run is aborted (also cancels the model).
const TURN_TIMEOUT_MS = Number(process.env.CHAT_TURN_TIMEOUT_MS ?? 120000);

// Stream agent events to the client as newline-delimited JSON (NDJSON). Each
// line is a ChatEvent ({type:"token"|"interrupt"}) plus a final {type:"done"}
// (or {type:"error"} once streaming has started). An AbortController cancels the
// run on a per-turn timeout OR a client disconnect, and the signal is passed
// into the agent (which cancels the underlying Ollama request).
async function pipeEvents(
  res: Response,
  threadId: string,
  makeEvents: (signal: AbortSignal) => AsyncGenerator<ChatEvent>,
): Promise<void> {
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("X-Thread-Id", threadId);

  const ac = new AbortController();
  let clientGone = false;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, TURN_TIMEOUT_MS);
  res.on("close", () => {
    if (!res.writableFinished) {
      clientGone = true;
      ac.abort();
    }
  });

  const write = (ev: object) => res.write(JSON.stringify(ev) + "\n");

  try {
    for await (const ev of makeEvents(ac.signal)) {
      if (process.env.CHAT_DEBUG === "1") console.log("[api] event:", ev.type);
      write(ev);
    }
    write({ type: "done" });
    res.end();
  } catch (err) {
    if (clientGone) return; // client already left — nothing to send
    const msg = timedOut
      ? "The request timed out — please try again."
      : err instanceof Error
        ? err.message
        : String(err);
    if (!res.headersSent) {
      res.status(timedOut ? 504 : 403).json({ error: msg }); // pre-stream error
    } else {
      write({ type: "error", value: msg });
      res.end();
    }
  } finally {
    clearTimeout(timer);
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
  await pipeEvents(res, threadId, (signal) =>
    streamChat(userId, threadId, message, signal),
  );
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
  await pipeEvents(res, threadId, (signal) =>
    resumeChat(userId, threadId, decision, signal),
  );
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
