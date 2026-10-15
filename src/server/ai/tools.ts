/** Built-in tool names a profile-`none` session must never be offered. */
export const FORBIDDEN_TOOL_NAMES = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Delete",
  "Glob",
  "Grep",
  "Git",
  "GitCommit",
  "RunCommand",
  "Exec",
] as const;

/** The only non-embedder tools a profile-`none` session is expected to offer. */
export const PROFILE_NONE_BUILTIN_TOOLS = [
  "ScratchpadWrite",
  "ScratchpadRead",
  "ScratchpadList",
  "ask_human",
] as const;

export const MAX_PROPOSALS_PER_RUN = 20;
