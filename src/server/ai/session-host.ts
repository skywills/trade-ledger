import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type AgentSession,
  type CreateAgentSessionOptions,
  createAgentSession,
  createFileTranscriptStore,
  type EmbedderTool,
  nativeBackend,
  resumeAgentSession,
  type SessionEvent,
} from "@nathapp/nax-agent";
import type { Id } from "../../shared/domain.js";
import { AppError } from "../../shared/errors.js";
import type { Store } from "../storage/database.js";
import { wireProviderId } from "./catalog.js";
import type { SecretResolver } from "./credentials.js";
import {
  defaultProfileId,
  type LlmProfileSnapshot,
  readCompatibility,
  snapshotProfile,
} from "./profiles.js";
import type { RunUsage } from "./runs.js";
import { openModelConnection } from "./transport.js";

/**
 * Shared hosting for nax-agent sessions: profile gating, the guarded loopback
 * gateway, create-or-resume over a file transcript store, and usage limits.
 */
export interface TurnLimits {
  readonly maxOutputTokens: number;
  readonly maxModelRounds: number;
  readonly maxTotalGeneratedTokens: number;
}

export const DEFAULT_TURN_LIMITS: TurnLimits = {
  maxOutputTokens: 4096,
  maxModelRounds: 200,
  maxTotalGeneratedTokens: 100_000,
};

export function resolveProfile(
  store: Store,
  profileId: Id | null,
  options: { cloudConfirmed: boolean },
): LlmProfileSnapshot {
  const id = profileId ?? defaultProfileId(store);
  if (id === null || id === "") {
    throw new AppError("NO_PROFILE", "No model profile is selected.", 409);
  }
  const profile = snapshotProfile(store, id);
  if (!profile.enabled) {
    throw new AppError(
      "PROFILE_DISABLED",
      "A disabled profile cannot run the agent.",
      409,
    );
  }
  if (readCompatibility(store, id).status !== "verified") {
    throw new AppError(
      "PROFILE_NOT_VERIFIED",
      "The profile has no current verified compatibility check; run its test first.",
      409,
    );
  }
  if (profile.mode === "cloud" && !options.cloudConfirmed) {
    throw new AppError(
      "CLOUD_CONFIRMATION_REQUIRED",
      "Sending trade data to a cloud profile requires explicit confirmation.",
      409,
    );
  }
  return profile;
}

/** The nax-agent model string a session for this profile is pinned to. */
export function modelRefFor(profile: LlmProfileSnapshot): string {
  return `${wireProviderId(profile)}/${profile.modelId}`;
}

export interface HostedSessionOptions {
  readonly store: Store;
  readonly profile: LlmProfileSnapshot;
  readonly secrets: SecretResolver;
  readonly sessionId: string;
  readonly instructions: string;
  readonly tools: readonly EmbedderTool[];
  readonly transcriptsSubdir: string;
  readonly turnTimeoutSeconds: number;
  readonly approvalTimeoutMs?: number;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface HostedSession {
  readonly session: AgentSession;
  close(): Promise<void>;
}

function errorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

/** Opens (or resumes, when a transcript exists) a profile-`none` session. */
export async function openHostedSession(
  options: HostedSessionOptions,
): Promise<HostedSession> {
  const connection = await openModelConnection(
    options.profile,
    options.secrets,
  );
  try {
    const dir = join(
      options.store.dataDir,
      "transcripts",
      options.transcriptsSubdir,
    );
    await mkdir(dir, { recursive: true });
    const sessionOptions: CreateAgentSessionOptions = {
      backend: nativeBackend(connection.backendOptions),
      sessionId: options.sessionId,
      profile: "none",
      instructions: options.instructions,
      tools: options.tools,
      transcriptStore: createFileTranscriptStore(dir),
      turnTimeoutSeconds: options.turnTimeoutSeconds,
      ...(options.approvalTimeoutMs === undefined
        ? {}
        : { approvalTimeoutMs: options.approvalTimeoutMs }),
      metadata: options.metadata ?? {},
    };
    let session: AgentSession;
    try {
      session = await resumeAgentSession(options.sessionId, sessionOptions);
    } catch (error) {
      if (errorCode(error) !== "AGENT_SESSION_NOT_FOUND") throw error;
      session = await createAgentSession(sessionOptions);
    }
    return {
      session,
      async close() {
        await session.close().catch(() => undefined);
        await connection.close().catch(() => undefined);
      },
    };
  } catch (error) {
    await connection.close().catch(() => undefined);
    throw error;
  }
}

function emptyUsage(): RunUsage {
  return {
    rounds: 0,
    inputTokens: 0,
    outputTokens: 0,
    generatedTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

/** Folds `usage`/`turn_end` events; `observe` returns a limit reason or null. */
export class UsageMeter {
  private totals: RunUsage = emptyUsage();
  private cost = 0;
  private source: string | null = null;

  constructor(private readonly limits: TurnLimits) {}

  get usage(): RunUsage {
    return this.totals;
  }
  get costUsd(): number {
    return this.cost;
  }
  get costSource(): string | null {
    return this.source;
  }

  observe(event: SessionEvent): string | null {
    if (event.type === "usage") {
      this.totals = {
        rounds: Math.max(this.totals.rounds, event.round),
        inputTokens: this.totals.inputTokens + event.inputTokens,
        outputTokens: this.totals.outputTokens + event.outputTokens,
        generatedTokens: this.totals.generatedTokens + event.outputTokens,
        cacheReadTokens: this.totals.cacheReadTokens + (event.cacheRead ?? 0),
        cacheWriteTokens:
          this.totals.cacheWriteTokens + (event.cacheWrite ?? 0),
      };
      this.source = event.costSource ?? "computed";
      if (event.costSource !== "unpriced") this.cost += event.costUsd;
      if (event.round > this.limits.maxModelRounds) return "limit:max_rounds";
      if (event.outputTokens > this.limits.maxOutputTokens)
        return "limit:max_output_tokens";
      if (this.totals.generatedTokens > this.limits.maxTotalGeneratedTokens) {
        return "limit:max_generated_tokens";
      }
      return null;
    }
    if (event.type === "turn_end") {
      const end = event.usage as {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
      };
      this.totals = {
        rounds: this.totals.rounds,
        inputTokens: end.inputTokens,
        outputTokens: end.outputTokens,
        generatedTokens: end.outputTokens,
        cacheReadTokens: end.cacheReadTokens ?? 0,
        cacheWriteTokens: end.cacheWriteTokens ?? 0,
      };
      this.source = event.costSource ?? "computed";
      this.cost = event.costSource === "unpriced" ? 0 : event.costUsd;
    }
    return null;
  }
}
