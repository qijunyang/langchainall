import { useState } from "react";

interface Props {
  streaming: boolean;
  disabled: boolean;
  onSend: (text: string) => void;
  onCancel: () => void;
}

export function MessageInput({ streaming, disabled, onSend, onCancel }: Props) {
  const [text, setText] = useState("");

  function submit() {
    const t = text.trim();
    if (!t || streaming) return;
    onSend(t);
    setText("");
  }

  return (
    <div className="input-bar">
      <div className="input-inner">
        <textarea
          value={text}
          disabled={disabled}
          placeholder="Type your question…  (Enter to send, Shift+Enter for newline)"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {streaming ? (
          <button className="btn cancel" onClick={onCancel}>
            Cancel
          </button>
        ) : (
          <button
            className="btn send"
            onClick={submit}
            disabled={disabled || !text.trim()}
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}
