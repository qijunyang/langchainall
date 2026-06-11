/**
 * HTTP API for the chat UI. Wraps the shared chat agent (src/chat/agent.ts).
 *
 *   GET  /api/conversations?userId=...      -> list the user's chats (sidebar)
 *   POST /api/chat  { userId, threadId?, message }
 *        -> streams the assistant reply as plain-text tokens.
 *           For a new chat (no threadId) the server mints one and returns it in
 *           the `X-Thread-Id` response header.
 *
 * Start: npm run api   (defaults to http://localhost:3100)
 */
import { randomUUID } from "node:crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import { streamChat } from "./chat/agent.js";
import { ensureSchema, listThreads } from "./chat/store.js";

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

// Stream a chat turn. Tokens are written to the response as they arrive.
app.post("/api/chat", async (req: Request, res: Response) => {
  const userId = String(req.body?.userId ?? "").trim();
  const message = String(req.body?.message ?? "").trim();
  const threadId = String(req.body?.threadId ?? "").trim() || randomUUID();

  if (!userId || !message) {
    res.status(400).json({ error: "userId and message are required" });
    return;
  }

  // Tell the client which thread this is (esp. for a newly minted one).
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("X-Thread-Id", threadId);

  // Stop streaming if the client disconnects (e.g. the Cancel button). Use the
  // RESPONSE 'close' (fires on client disconnect) — not req 'close', which fires
  // as soon as the request body is read and would abort us immediately.
  let aborted = false;
  res.on("close", () => {
    if (!res.writableFinished) aborted = true;
  });

  try {
    for await (const token of streamChat(userId, threadId, message)) {
      if (aborted) break;
      res.write(token);
    }
    res.end();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Authorization / validation errors happen before any token is written.
    if (!res.headersSent) {
      res.status(403).json({ error: msg });
    } else {
      res.end();
    }
  }
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
