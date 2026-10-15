import type { ChatMessageDto, ToolRecordDto } from "../../shared/chat-api.js";
import { CheckIcon, ShieldIcon, WrenchIcon, XIcon } from "./icons.js";
import { Markdown } from "./Markdown.js";
import { type ChipTone, groupTools } from "./toolGroups.js";

function ChipIcon({ tone }: { tone: ChipTone }) {
  if (tone === "ok") return <CheckIcon />;
  if (tone === "error" || tone === "denied") return <XIcon />;
  return <span className="chip-spinner" aria-hidden="true" />;
}

function ToolChips({ tools }: { tools: ToolRecordDto[] }) {
  if (tools.length === 0) return null;
  return (
    <ul className="tool-chips" aria-label="Tools used">
      {groupTools(tools).map((group) => (
        <li
          key={group.key}
          data-testid="tool-chip"
          className={`tool-chip tone-${group.state.tone}`}
        >
          {group.gated ? <ShieldIcon /> : <WrenchIcon />}
          <span className="tool-name">{group.name}</span>
          {group.count > 1 ? (
            <span className="tool-count">
              ×{group.count}
              <span className="sr-only"> calls</span>
            </span>
          ) : null}
          <span className="tool-state">
            <ChipIcon tone={group.state.tone} />
            {group.state.label}
          </span>
        </li>
      ))}
    </ul>
  );
}

function StatusLine({
  message,
  text,
}: {
  message: ChatMessageDto;
  text: string;
}) {
  if (message.status === "streaming" && text === "") {
    return (
      <p className="thinking">
        <span className="dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        Thinking…
      </p>
    );
  }
  if (message.status === "failed") {
    return (
      <p className="error-text">Failed: {message.error ?? "unknown error"}</p>
    );
  }
  if (message.status === "cancelled") return <p className="muted">Stopped.</p>;
  return null;
}

export function MessageItem({
  message,
  text,
  tools,
}: {
  message: ChatMessageDto;
  text: string;
  tools: ToolRecordDto[];
}) {
  const isUser = message.role === "user";
  return (
    <article
      className={`chat-message chat-${message.role}`}
      data-testid={`message-${message.role}`}
      aria-label={isUser ? "You" : "Agent"}
    >
      {message.attachments.length > 0 ? (
        <p className="attached">
          Attached: {message.attachments.map((a) => a.filename).join(", ")}
        </p>
      ) : null}
      <ToolChips tools={tools} />
      {isUser ? <p className="pre-wrap">{text}</p> : <Markdown text={text} />}
      <StatusLine message={message} text={text} />
    </article>
  );
}
