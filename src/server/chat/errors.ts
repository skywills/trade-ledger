import { AppError } from "../../shared/errors.js";

/** Only intentional client errors may cross the chat API boundary. */
export function publicChatError(
  error: unknown,
  fallback: "SESSION_FAILED" | "TURN_FAILED" | "TOOL_FAILED",
) {
  if (error instanceof AppError && error.statusCode < 500)
    return { code: error.code, message: error.message };
  if (
    (error as { code?: unknown } | null)?.code ===
    "AGENT_SESSION_MODEL_MISMATCH"
  )
    return {
      code: "THREAD_MODEL_CHANGED",
      message:
        "The model changed since this conversation started; start a new thread.",
    };
  return {
    code: fallback,
    message:
      fallback === "SESSION_FAILED"
        ? "The chat session could not be opened. Please try again."
        : fallback === "TOOL_FAILED"
          ? "The tool could not complete. Please try again."
          : "The reply could not be completed. Please try again.",
  };
}
