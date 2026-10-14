import { randomUUID } from "node:crypto";
import type { Id } from "../../shared/domain.js";
import { AppError } from "../../shared/errors.js";
import { type Store, write } from "../storage/database.js";
import { isValidCredentialRef } from "./credentials.js";

/**
 * Local/cloud model profiles. A profile row is retained and revisioned: edits
 * bump `revision` in place, so a pointer or a compatibility check can name the
 * exact revision it observed. Nothing deletes rows; `enabled` toggles instead.
 */
export type ProfileMode = "local" | "cloud";

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface ProfilePricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ProfileInput {
  /** Present only when updating an existing profile. */
  id?: Id | undefined;
  name: string;
  mode: ProfileMode;
  provider: string;
  protocol: string;
  endpoint: string;
  modelId: string;
  contextWindow: number;
  maxTokens: number;
  timeoutSeconds: number;
  supportsTools: boolean;
  thinkingLevels: ThinkingLevel[];
  credentialRef: string | null;
  enabled?: boolean | undefined;
  /** Explicit per-profile rates; absent keeps usage unpriced. */
  pricing?: ProfilePricing | null | undefined;
}

export interface LlmProfile {
  id: Id;
  name: string;
  mode: ProfileMode;
  provider: string;
  protocol: string;
  endpoint: string;
  modelId: string;
  contextWindow: number;
  maxTokens: number;
  timeoutSeconds: number;
  supportsTools: boolean;
  thinkingLevels: ThinkingLevel[];
  credentialRef: string | null;
  enabled: boolean;
  revision: number;
  pricing: ProfilePricing | null;
}

export type LlmProfileSnapshot = LlmProfile;

export type CompatibilityStatus =
  | "verified"
  | "failed"
  | "skipped"
  | "unchecked";

export interface ProfileCompatibility {
  status: CompatibilityStatus;
  reason: string | null;
  profileRevision: number | null;
  checkedAt: string | null;
  endpoint: string | null;
  modelId: string | null;
  durationMs: number | null;
}

export interface ProfileCheckInput {
  profileId: Id;
  profileRevision: number;
  status: "verified" | "failed" | "skipped";
  reason: string | null;
  endpoint: string;
  modelId: string;
  checkedAt: string;
  durationMs: number;
}

interface ProfileRow {
  id: string;
  name: string;
  mode: string;
  provider_adapter: string;
  protocol: string;
  base_url: string | null;
  model_id: string;
  context_limit: number | null;
  output_limit: number | null;
  capabilities_json: string;
  credential_reference: string | null;
  timeout_ms: number;
  revision: number;
  enabled: number;
}

function invalid(message: string): AppError {
  return new AppError("INVALID_INPUT", message, 400);
}

function requirePositiveInt(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw invalid(`${name} must be a positive integer.`);
  }
  return value;
}

function readEndpoint(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalid("endpoint is required.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid("endpoint must be a valid absolute URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw invalid("endpoint must use http or https.");
  }
  if (url.username !== "" || url.password !== "") {
    throw invalid("endpoint must not embed URL userinfo.");
  }
  if (url.hash !== "" || url.search !== "") {
    throw invalid("endpoint must not carry a query or fragment.");
  }
  return value;
}

function readThinkingLevels(value: unknown): ThinkingLevel[] {
  if (!Array.isArray(value)) throw invalid("thinkingLevels must be an array.");
  const levels: ThinkingLevel[] = [];
  for (const entry of value) {
    if (
      typeof entry !== "string" ||
      !(THINKING_LEVELS as readonly string[]).includes(entry)
    ) {
      throw invalid(`Unsupported thinking level: ${String(entry)}.`);
    }
    levels.push(entry as ThinkingLevel);
  }
  return levels;
}

function readPricing(value: unknown): ProfilePricing | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object") throw invalid("pricing must be an object.");
  const record = value as Record<string, unknown>;
  const rates = ["input", "output", "cacheRead", "cacheWrite"] as const;
  const pricing: ProfilePricing = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  for (const rate of rates) {
    const raw = record[rate];
    if (raw === undefined) continue;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
      throw invalid(`pricing.${rate} must be a non-negative number.`);
    }
    pricing[rate] = raw;
  }
  return pricing;
}

function validateInput(input: ProfileInput): void {
  if (typeof input.name !== "string" || input.name.trim() === "") {
    throw invalid("name is required.");
  }
  if (input.mode !== "local" && input.mode !== "cloud") {
    throw invalid("mode must be local or cloud.");
  }
  if (typeof input.provider !== "string" || input.provider.trim() === "") {
    throw invalid("provider is required.");
  }
  if (typeof input.protocol !== "string" || input.protocol.trim() === "") {
    throw invalid("protocol is required.");
  }
  if (typeof input.modelId !== "string" || input.modelId.trim() === "") {
    throw invalid("modelId is required.");
  }
  readEndpoint(input.endpoint);
  const contextWindow = requirePositiveInt(
    input.contextWindow,
    "contextWindow",
  );
  const maxTokens = requirePositiveInt(input.maxTokens, "maxTokens");
  if (maxTokens >= contextWindow) {
    throw invalid("maxTokens must be smaller than contextWindow.");
  }
  requirePositiveInt(input.timeoutSeconds, "timeoutSeconds");
  if (typeof input.supportsTools !== "boolean") {
    throw invalid("supportsTools must be a boolean.");
  }
  readThinkingLevels(input.thinkingLevels);
  readPricing(input.pricing);
  if (!isValidCredentialRef(input.credentialRef)) {
    throw invalid(
      "credentialRef must be env:NAME or file:/absolute/path with no URL userinfo.",
    );
  }
  if (input.mode === "cloud" && (input.credentialRef ?? "") === "") {
    // A cloud profile without a reference is permitted but never falls back to
    // an ambient key; it simply resolves to missing and fails the check.
  }
}

