// Real Docker smoke test for the production app image. It builds the image,
// starts it against a uniquely labelled named volume, and asserts through the
// Docker CLI and HTTP that:
//   - the process does not run as root;
//   - readiness is green;
//   - a synthetic import produces exactly one strategy;
//   - the same volume preserves the import across a graceful (SIGTERM) restart;
//   - a stored local model profile survives the restart.
// It removes ONLY the containers, volumes and image it created, all tagged with
// a unique run label, so it is safe to run beside other Docker workloads.
import { once } from "node:events";
import { createServer } from "node:net";
import { execFileSync, spawnSync } from "node:child_process";

const REPO_ROOT = process.cwd();
const LABEL = `ibkr-smoke-${Date.now()}-${process.pid}`;
const IMAGE = `ibkr-journal-smoke:${LABEL}`;
const VOLUME = `${LABEL}-data`;
const ALLOWED_ORIGIN_PORT = "3000";

// A minimal synthetic Flex CSV: one opening option execution yields exactly one
// strategy. No private or broker-sourced data is used anywhere in this file.
const CSV = [
  "ClientAccountID,AssetClass,Symbol,UnderlyingSymbol,Conid,CurrencyPrimary,TradeDate,DateTime,Quantity,TradePrice,NetCash,Notes/Codes,IBOrderID,BrokerageOrderID,IBExecID,TradeID,Expiry,Strike,Put/Call,Multiplier,LevelOfDetail",
  "SIM-SMOKE,OPT,SMOKE,SMOKE,9900001,USD,2026-09-03,2026-09-03 10:00:00,+1,2.00,-200,O,SMOKE-OPEN,SMOKE-OPEN,EXEC-SMOKE-1,TRADE-SMOKE-1,2026-12-18,100,C,100,EXECUTION",
].join("\n");

function docker(args, options = {}) {
  const result = spawnSync("docker", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `docker ${args.join(" ")} failed (${result.status})\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }
  return (result.stdout ?? "").trim();
}

function log(message) {
  process.stdout.write(`[docker-smoke] ${message}\n`);
}

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Could not determine an ephemeral host port.");
  }
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function waitForReady(baseUrl, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health/ready`);
      if (response.status === 200) return;
      lastError = new Error(`readiness returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Container did not become ready: ${String(lastError)}`);
}

async function startContainer({ name, hostPort, volume }) {
  const origin = `http://127.0.0.1:${hostPort}`;
  docker([
    "run",
    "-d",
    "--name",
    name,
    "--label",
    `ibkr-smoke=${LABEL}`,
    "-p",
    `127.0.0.1:${hostPort}:${ALLOWED_ORIGIN_PORT}`,
    "-e",
    `ALLOWED_ORIGIN=${origin}`,
    "-v",
    `${volume}:/data`,
    IMAGE,
  ]);
  await waitForReady(origin, 60_000);
  return origin;
}

async function importStrategyCount(origin) {
  const response = await fetch(`${origin}/api/journal?pageSize=10`);
  if (!response.ok) throw new Error(`journal read failed: ${response.status}`);
  const body = await response.json();
  return body.total;
}

