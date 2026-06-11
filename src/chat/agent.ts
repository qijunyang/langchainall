/**
 * Shared chat agent: one stateless agent (RAG + trim middleware) over a Postgres
 * checkpointer. Used by both the CLI (05-chat.ts) and the HTTP API (server.ts).
 */
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import {
  createAgent,
  createMiddleware,
  modelRetryMiddleware,
  modelFallbackMiddleware,
  modelCallLimitMiddleware,
  humanInTheLoopMiddleware,
} from "langchain";
import {
  AIMessageChunk,
  HumanMessage,
  SystemMessage,
  trimMessages,
} from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { createModel } from "../config.js";
import { retrieveOfficeInfo } from "./rag.js";
import { DATABASE_URL, authorizeOrCreate, touchThread } from "./store.js";

// Keep only the last N messages in the PROMPT (full history still persists in
// the checkpointer) — bounds context-window/latency/cost as a thread grows.
const CHAT_MAX_MESSAGES = Number(process.env.CHAT_MAX_MESSAGES ?? 10);

// Resilience config (Phase 1 — model-level error handling).
const RETRY_MAX = Number(process.env.CHAT_RETRY_MAX ?? 2);
const FALLBACK_MODEL = process.env.CHAT_FALLBACK_MODEL ?? "qwen2.5:3b";
const MODEL_CALLS_PER_RUN = Number(process.env.CHAT_MODEL_CALL_LIMIT ?? 5);

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
    const lastHuman = [...request.messages]
      .reverse()
      .find((m) => HumanMessage.isInstance(m));
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

/** Concise view of the agent state — the main thing these hooks read/modify. */
function describeState(state: unknown): string {
  const s = state as {
    messages?: Array<{ getType?: () => string; content?: unknown }>;
  };
  const msgs = s.messages ?? [];
  const last = msgs[msgs.length - 1];
  const lastStr = last
    ? `${last.getType?.() ?? "?"}: ${JSON.stringify(last.content ?? "").slice(0, 50)}`
    : "(none)";
  return `messages=${msgs.length}, last=[${lastStr}], stateKeys=[${Object.keys(
    s as object,
  ).join(", ")}]`;
}

// Demo middleware: prints each lifecycle hook with ITS PARAMETERS so you can see
// what's available to read/modify.
//
// Every hook has the SAME signature: (state, runtime) => stateUpdate | void
//   - state   : the agent state — has `messages` (+ any custom channels). This
//               is the INPUT you read, and what you can change.
//   - runtime : context / store / config for the run (rarely modified here).
//   RETURN a Partial state update (e.g. `{ messages: [...] }`) to MODIFY state,
//   or return nothing (undefined) to leave it unchanged. (To change the model's
//   request/response specifically, use wrapModelCall instead of these.)
const LIFECYCLE_DEBUG = process.env.CHAT_DEBUG === "1";

const lifecycleLogger = createMiddleware({
  name: "LifecycleLogger",
  beforeAgent: (state, runtime) => {
    if (!LIFECYCLE_DEBUG) return undefined;
    console.log("[mw] beforeAgent IN :", describeState(state));
    console.log("[mw] beforeAgent runtimeKeys:", Object.keys(runtime ?? {}));
    return undefined; // e.g. `return { messages: [...] }` to prepend a system msg
  },
  beforeModel: (state) => {
    if (!LIFECYCLE_DEBUG) return undefined;
    console.log("[mw]   beforeModel IN :", describeState(state));
    return undefined;
  },
  afterModel: (state) => {
    if (!LIFECYCLE_DEBUG) return undefined;
    // The model's reply is now the LAST message in state — this is the OUTPUT.
    console.log("[mw]   afterModel OUT:", describeState(state));
    return undefined; // e.g. inspect/validate/redact the reply, return an update
  },
  afterAgent: (state) => {
    if (!LIFECYCLE_DEBUG) return undefined;
    console.log("[mw] afterAgent OUT:", describeState(state));
    return undefined;
  },
});

// A local tool that returns the user's ID (a random string for the demo).
// It's guarded by human-in-the-loop below, so the agent must get approval
// before it actually runs.
const getUserId = tool(
  () => `usr_${Math.random().toString(36).slice(2, 10)}`,
  {
    name: "get_user_id",
    description: "Return the current user's ID. Use when the user asks for their ID.",
    schema: z.object({}),
  },
);

// Human-in-the-loop: pause and ask for approval before running get_user_id.
const APPROVAL = "Are you sure you want to list your ID?";
const humanApproval = humanInTheLoopMiddleware({
  interruptOn: {
    get_user_id: { allowedDecisions: ["approve", "reject"], description: APPROVAL },
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
    tools: [getUserId],
    checkpointer,
    // Order matters (outer → inner). Resilience wraps the model call last:
    //   modelCallLimit guards against runaway calls; modelFallback wraps
    //   modelRetry, so each model is retried, then we fall back to a secondary.
    //   retry uses onFailure:"error" so it THROWS on exhaustion — that's what
    //   lets the fallback middleware catch it and switch models.
    // lifecycleLogger is a learning aid — its hooks only log when CHAT_DEBUG=1.
    middleware: [
      lifecycleLogger,
      ragContext,
      trimHistory,
      humanApproval,
      modelCallLimitMiddleware({ runLimit: MODEL_CALLS_PER_RUN }),
      modelFallbackMiddleware(createModel({ model: FALLBACK_MODEL })),
      modelRetryMiddleware({
        maxRetries: RETRY_MAX,
        initialDelayMs: 500,
        backoffFactor: 2,
        maxDelayMs: 4000,
        jitter: true,
        onFailure: "error",
      }),
    ],
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
    const chunk = Array.isArray(part) ? part[0] : part;
    if (AIMessageChunk.isInstance(chunk) && typeof chunk.content === "string" && chunk.content) {
      yield chunk.content;
    }
  }

  await touchThread(threadId);
}

/**
 * Non-streaming counterpart of streamChat — provided for comparison.
 *
 * Same authz / agent / middleware / checkpointer, but uses agent.invoke():
 * it runs the turn to completion and returns the FULL reply as one string,
 * instead of yielding tokens as they are produced. invoke() resolves once with
 * the whole graph state (result.messages); stream() emits chunks along the way.
 */
export async function chatOnce(
  userId: string,
  threadId: string,
  question: string,
): Promise<string> {
  await authorizeOrCreate(threadId, userId, question.slice(0, 60));
  const agent = await buildChatAgent();

  const result = await agent.invoke(
    { messages: [new HumanMessage(question)] },
    { configurable: { thread_id: threadId } },
  );
  await touchThread(threadId);

  const content = result.messages.at(-1)?.content;
  return typeof content === "string" ? content : JSON.stringify(content);
}
