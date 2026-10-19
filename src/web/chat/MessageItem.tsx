import { useEffect, useState } from "react";
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

function StatusLine({ message }: { message: ChatMessageDto }) {
  if (message.status === "failed") {
    return (
      <p className="error-text">Failed: {message.error ?? "unknown error"}</p>
    );
  }
  if (message.status === "cancelled") return <p className="muted">Stopped.</p>;
  return null;
}

function ThinkingBlock({
  message,
  thinking,
  text,
  tools,
}: {
  message: ChatMessageDto;
  thinking: string;
  text: string;
  tools: ToolRecordDto[];
}) {
  const running = message.status === "streaming";
  const [expanded, setExpanded] = useState(running);
  useEffect(() => {
    if (!running) setExpanded(false);
  }, [running]);
  if (!running && thinking === "" && tools.length === 0) return null;
  const label = running
    ? text !== ""
      ? "Writing reply…"
      : tools.some((t) => t.status === "running")
        ? "Using tools…"
        : "Thinking…"
    : message.status === "complete"
      ? "Complete"
      : message.status === "cancelled"
        ? "Stopped"
        : "Failed";
  return (
    <details
      className="thinking-block"
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        <span>Thinking</span>
        <span className="thinking-state">
          {running ? (
            <span className="chip-spinner" aria-hidden="true" />
          ) : null}
          {label}
        </span>
      </summary>
      <div className="thinking-content">
        {thinking !== "" ? (
          <div className="thinking-text">
            <Markdown text={thinking} />
          </div>
        ) : (
          <p className="muted">
            {running
              ? "Waiting for thinking or response text from the model."
              : "No thinking text was provided by the model."}
          </p>
        )}
        <ToolChips tools={tools} />
        {tools
          .filter((tool) => tool.isError && tool.error)
          .map((tool) => (
            <details key={tool.callId} className="error-text">
              <summary>{tool.name}: error details</summary>
              <p className="pre-wrap">{tool.error}</p>
            </details>
          ))}
      </div>
    </details>
  );
}

export function MessageItem({
  message,
  text,
  tools,
  thinking = message.thinking,
}: {
  message: ChatMessageDto;
  text: string;
  tools: ToolRecordDto[];
  thinking?: string;
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
      {!isUser ? (
        <ThinkingBlock
          message={message}
          thinking={thinking}
          text={text}
          tools={tools}
        />
      ) : null}
      {isUser ? <p className="pre-wrap">{text}</p> : <Markdown text={text} />}
      <StatusLine message={message} />
    </article>
  );
}