async function commitSyntheticImport(origin) {
  const form = new FormData();
  form.append(
    "file",
    new Blob([CSV], { type: "text/csv" }),
    "synthetic-smoke.csv",
  );
  const preview = await fetch(`${origin}/api/imports/preview?timezone=UTC`, {
    method: "POST",
    headers: { origin },
    body: form,
  });
  if (preview.status !== 201) {
    throw new Error(`preview failed: ${preview.status} ${await preview.text()}`);
  }
  const { previews } = await preview.json();
  const previewId = previews[0]?.id;
  if (typeof previewId !== "string") {
    throw new Error("preview did not return an id");
  }

  const commit = await fetch(`${origin}/api/imports/${previewId}/commit`, {
    method: "POST",
    headers: { origin },
  });
  if (!commit.ok) {
    throw new Error(`commit failed: ${commit.status} ${await commit.text()}`);
  }
  const committed = await commit.json();
  if (committed.duplicate !== false) {
    throw new Error("first import was unexpectedly reported as a duplicate");
  }

  const build = await fetch(`${origin}/api/builds`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ mode: "full" }),
  });
  if (build.status !== 202) {
    throw new Error(`build submit failed: ${build.status}`);
  }
  const { jobId } = await build.json();

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const jobResponse = await fetch(`${origin}/api/jobs/${jobId}`);
    const { job } = await jobResponse.json();
    if (job.status === "complete") return;
    if (job.status === "failed" || job.status === "cancelled") {
      throw new Error(`build job ended ${job.status}: ${job.error ?? ""}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("build job did not complete in time");
}

async function storeLocalModel(origin) {
  const response = await fetch(`${origin}/api/models`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({
      name: "smoke-local",
      mode: "local",
      provider: "openai",
      protocol: "openai-completions",
      endpoint: "http://host.docker.internal:11434/v1",
      modelId: "test-local-a",
      contextWindow: 8192,
      maxTokens: 1024,
      timeoutSeconds: 10,
      supportsTools: true,
      thinkingLevels: ["off"],
      credentialRef: null,
    }),
  });
  if (response.status !== 201) {
    throw new Error(`model save failed: ${response.status} ${await response.text()}`);
  }
}

async function storedLocalModelId(origin) {
  const response = await fetch(`${origin}/api/models`);
  const body = await response.json();
  return body.profiles?.[0]?.modelId;
}

async function importedTotal(origin) {
  const response = await fetch(`${origin}/api/imports?pageSize=10`);
  const body = await response.json();
  return body.total;
}

const containers = [];
let imageBuilt = false;

try {
  log(`building image ${IMAGE}`);
  docker(["build", "-t", IMAGE, "."]);
  imageBuilt = true;

  docker(["volume", "create", "--label", `ibkr-smoke=${LABEL}`, VOLUME]);

  const hostPort = await freePort();
  const firstName = `${LABEL}-a`;
  containers.push(firstName);
  log(`starting ${firstName} on 127.0.0.1:${hostPort}`);
  let origin = await startContainer({
    name: firstName,
    hostPort,
    volume: VOLUME,
  });

  const uid = docker(["exec", firstName, "id", "-u"]);
  if (uid === "0") throw new Error("container is running as root");
  log(`container uid=${uid}`);

  const health = await fetch(`${origin}/health/ready`);
  if (health.status !== 200) {
    throw new Error(`/health/ready returned ${health.status}`);
  }

  await commitSyntheticImport(origin);
  const firstCount = await importStrategyCount(origin);
  if (firstCount !== 1) {
    throw new Error(`expected 1 imported strategy, got ${firstCount}`);
  }
  await storeLocalModel(origin);
  log("imported one strategy and stored a local model profile");

  // Restart on the same volume and confirm durable state survives. Use a real
  // SIGTERM (docker stop) rather than SIGKILL (docker rm -f) so the graceful
  // shutdown path is exercised and must exit cleanly.
  log("restarting on the same volume after a graceful SIGTERM");
  docker(["stop", "-t", "30", firstName]);
  const exitCode = docker([
    "inspect",
    "--format",
    "{{.State.ExitCode}}",
    firstName,
  ]);
  if (exitCode !== "0") {
    throw new Error(`container did not exit cleanly on SIGTERM: ${exitCode}`);
  }
  docker(["rm", firstName]);
  containers.splice(containers.indexOf(firstName), 1);
  const secondName = `${LABEL}-b`;
  containers.push(secondName);
  origin = await startContainer({
    name: secondName,
    hostPort,
    volume: VOLUME,
  });

  const restartCount = await importStrategyCount(origin);
  if (restartCount !== 1) {
    throw new Error(`strategy count was not preserved across restart: ${restartCount}`);
  }
  const restartImports = await importedTotal(origin);
  if (restartImports !== 1) {
    throw new Error(`import count was not preserved across restart: ${restartImports}`);
  }
  const modelId = await storedLocalModelId(origin);
  if (modelId !== "test-local-a") {
    throw new Error(`stored local model id was ${String(modelId)}`);
  }

  log(
    "PASS: non-root uid, readiness, 1 imported strategy, restart persistence, local model id=test-local-a",
  );
} finally {
  for (const name of containers.splice(0)) {
    try {
      docker(["rm", "-f", name]);
    } catch (error) {
      log(`cleanup: ${String(error)}`);
    }
  }
  try {
    docker(["volume", "rm", VOLUME]);
  } catch (error) {
    log(`cleanup: ${String(error)}`);
  }
  if (imageBuilt) {
    try {
      docker(["rmi", IMAGE]);
    } catch (error) {
      log(`cleanup: ${String(error)}`);
    }
  }
  // Safety net: never leave labelled resources behind if a name drifted.
  try {
    const leftover = execFileSync(
      "docker",
      ["ps", "-aq", "--filter", `label=ibkr-smoke=${LABEL}`],
      { encoding: "utf8" },
    ).trim();
    if (leftover !== "") {
      docker(["rm", "-f", ...leftover.split("\n")]);
    }
  } catch {
    // Ignore: the explicit cleanup above is the primary path.
  }
}
