import { testProfile } from "../../src/server/ai/compatibility.js";
import {
  type ProfileInput,
  saveProfile,
} from "../../src/server/ai/profiles.js";
import {
  ALGORITHM_VERSION,
  activeLedgerSnapshot,
  activeProjection,
  rebuild,
} from "../../src/server/builds/service.js";
import {
  commitImport,
  previewImport,
} from "../../src/server/imports/service.js";
import { LEDGER_PARSER_VERSION } from "../../src/server/ledger/normalize.js";
import type { Store } from "../../src/server/storage/database.js";
import type { LedgerSnapshot } from "../../src/shared/domain.js";
import { fixtures } from "../fixtures/scenarios.js";
import type { InferenceServer } from "./inference-server.js";

export const ORIGIN = "http://localhost:3000";

export function profileInput(name: string, endpoint: string): ProfileInput {
  return {
    name,
    endpoint,
    mode: "local",
    provider: "openai",
    protocol: "openai-completions",
    modelId: "test-local-a",
    contextWindow: 8192,
    maxTokens: 1024,
    timeoutSeconds: 10,
    supportsTools: true,
    thinkingLevels: ["off"],
    credentialRef: null,
  };
}

/** An unverified local profile snapshot, enough for run rows. */
export async function localProfile(store: Store) {
  return saveProfile(
    store,
    profileInput("chat-local", "http://127.0.0.1:1/v1"),
    null,
  );
}

/** A verified profile against a fake inference server. */
export async function verifiedProfile(
  store: Store,
  inference: InferenceServer,
  name = "chat-local",
) {
  const profile = await saveProfile(
    store,
    profileInput(name, inference.url),
    null,
  );
  const result = await testProfile(
    store,
    profile.id,
    new AbortController().signal,
  );
  if (result.status !== "verified")
    throw new Error(`profile not verified: ${result.reason ?? ""}`);
  return profile;
}

export async function seedLedger(
  store: Store,
  bytes: Uint8Array = fixtures.spread,
): Promise<{ buildId: string; ledger: LedgerSnapshot }> {
  const preview = await previewImport(store, {
    filename: "seed.csv",
    bytes,
    timezone: "UTC",
  });
  await commitImport(store, preview.id);
  await rebuild(store, {
    mode: "full",
    parserVersion: LEDGER_PARSER_VERSION,
    algorithmVersion: ALGORITHM_VERSION,
    signal: new AbortController().signal,
  });
  const ledger = activeLedgerSnapshot(store);
  const buildId = activeProjection(store).buildId;
  if (ledger === null || buildId === null) throw new Error("seed failed");
  return { buildId, ledger };
}
