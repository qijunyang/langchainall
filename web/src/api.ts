import type { Conversation } from "./types";

/** Load a user's conversations for the sidebar. */
export async function listConversations(userId: string): Promise<Conversation[]> {
  const res = await fetch(
    `/api/conversations?userId=${encodeURIComponent(userId)}`,
  );
  if (!res.ok) throw new Error("Failed to load conversations");
  return res.json();
}

/**
 * Send a message and stream the assistant's reply token by token.
 * Calls `onToken` for each chunk; resolves to the conversation's threadId
 * (newly minted by the server for a new chat).
 */
export async function streamChat(
  params: { userId: string; threadId?: string; message: string },
  onToken: (token: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
    signal,
  });

  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? "Chat request failed");
  }

  const threadId = res.headers.get("X-Thread-Id") ?? params.threadId ?? "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onToken(decoder.decode(value, { stream: true }));
  }

  return threadId;
}
