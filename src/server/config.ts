import { resolve } from "node:path";
import { ConfigurationError } from "../shared/errors.js";

export interface AppConfig {
  dataDir: string;
  port: number;
  /**
   * Interface the HTTP listener binds. Loopback by default; the container
   * image sets `0.0.0.0` so Docker's port mapping can reach it.
   */
  host: string;
  allowedOrigin: string;
  /**
   * Normalized `host[:port]` values accepted in the `Host` header, besides
   * loopback names. Always contains the host of `allowedOrigin`.
   */
  allowedHosts: readonly string[];
  uploadLimitBytes: number;
  /**
   * Directory of built web assets to serve. Defaults to the compiled Vite
   * bundle (`dist/web`) in production so one container serves the frontend and
   * the API on the same origin. Unset elsewhere so the API-only test
   * composition is unaffected; the e2e harness sets it explicitly.
   */
  staticDir?: string;
  /**
   * Optional allowlisted directory of mounted secret files that a profile's
   * `file:` credential reference may read. Unset means env-only references.
   */
  secretsDir?: string;
}

const DEFAULT_UPLOAD_LIMIT_BYTES = 20 * 1024 * 1024;

function readPort(value: string | undefined): number {
  if (value === undefined) return 3000;
  if (!/^\d+$/.test(value))
    throw new ConfigurationError("PORT must be an integer from 1 to 65535.");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new ConfigurationError("PORT must be an integer from 1 to 65535.");
  }
  return port;
}

function readAllowedOrigin(
  value: string | undefined,
  port: number,
  nodeEnv: string | undefined,
): string {
  if (value === undefined) {
    if (nodeEnv === "production") {
      throw new ConfigurationError(
        "ALLOWED_ORIGIN must be configured in production.",
      );
    }
    return `http://localhost:${port}`;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError(
      "ALLOWED_ORIGIN must be a valid HTTP or HTTPS origin.",
    );
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.origin !== value ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new ConfigurationError(
      "ALLOWED_ORIGIN must be a valid HTTP or HTTPS origin without a path.",
    );
  }
  return url.origin;
}

function readHost(value: string | undefined): string {
  if (value === undefined) return "127.0.0.1";
  const host = value.trim();
  if (host === "" || /[\s/@]/.test(host)) {
    throw new ConfigurationError(
      "HOST must be a hostname or IP address to bind, e.g. 127.0.0.1.",
    );
  }
  return host;
}

/**
 * Normalizes a `Host` header or `ALLOWED_HOSTS` entry to the lowercased
 * `host[:port]` form that `URL.host` produces (default port 80 omitted).
 * Returns null for anything that is not a bare authority.
 */
export function normalizeHost(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "" || /[\s/\\@?#]/.test(trimmed)) return null;
  try {
    const url = new URL(`http://${trimmed}`);
    return url.host === "" ? null : url.host;
  } catch {
    return null;
  }
}

function readAllowedHosts(
  value: string | undefined,
  allowedOrigin: string,
): string[] {
  const originHost = normalizeHost(new URL(allowedOrigin).host);
  const hosts = originHost === null ? [] : [originHost];
  for (const entry of (value ?? "").split(",")) {
    if (entry.trim() === "") continue;
    const host = normalizeHost(entry);
    if (host === null) {
      throw new ConfigurationError(
        "ALLOWED_HOSTS must be a comma-separated list of host[:port] values.",
      );
    }
    if (!hosts.includes(host)) hosts.push(host);
  }
  return hosts;
}

function readUploadLimit(value: string | undefined): number {
  if (value === undefined) return DEFAULT_UPLOAD_LIMIT_BYTES;
  if (!/^\d+$/.test(value)) {
    throw new ConfigurationError(
      "UPLOAD_LIMIT_BYTES must be a positive safe integer.",
    );
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new ConfigurationError(
      "UPLOAD_LIMIT_BYTES must be a positive safe integer.",
    );
  }
  return limit;
}

export function readConfig(env: NodeJS.ProcessEnv): AppConfig {
  const dataDir = env.DATA_DIR ?? ".data";
  if (dataDir.trim() === "")
    throw new ConfigurationError("DATA_DIR must not be empty.");
  const port = readPort(env.PORT);
  const staticDir =
    env.STATIC_DIR ??
    (env.NODE_ENV === "production" ? resolve("dist/web") : undefined);
  const secretsDir = env.JOURNAL_SECRETS_DIR;
  const allowedOrigin = readAllowedOrigin(
    env.ALLOWED_ORIGIN,
    port,
    env.NODE_ENV,
  );
  return {
    dataDir,
    port,
    allowedOrigin,
    allowedHosts: readAllowedHosts(env.ALLOWED_HOSTS, allowedOrigin),
    host: readHost(env.HOST),
    uploadLimitBytes: readUploadLimit(env.UPLOAD_LIMIT_BYTES),
    ...(staticDir === undefined || staticDir.trim() === ""
      ? {}
      : { staticDir }),
    ...(secretsDir === undefined || secretsDir.trim() === ""
      ? {}
      : { secretsDir }),
  };
}
