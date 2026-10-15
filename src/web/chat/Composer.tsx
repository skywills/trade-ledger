import { useRef, useState } from "react";
import type { AttachmentDto } from "../../shared/chat-api.js";
import { ApiError, PreviewResponseSchema, requestMultipart } from "../api.js";

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
          {a.filename} · {a.executions} executions
          {a.quarantined > 0 ? ` · ${a.quarantined} quarantined` : ""}
          <button
            type="button"
            aria-label={`Remove ${a.filename}`}
            onClick={() => onRemove(a.previewId)}
          >
            ×
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
}: {
  disabled: boolean;
  initialText: string;
  onSend: (text: string, attachments: AttachmentDto[]) => Promise<void>;
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
      <div className="composer-row">
        <button
          type="button"
          className="secondary"
          data-testid="composer-attach"
          disabled={uploading || disabled}
          onClick={() => fileInput.current?.click()}
        >
          Attach CSV
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
        <textarea
          data-testid="composer-input"
          aria-label="Message"
          value={text}
          maxLength={8000}
          rows={2}
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
        <button
          type="submit"
          data-testid="composer-send"
          disabled={disabled || uploading || sending || text.trim() === ""}
        >
          Send
        </button>
      </div>
    </form>
  );
}
