import type { Conversation } from "../types";

interface Props {
  conversations: Conversation[];
  activeId: string | null;
  onSelect: (threadId: string) => void;
}

export function ConversationList({ conversations, activeId, onSelect }: Props) {
  if (conversations.length === 0) {
    return <div className="conv-empty">No conversations yet</div>;
  }
  return (
    <ul className="conv-list">
      {conversations.map((c) => (
        <li
          key={c.threadId}
          className={"conv-item" + (c.threadId === activeId ? " active" : "")}
          onClick={() => onSelect(c.threadId)}
          title={c.title}
        >
          {c.title || "(untitled)"}
        </li>
      ))}
    </ul>
  );
}
