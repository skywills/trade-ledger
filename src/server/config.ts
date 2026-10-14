import { ConfigurationError } from "../shared/errors.js";

export interface AppConfig {
  dataDir: string;
  port: number;
  allowedOrigin: string;
  uploadLimitBytes: number;
  /**
   * Optional directory of built web assets to serve. Unset by default so the
   * API-only test composition is unaffected; Task 15 finalizes the production
   * default and Task 11's e2e harness sets it explicitly.
   */
  staticDir?: string;
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
  const staticDir = env.STATIC_DIR;
  return {
    dataDir,
    port,
    allowedOrigin: readAllowedOrigin(env.ALLOWED_ORIGIN, port, env.NODE_ENV),
    uploadLimitBytes: readUploadLimit(env.UPLOAD_LIMIT_BYTES),
    ...(staticDir === undefined || staticDir.trim() === ""
      ? {}
      : { staticDir }),
  };
}