function toProfile(row: ProfileRow): LlmProfile {
  const capabilities = JSON.parse(row.capabilities_json) as {
    supportsTools?: boolean;
    thinkingLevels?: ThinkingLevel[];
    pricing?: ProfilePricing | null;
  };
  return {
    id: row.id,
    name: row.name,
    mode: row.mode === "cloud" ? "cloud" : "local",
    provider: row.provider_adapter,
    protocol: row.protocol,
    endpoint: row.base_url ?? "",
    modelId: row.model_id,
    contextWindow: row.context_limit ?? 0,
    maxTokens: row.output_limit ?? 0,
    timeoutSeconds: Math.round(row.timeout_ms / 1000),
    supportsTools: capabilities.supportsTools ?? true,
    thinkingLevels: capabilities.thinkingLevels ?? ["off"],
    credentialRef: row.credential_reference,
    enabled: row.enabled === 1,
    revision: row.revision,
    pricing: capabilities.pricing ?? null,
  };
}

function readRow(store: Store, id: Id): ProfileRow | undefined {
  return store.db.prepare("SELECT * FROM llm_profiles WHERE id = ?").get(id) as
    | ProfileRow
    | undefined;
}

function insertRow(
  store: Store,
  profile: Omit<LlmProfile, "id" | "revision">,
  id: Id,
  revision: number,
): void {
  store.db
    .prepare(
      `INSERT INTO llm_profiles (
         id, name, mode, provider_adapter, protocol, base_url, model_id,
         context_limit, output_limit, capabilities_json, credential_reference,
         timeout_ms, revision, enabled
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      profile.name,
      profile.mode,
      profile.provider,
      profile.protocol,
      profile.endpoint,
      profile.modelId,
      profile.contextWindow,
      profile.maxTokens,
      JSON.stringify({
        supportsTools: profile.supportsTools,
        thinkingLevels: profile.thinkingLevels,
        pricing: profile.pricing,
      }),
      profile.credentialRef,
      profile.timeoutSeconds * 1000,
      revision,
      profile.enabled ? 1 : 0,
    );
}

export function readProfile(store: Store, id: Id): LlmProfile | null {
  const row = readRow(store, id);
  return row === undefined ? null : toProfile(row);
}

/** Synchronous: callers already hold the revision they are acting against. */
export function snapshotProfile(store: Store, id: Id): LlmProfileSnapshot {
  const profile = readProfile(store, id);
  if (profile === null) {
    throw new AppError(
      "PROFILE_NOT_FOUND",
      `No profile exists for id ${id}.`,
      404,
    );
  }
  return profile;
}

export function listProfiles(store: Store): LlmProfile[] {
  const rows = store.db
    .prepare("SELECT * FROM llm_profiles ORDER BY name ASC")
    .all() as ProfileRow[];
  return rows.map((row) => toProfile(row));
}

export function defaultProfileId(store: Store): Id | null {
  const row = store.db
    .prepare(
      "SELECT default_profile_id AS id FROM app_state WHERE singleton = 1",
    )
    .get() as { id: string | null } | undefined;
  return row?.id ?? null;
}

export async function saveProfile(
  store: Store,
  input: ProfileInput,
  expectedRevision: number | null,
): Promise<LlmProfile> {
  validateInput(input);
  return write(store, () => {
    if (expectedRevision === null) {
      const existing = store.db
        .prepare("SELECT id FROM llm_profiles WHERE name = ?")
        .get(input.name) as { id: string } | undefined;
      if (existing !== undefined) {
        throw new AppError(
          "PROFILE_NAME_EXISTS",
          `A profile named "${input.name}" already exists.`,
          409,
        );
      }
      const id = randomUUID();
      const enabled = input.enabled ?? true;
      insertRow(
        store,
        {
          name: input.name,
          mode: input.mode,
          provider: input.provider,
          protocol: input.protocol,
          endpoint: input.endpoint,
          modelId: input.modelId,
          contextWindow: input.contextWindow,
          maxTokens: input.maxTokens,
          timeoutSeconds: input.timeoutSeconds,
          supportsTools: input.supportsTools,
          thinkingLevels: input.thinkingLevels,
          credentialRef: input.credentialRef,
          enabled,
          pricing: input.pricing ?? null,
        },
        id,
        1,
      );
      return toProfile(readRow(store, id) as ProfileRow);
    }

    if (typeof input.id !== "string" || input.id === "") {
      throw new AppError(
        "INVALID_INPUT",
        "An id is required to update a profile.",
        400,
      );
    }
    const current = readRow(store, input.id);
    if (current === undefined) {
      throw new AppError(
        "PROFILE_NOT_FOUND",
        `No profile exists for id ${input.id}.`,
        404,
      );
    }
    if (current.revision !== expectedRevision) {
      throw new AppError(
        "STALE_INPUT",
        "The profile changed since it was read; reload before saving.",
        409,
      );
    }
    const duplicate = store.db
      .prepare("SELECT id FROM llm_profiles WHERE name = ? AND id <> ?")
      .get(input.name, input.id) as { id: string } | undefined;
    if (duplicate !== undefined) {
      throw new AppError(
        "PROFILE_NAME_EXISTS",
        `A profile named "${input.name}" already exists.`,
        409,
      );
    }
    const revision = current.revision + 1;
    const enabled = input.enabled ?? current.enabled === 1;
    store.db
      .prepare(
        `UPDATE llm_profiles SET
           name = ?, mode = ?, provider_adapter = ?, protocol = ?,
           base_url = ?, model_id = ?, context_limit = ?, output_limit = ?,
           capabilities_json = ?, credential_reference = ?, timeout_ms = ?,
           revision = ?, enabled = ?
         WHERE id = ?`,
      )
      .run(
        input.name,
        input.mode,
        input.provider,
        input.protocol,
        input.endpoint,
        input.modelId,
        input.contextWindow,
        input.maxTokens,
        JSON.stringify({
          supportsTools: input.supportsTools,
          thinkingLevels: input.thinkingLevels,
          pricing: input.pricing ?? null,
        }),
        input.credentialRef,
        input.timeoutSeconds * 1000,
        revision,
        enabled ? 1 : 0,
        input.id,
      );
    return toProfile(readRow(store, input.id) as ProfileRow);
  });
}

export interface SelectDefaultOptions {
  readonly confirmCloud?: boolean;
}

export async function selectDefaultProfile(
  store: Store,
  id: Id,
  options: SelectDefaultOptions = {},
): Promise<void> {
  return write(store, () => {
    const profile = readProfile(store, id);
    if (profile === null) {
      throw new AppError(
        "PROFILE_NOT_FOUND",
        `No profile exists for id ${id}.`,
        404,
      );
    }
    if (!profile.enabled) {
      throw new AppError(
        "PROFILE_DISABLED",
        "A disabled profile cannot become the default.",
        409,
      );
    }
    if (profile.mode === "cloud" && options.confirmCloud !== true) {
      throw new AppError(
        "CLOUD_CONFIRMATION_REQUIRED",
        "Selecting a cloud profile as the default requires explicit confirmation.",
        409,
      );
    }
    store.db
      .prepare(
        "UPDATE app_state SET default_profile_id = ?, updated_at = ? WHERE singleton = 1",
      )
      .run(id, new Date().toISOString());
  });
}

export async function recordProfileCheck(
  store: Store,
  input: ProfileCheckInput,
): Promise<void> {
  return write(store, () => {
    store.db
      .prepare(
        `INSERT INTO profile_checks (
           id, profile_id, profile_revision, status, checked_at, duration_ms,
           result_json, error
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.profileId,
        input.profileRevision,
        input.status,
        input.checkedAt,
        input.durationMs,
        JSON.stringify({
          endpoint: input.endpoint,
          modelId: input.modelId,
          reason: input.reason,
        }),
        input.reason,
      );
  });
}

