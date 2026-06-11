import { useRef, useState } from "react";
import type { ChatMessage, Conversation } from "./types";
import { listConversations, streamChat, resumeChat } from "./api";
import { ConversationList } from "./components/ConversationList";
import { MessageList } from "./components/MessageList";
import { MessageInput } from "./components/MessageInput";

export function App() {
  const [userIdInput, setUserIdInput] = useState("u1");
  const [userId, setUserId] = useState("");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [pendingApproval, setPendingApproval] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  async function refreshConversations(uid: string) {
    try {
      setConversations(await listConversations(uid));
    } catch {
      setConversations([]);
    }
  }

  function resetView() {
    setThreadId(null);
    setMessages([]);
    setPendingApproval(false);
  }

  function login() {
    const uid = userIdInput.trim();
    if (!uid) return;
    setUserId(uid);
    resetView();
    void refreshConversations(uid);
  }

  function selectConversation(id: string) {
    // History loading is intentionally skipped for now (will come from a
    // messages table later); selecting just sets the active thread.
    setThreadId(id);
    setMessages([]);
    setPendingApproval(false);
  }

  // Append a streamed token to the last (assistant) message.
  const appendToken = (token: string) =>
    setMessages((m) => {
      const copy = m.slice();
      const last = copy[copy.length - 1];
      copy[copy.length - 1] = { role: "assistant", content: last.content + token };
      return copy;
    });

  async function send(text: string) {
    if (!userId || streaming || pendingApproval) return;

    setMessages((m) => [
      ...m,
      { role: "user", content: text },
      { role: "assistant", content: "" },
    ]);
    setStreaming(true);

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const { threadId: newThreadId } = await streamChat(
        { userId, threadId: threadId ?? undefined, message: text },
        {
          onToken: appendToken,
          onInterrupt: (interrupt) => {
            // The agent paused for approval — show the question and Yes/No.
            setMessages((m) => {
              const copy = m.slice();
              const last = copy[copy.length - 1];
              copy[copy.length - 1] = {
                role: "assistant",
                content: last.content
                  ? `${last.content}\n\n${interrupt.message}`
                  : interrupt.message,
              };
              return copy;
            });
            setPendingApproval(true);
          },
        },
        ac.signal,
      );
      setThreadId(newThreadId);
      void refreshConversations(userId);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        const msg = (err as Error).message;
        setMessages((m) => {
          const copy = m.slice();
          copy[copy.length - 1] = { role: "assistant", content: `⚠️ ${msg}` };
          return copy;
        });
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  // Resume an interrupted run with the user's decision.
  async function resolve(decision: "approve" | "reject") {
    if (!threadId || streaming) return;
    setPendingApproval(false);
    setMessages((m) => [...m, { role: "assistant", content: "" }]);
    setStreaming(true);

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      await resumeChat(
        { userId, threadId, decision },
        { onToken: appendToken },
        ac.signal,
      );
      void refreshConversations(userId);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        const msg = (err as Error).message;
        setMessages((m) => {
          const copy = m.slice();
          copy[copy.length - 1] = { role: "assistant", content: `⚠️ ${msg}` };
          return copy;
        });
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  function cancel() {
    abortRef.current?.abort();
    setStreaming(false);
  }

  if (!userId) {
    return (
      <div className="login">
        <h1>Acme Consulting Chat</h1>
        <p>Enter your user id (pretend you just logged in):</p>
        <div className="login-row">
          <input
            value={userIdInput}
            onChange={(e) => setUserIdInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && login()}
            placeholder="user id"
          />
          <button className="btn send" onClick={login}>
            Continue
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <button className="new-btn" onClick={newConversationGuarded}>
          + New conversation
        </button>
        <ConversationList
          conversations={conversations}
          activeId={threadId}
          onSelect={selectConversation}
        />
        <div className="user-tag">
          user: <b>{userId}</b>
          <button className="link" onClick={() => setUserId("")}>
            switch
          </button>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          {threadId ? `Conversation ${threadId.slice(0, 8)}…` : "New conversation"}
        </header>
        <MessageList messages={messages} streaming={streaming} />
        {pendingApproval && (
          <div className="approval-bar">
            <span>Approve listing your ID?</span>
            <button className="btn send" onClick={() => resolve("approve")}>
              Yes
            </button>
            <button className="btn cancel" onClick={() => resolve("reject")}>
              No
            </button>
          </div>
        )}
        <MessageInput
          streaming={streaming}
          disabled={pendingApproval}
          onSend={send}
          onCancel={cancel}
        />
      </main>
    </div>
  );

  function newConversationGuarded() {
    if (streaming) return;
    resetView();
  }
}
