import { useEffect, useRef } from "react";
import type { ChatMessage } from "../types";

interface Props {
  messages: ChatMessage[];
  streaming: boolean;
  pendingApproval?: boolean;
  onApprove?: () => void;
  onReject?: () => void;
}

export function MessageList({
  messages,
  streaming,
  pendingApproval,
  onApprove,
  onReject,
}: Props) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, pendingApproval]);

  if (messages.length === 0) {
    return (
      <div className="messages empty-state">
        Ask me about Acme Consulting's office — hours, holidays, remote policy…
      </div>
    );
  }

  return (
    <div className="messages">
      {messages.map((m, i) => {
        const isLast = i === messages.length - 1;
        const text = m.content || (streaming && isLast ? "…" : "");
        return (
          <div key={i} className={"bubble-row " + m.role}>
            <div className={"bubble " + m.role}>{text}</div>
          </div>
        );
      })}

      {/* Yes/No follow the agent's interrupt question, inline in the thread. */}
      {pendingApproval && (
        <div className="bubble-row assistant">
          <div className="approval-actions">
            <button className="btn send" onClick={onApprove}>
              Yes
            </button>
            <button className="btn cancel" onClick={onReject}>
              No
            </button>
          </div>
        </div>
      )}

      <div ref={endRef} />
    </div>
  );
}
