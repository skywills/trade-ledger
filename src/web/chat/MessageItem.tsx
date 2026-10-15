import type { ChatMessageDto, ToolRecordDto } from "../../shared/chat-api.js";

/** Plain-text rendering with paragraph and code-fence support. No HTML injection. */
function Body({ text }: { text: string }) {
  const parts = text.split(/```/);
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional split of immutable text
          <pre key={index}>
            <code>{part.replace(/^\w*\n/, "")}</code>
          </pre>
        ) : (
          part
            .split(/\n{2,}/)
            .filter((p) => p.trim() !== "")
            .map((p, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: positional split of immutable text
              <p key={`${index}-${i}`} className="pre-wrap">
                {p}
              </p>
            ))
        ),
      )}
    </>
  );
}

function ToolChips({ tools }: { tools: ToolRecordDto[] }) {
  if (tools.length === 0) return null;
  return (
    <ul className="tool-chips">
      {tools.map((tool) => (
        <li
          key={tool.callId}
          data-testid="tool-chip"
          className={tool.isError ? "tool-chip error" : "tool-chip"}
        >
          {tool.name} · {tool.approval ?? tool.status}
        </li>
      ))}
    </ul>
  );
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
  return (
    <article
      className={`chat-message chat-${message.role}`}
      data-testid={`message-${message.role}`}
    >
      {message.attachments.length > 0 ? (
        <p className="muted">
          Attached: {message.attachments.map((a) => a.filename).join(", ")}
        </p>
      ) : null}
      <ToolChips tools={tools} />
      <Body text={text} />
      {message.status === "streaming" && text === "" ? (
        <p className="muted">Thinking…</p>
      ) : null}
      {message.status === "failed" ? (
        <p className="error-text">Failed: {message.error ?? "unknown error"}</p>
      ) : null}
      {message.status === "cancelled" ? (
        <p className="muted">Stopped.</p>
      ) : null}
    </article>
  );
}
