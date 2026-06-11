/**
 * Chat metadata store — "your app DB" (separate from the LangGraph checkpointer).
 *
 * The checkpointer owns the per-thread MESSAGE HISTORY. This store owns the
 * OWNERSHIP + METADATA: which user a thread belongs to, its title, timestamps.
 * It powers authorization ("can this user open this thread?") and listing
 * ("show me my chats") — things LangGraph doesn't know about (it only knows
 * thread_id).
 *
 * Both live in the same Postgres instance, but in different tables.
 */
import { Pool } from "pg";

export const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://langchain:langchain@localhost:5544/langchain";

// One shared pool for the whole process (created once — a heavy resource).
// Exported so the RAG module (rag.ts) reuses the same pool.
export const pool = new Pool({ connectionString: DATABASE_URL });

export interface ChatThread {
  threadId: string;
  userId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

/** Create our metadata table if it doesn't exist (idempotent). */
export async function ensureSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_threads (
      thread_id  TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      title      TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS chat_threads_user_id_idx ON chat_threads (user_id);
  `);
}

function rowToThread(r: {
  thread_id: string;
  user_id: string;
  title: string;
  created_at: Date;
  updated_at: Date;
}): ChatThread {
  return {
    threadId: r.thread_id,
    userId: r.user_id,
    title: r.title,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export async function getThread(threadId: string): Promise<ChatThread | null> {
  const { rows } = await pool.query(
    "SELECT * FROM chat_threads WHERE thread_id = $1",
    [threadId],
  );
  return rows[0] ? rowToThread(rows[0]) : null;
}

export async function createThread(
  threadId: string,
  userId: string,
  title: string,
): Promise<ChatThread> {
  const { rows } = await pool.query(
    `INSERT INTO chat_threads (thread_id, user_id, title)
     VALUES ($1, $2, $3) RETURNING *`,
    [threadId, userId, title],
  );
  return rowToThread(rows[0]);
}

/** Bump updated_at so "most recent chat" ordering works. */
export async function touchThread(threadId: string): Promise<void> {
  await pool.query(
    "UPDATE chat_threads SET updated_at = now() WHERE thread_id = $1",
    [threadId],
  );
}

export async function listThreads(userId: string): Promise<ChatThread[]> {
  const { rows } = await pool.query(
    "SELECT * FROM chat_threads WHERE user_id = $1 ORDER BY updated_at DESC",
    [userId],
  );
  return rows.map(rowToThread);
}

/**
 * Ensure (userId, threadId) is valid, creating the thread on first use.
 * Throws if the thread exists but belongs to a different user (authorization).
 */
export async function authorizeOrCreate(
  threadId: string,
  userId: string,
  title: string,
): Promise<ChatThread> {
  const existing = await getThread(threadId);
  if (!existing) return createThread(threadId, userId, title);
  if (existing.userId !== userId) {
    throw new Error(
      `Thread "${threadId}" belongs to user "${existing.userId}", not "${userId}".`,
    );
  }
  return existing;
}

export async function closeStore(): Promise<void> {
  await pool.end();
}
