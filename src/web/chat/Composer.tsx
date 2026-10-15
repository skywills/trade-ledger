import { type ReactNode, useRef, useState } from "react";
import type { AttachmentDto } from "../../shared/chat-api.js";
import { ApiError, PreviewResponseSchema, requestMultipart } from "../api.js";
import { PaperclipIcon, SendIcon, XIcon } from "./icons.js";

interface Staged extends AttachmentDto {
  executions: number;
  quarantined: number;
}

async function previewCsvs(csvs: File[]): Promise<Staged[]> {
  const form = new FormData();
  for (const file of csvs) form.append("file", file, file.name);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const result = await requestMultipart(
    `/api/imports/preview?timezone=${encodeURIComponent(timezone)}`,
    PreviewResponseSchema,
    form,
  );
  return result.previews.map((p, i) => ({
    previewId: p.id,
    filename: csvs[i]?.name ?? p.id,
    executions: p.counts.executions,
    quarantined: p.counts.quarantined,
  }));
}

function AttachmentChips({
  staged,
  onRemove,
}: {
  staged: Staged[];
  onRemove: (previewId: string) => void;
}) {
  if (staged.length === 0) return null;
  return (
    <ul className="attachment-chips">
      {staged.map((a) => (
        <li key={a.previewId} data-testid="attachment-chip">
          <span>
            {a.filename} · {a.executions} executions
            {a.quarantined > 0 ? ` · ${a.quarantined} quarantined` : ""}
          </span>
          <button
            type="button"
            className="chip-remove"
            aria-label={`Remove ${a.filename}`}
            onClick={() => onRemove(a.previewId)}
          >
            <XIcon />
          </button>
        </li>
      ))}
    </ul>
  );
}

export function Composer({
  disabled,
  initialText,
  onSend,
  placeholder = "Ask about your trades, P&L or imports…",
  autoFocus = false,
  footer,
}: {
  disabled: boolean;
  initialText: string;
  onSend: (text: string, attachments: AttachmentDto[]) => Promise<void>;
  placeholder?: string;
  autoFocus?: boolean;
  footer?: ReactNode;
}) {
  const [text, setText] = useState(initialText);
  const [staged, setStaged] = useState<Staged[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);

  async function upload(files: FileList | null) {
    const csvs = Array.from(files ?? []).filter((f) =>
      f.name.toLowerCase().endsWith(".csv"),
    );
    if (csvs.length === 0 || disabled || uploading) return;
    setUploading(true);
    setError(null);
    try {
      const added = await previewCsvs(csvs);
      setStaged((s) => [...s, ...added].slice(0, 20));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  async function submit() {
    const trimmed = text.trim();
    if (trimmed === "" || disabled || uploading || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    try {
      await onSend(
        trimmed,
        staged.map(({ previewId, filename }) => ({ previewId, filename })),
      );
      setText("");
      setStaged([]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Send failed.");
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        void upload(e.dataTransfer.files);
      }}
    >
      <AttachmentChips
        staged={staged}
        onRemove={(id) => setStaged((s) => s.filter((x) => x.previewId !== id))}
      />
      {error !== null ? (
        <p className="error-text" role="alert">
          {error}
        </p>
      ) : null}
      <div className="composer-box">
        <textarea
          data-testid="composer-input"
          aria-label="Message"
          placeholder={placeholder}
          value={text}
          maxLength={8000}
          rows={1}
          // biome-ignore lint/a11y/noAutofocus: the agent home's single purpose is this input
          autoFocus={autoFocus}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <div className="composer-actions">
          <button
            type="button"
            className="icon-button"
            data-testid="composer-attach"
            aria-label="Attach CSV"
            title="Attach IBKR Flex CSV"
            disabled={uploading || disabled}
            onClick={() => fileInput.current?.click()}
          >
            <PaperclipIcon />
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".csv,text/csv"
            multiple
            hidden
            aria-label="CSV files"
            onChange={(e) => void upload(e.target.files)}
          />
          <span className="composer-hint">
            {uploading
              ? "Uploading…"
              : "Enter to send · Shift+Enter for a new line"}
          </span>
          <button
            type="submit"
            className="send-button"
            data-testid="composer-send"
            disabled={disabled || uploading || sending || text.trim() === ""}
          >
            <SendIcon />
            Send
          </button>
        </div>
      </div>
      {footer}
    </form>
  );
}
