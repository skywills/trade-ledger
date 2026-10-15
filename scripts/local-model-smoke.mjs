// OPTIONAL manual smoke against a REAL local inference server. It is NOT part
// of CI and is never run automatically. It sends only the fixed synthetic
// compatibility probe (no journal bytes) and never writes a decision or an
// import, so it cannot change any journal state.
//
// Usage:
//   npm run build
//   LOCAL_MODEL_ENDPOINT=http://host.docker.internal:11434/v1 \
//   LOCAL_MODEL_ID=llama3.1 node scripts/local-model-smoke.mjs
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testProfile } from "../dist/src/server/ai/compatibility.js";
import { saveProfile } from "../dist/src/server/ai/profiles.js";
import {
  closeStore,
  openStore,
} from "../dist/src/server/storage/database.js";

const endpoint = process.env.LOCAL_MODEL_ENDPOINT;
if (endpoint === undefined || endpoint.trim() === "") {
  process.stderr.write(
    "Set LOCAL_MODEL_ENDPOINT (for example http://host.docker.internal:11434/v1).\n",
  );
  process.exit(2);
}
const modelId = process.env.LOCAL_MODEL_ID ?? "local-model";

const dataDir = await mkdtemp(join(tmpdir(), "ibkr-local-model-smoke-"));
const store = openStore(dataDir);
try {
  const profile = await saveProfile(
    store,
    {
      name: "real-local-smoke",
      mode: "local",
      provider: "openai",
      protocol: "openai-completions",
      endpoint,
      modelId,
      contextWindow: 65536,
      maxTokens: 32000,
      timeoutSeconds: 120,
      supportsTools: true,
      thinkingLevels: ["off"],
      credentialRef: null,
    },
    null,
  );

  const result = await testProfile(store, profile.id, new AbortController().signal);
  process.stdout.write(
    `local model smoke: status=${result.status} reason=${result.reason ?? "none"} endpoint=${endpoint} model=${modelId}\n`,
  );
  process.exitCode = result.status === "verified" ? 0 : 1;
} finally {
  await closeStore(store);
  await rm(dataDir, { recursive: true, force: true });
}