/** The compatibility check for the profile's current revision, or unchecked. */
export function readCompatibility(store: Store, id: Id): ProfileCompatibility {
  const profile = readProfile(store, id);
  if (profile === null) {
    throw new AppError(
      "PROFILE_NOT_FOUND",
      `No profile exists for id ${id}.`,
      404,
    );
  }
  const row = store.db
    .prepare(
      `SELECT status, profile_revision, checked_at, duration_ms, result_json, error
       FROM profile_checks WHERE profile_id = ?
       ORDER BY checked_at DESC, rowid DESC LIMIT 1`,
    )
    .get(id) as
    | {
        status: string;
        profile_revision: number;
        checked_at: string;
        duration_ms: number | null;
        result_json: string;
        error: string | null;
      }
    | undefined;

  if (row === undefined || row.profile_revision !== profile.revision) {
    return {
      status: "unchecked",
      reason: null,
      profileRevision: null,
      checkedAt: null,
      endpoint: null,
      modelId: null,
      durationMs: null,
    };
  }
  const result = JSON.parse(row.result_json) as {
    endpoint?: string;
    modelId?: string;
  };
  const status: CompatibilityStatus =
    row.status === "verified"
      ? "verified"
      : row.status === "failed"
        ? "failed"
        : "skipped";
  return {
    status,
    reason: row.error ?? null,
    profileRevision: row.profile_revision,
    checkedAt: row.checked_at,
    endpoint: result.endpoint ?? profile.endpoint,
    modelId: result.modelId ?? profile.modelId,
    durationMs: row.duration_ms,
  };
}
