import { ProtocolStreamError, type ToolDefinition } from "@nathapp/nax-ai";
import type { Id } from "../../shared/domain.js";
import type { Store } from "../storage/database.js";
import { buildCompatibilityClient, wireProviderId } from "./catalog.js";
import {
  createDefaultSecretResolver,
  type SecretResolver,
} from "./credentials.js";
import {
  type CompatibilityStatus,
  recordProfileCheck,
  snapshotProfile,
} from "./profiles.js";
import { openModelConnection } from "./transport.js";

/**
 * A compatibility probe against a profile's guarded endpoint.
 *
 * The probe sends only a fixed synthetic tool-call instruction — never journal
 * bytes — and inspects the roundtrip: a tool call proves the endpoint accepts
 * tools; a text answer, an unreachable host, a timeout, malformed arguments
 * and a missing tool call are each reported distinctly. A profile that skips
 * or fails is never represented as verified.
 */
export interface CompatibilityResult {
  status: Extract<CompatibilityStatus, "verified" | "failed" | "skipped">;
  reason: string | null;
  profileId: Id;
  profileRevision: number;
  endpoint: string;
  modelId: string;
  checkedAt: string;
  durationMs: number;
}

const PROBE_TOOL: ToolDefinition = {
  name: "journal_probe",
  description:
    "Report the probe value back to the caller. This is a connectivity check.",
  inputSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
};

/** Probe output cap; leaves room for a reasoning model to think before calling. */
const PROBE_MAX_TOKENS = 32_000;

const PROBE_PROMPT =
  'Call the journal_probe tool exactly once with {"value":"ok"}. Do not answer with text.';

function classify(
  error: unknown,
  connectionFailure: string | null,
  aborted: boolean,
): string {
  if (aborted) return "TIMEOUT";
  switch (connectionFailure) {
    case "timeout":
      return "TIMEOUT";
    case "upstream_unreachable":
      return "UNREACHABLE";
    case "credential_missing":
      return "CREDENTIAL_MISSING";
    case "credential_unavailable":
      return "CREDENTIAL_UNAVAILABLE";
    case "cross_origin_redirect":
    case "redirect_rejected":
      return "REDIRECT_REJECTED";
    case "response_too_large":
      return "RESPONSE_TOO_LARGE";
    default:
      break;
  }
  if (error instanceof ProtocolStreamError) {
    if (/unparseable arguments/i.test(error.message)) {
      return "MALFORMED_ARGUMENTS";
    }
    return "PROTOCOL_ERROR";
  }
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      return "TIMEOUT";
    }
  }
  return "UNREACHABLE";
}

/** Whether a tool call is a well-formed answer to the synthetic probe. */
function probeSucceeded(
  toolCalls: readonly { name: string; input: unknown }[] | undefined,
): "verified" | "NO_TOOL_CALL" | "TOOL_MISMATCH" | "MALFORMED_ARGUMENTS" {
  if (toolCalls === undefined || toolCalls.length === 0) return "NO_TOOL_CALL";
  const call = toolCalls[0];
  if (call === undefined || call.name !== PROBE_TOOL.name) {
    return "TOOL_MISMATCH";
  }
  if (call.input === null || typeof call.input !== "object") {
    return "MALFORMED_ARGUMENTS";
  }
  return "verified";
}

export async function testProfile(
  store: Store,
  id: Id,
  signal: AbortSignal,
  secrets: SecretResolver = createDefaultSecretResolver(),
): Promise<CompatibilityResult> {
  const startedAt = Date.now();
  const profile = snapshotProfile(store, id);
  const common = {
    profileId: profile.id,
    profileRevision: profile.revision,
    endpoint: profile.endpoint,
    modelId: profile.modelId,
  };

  const finish = async (
    status: CompatibilityResult["status"],
    reason: string | null,
  ): Promise<CompatibilityResult> => {
    const result: CompatibilityResult = {
      ...common,
      status,
      reason,
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
    };
    await recordProfileCheck(store, {
      ...common,
      status,
      reason,
      checkedAt: result.checkedAt,
      durationMs: result.durationMs,
    });
    return result;
  };

  // A profile that declares no tool support cannot pass a tool roundtrip; it is
  // reported as a skipped check with an explicit reason, never as verified.
  if (!profile.supportsTools) {
    return finish("skipped", "TOOLS_UNSUPPORTED");
  }

  const connection = await openModelConnection(profile, secrets);
  try {
    const client = buildCompatibilityClient(
      profile,
      connection.baseUrl,
      connection.token,
    );
    const model = await client.model(wireProviderId(profile), profile.modelId);
    const completed = await client.complete(model, {
      messages: [{ role: "user", content: PROBE_PROMPT }],
      tools: [PROBE_TOOL],
      maxTokens: Math.min(profile.maxTokens, PROBE_MAX_TOKENS),
      signal,
    });
    const verdict = probeSucceeded(completed.toolCalls);
    if (verdict === "verified") return finish("verified", null);
    return finish("failed", verdict);
  } catch (error) {
    return finish(
      "failed",
      classify(error, connection.failure(), signal.aborted),
    );
  } finally {
    await connection.close();
  }
}
