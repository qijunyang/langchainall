import type { Conversation } from "./types";

/** Load a user's conversations for the sidebar. */
export async function listConversations(userId: string): Promise<Conversation[]> {
  const res = await fetch(
    `/api/conversations?userId=${encodeURIComponent(userId)}`,
  );
  if (!res.ok) throw new Error("Failed to load conversations");
  return res.json();
}

export interface Interrupt {
  id: string;
  message: string;
}

export interface StreamCallbacks {
  onToken: (token: string) => void;
  onInterrupt?: (interrupt: Interrupt) => void;
}

export interface StreamResult {
  threadId: string;
  interrupted: boolean;
}

/** Read an NDJSON event stream, dispatching tokens/interrupts to callbacks. */
async function readEventStream(
  res: Response,
  cb: StreamCallbacks,
): Promise<boolean> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let interrupted = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const ev = JSON.parse(line) as
        | { type: "token"; value: string }
        | { type: "interrupt"; value: Interrupt }
        | { type: "done" }
        | { type: "error"; value: string };
      if (ev.type === "token") cb.onToken(ev.value);
      else if (ev.type === "interrupt") {
        interrupted = true;
        cb.onInterrupt?.(ev.value);
      } else if (ev.type === "error") throw new Error(ev.value);
    }
  }
  return interrupted;
}

async function postStream(
  url: string,
  body: unknown,
  cb: StreamCallbacks,
  fallbackThreadId: string,
  signal?: AbortSignal,
): Promise<StreamResult> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? "Request failed");
  }
  const threadId = res.headers.get("X-Thread-Id") ?? fallbackThreadId;
  const interrupted = await readEventStream(res, cb);
  return { threadId, interrupted };
}

/** Send a message; stream the reply. May end in an interrupt (approval). */
export async function streamChat(
  params: { userId: string; threadId?: string; message: string },
  cb: StreamCallbacks,
  signal?: AbortSignal,
): Promise<StreamResult> {
  return postStream("/api/chat", params, cb, params.threadId ?? "", signal);
}

/** Resume an interrupted run with the user's decision. */
export async function resumeChat(
  params: { userId: string; threadId: string; decision: "approve" | "reject" },
  cb: StreamCallbacks,
  signal?: AbortSignal,
): Promise<StreamResult> {
  return postStream("/api/chat/resume", params, cb, params.threadId, signal);
}
