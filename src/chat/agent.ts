/**
 * Shared chat agent: one stateless agent (RAG + trim middleware) over a Postgres
 * checkpointer. Used by both the CLI (05-chat.ts) and the HTTP API (server.ts).
 */
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { createAgent, createMiddleware } from "langchain";
import {
  HumanMessage,
  SystemMessage,
  isAIMessageChunk,
  isHumanMessage,
  trimMessages,
  type BaseMessageChunk,
} from "@langchain/core/messages";
import { createModel } from "../config.js";
import { retrieveOfficeInfo } from "./rag.js";
import { DATABASE_URL, authorizeOrCreate, touchThread } from "./store.js";

// Keep only the last N messages in the PROMPT (full history still persists in
// the checkpointer) — bounds context-window/latency/cost as a thread grows.
const CHAT_MAX_MESSAGES = Number(process.env.CHAT_MAX_MESSAGES ?? 10);

// Trim history right before each model call (only the request, not stored state).
const trimHistory = createMiddleware({
  name: "TrimHistory",
  wrapModelCall: async (request, handler) => {
    const trimmed = await trimMessages(request.messages, {
      strategy: "last",
      maxTokens: CHAT_MAX_MESSAGES,
      tokenCounter: (msgs) => msgs.length,
      startOn: "human",
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

// RAG: retrieve office-info chunks relevant to the latest question and inject
// them as a SystemMessage (request only — never persisted to the checkpointer).
const ragContext = createMiddleware({
  name: "OfficeRag",
  wrapModelCall: async (request, handler) => {
    const lastHuman = [...request.messages].reverse().find(isHumanMessage);
    const query =
      typeof lastHuman?.content === "string" ? lastHuman.content : "";
    if (query) {
      try {
        const chunks = await retrieveOfficeInfo(query, 3);
        if (chunks.length > 0) {
          const context = new SystemMessage(
            "You are the assistant for Acme Consulting. Answer the user's " +
              "question using ONLY the office information below. If it does not " +
              "contain the answer, say you don't have that information.\n\n" +
              chunks.join("\n\n"),
          );
          if (process.env.CHAT_DEBUG === "1") {
            console.error(`[rag] injected ${chunks.length} chunk(s) for: "${query}"`);
          }
          return handler({ ...request, messages: [context, ...request.messages] });
        }
      } catch (err) {
        console.error(
          "[rag] retrieval skipped:",
          err instanceof Error ? err.message : err,
        );
      }
    }
    return handler(request);
  },
});

// One checkpointer for the whole process (created + migrated once, then reused).
let checkpointerPromise: Promise<PostgresSaver> | null = null;
function getCheckpointer(): Promise<PostgresSaver> {
  if (!checkpointerPromise) {
    checkpointerPromise = (async () => {
      const cp = PostgresSaver.fromConnString(DATABASE_URL);
      await cp.setup();
      return cp;
    })();
  }
  return checkpointerPromise;
}

/** Build the chat agent (shared singleton-style checkpointer under the hood). */
export async function buildChatAgent() {
  const checkpointer = await getCheckpointer();
  return createAgent({
    model: createModel(),
    tools: [],
    checkpointer,
    middleware: [ragContext, trimHistory],
  });
}

/**
 * Authorize the (user, thread), run the agent, and stream the assistant's reply
 * token by token. Yields text chunks. Throws if the thread isn't the user's.
 */
export async function* streamChat(
  userId: string,
  threadId: string,
  question: string,
): AsyncGenerator<string> {
  await authorizeOrCreate(threadId, userId, question.slice(0, 60));
  const agent = await buildChatAgent();

  const stream = await agent.stream(
    { messages: [new HumanMessage(question)] },
    { configurable: { thread_id: threadId }, streamMode: "messages" },
  );

  for await (const part of stream) {
    const chunk = (Array.isArray(part) ? part[0] : part) as BaseMessageChunk;
    if (isAIMessageChunk(chunk) && typeof chunk.content === "string" && chunk.content) {
      yield chunk.content;
    }
  }

  await touchThread(threadId);
}
