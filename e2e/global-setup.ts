import { spawnSync } from "node:child_process";

export default function buildBrowserApp(): void {
  // CI can reuse the build already verified by the production smoke test.
  if (process.env.E2E_SKIP_BUILD === "1") return;
  const result = spawnSync("npm", ["run", "build"], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Browser app build failed (${result.status}).`);
}
