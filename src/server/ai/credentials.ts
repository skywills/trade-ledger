import { existsSync, readFileSync, realpathSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { AppError } from "../../shared/errors.js";
import type { ProfileMode } from "./profiles.js";

/**
 * The documented local-only compatibility placeholder.
 *
 * Local endpoints frequently ignore or do not verify the Authorization value,
 * but a protocol adapter may still insist one is present. This fixed literal is
 * sent upstream instead of any ambient cloud credential; it is never a real
 * key and is safe to show in documentation.
 */
export const LOCAL_PLACEHOLDER_API_KEY = "journal-local-no-key-required";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const URL_USERINFO = /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]*@/i;

export type CredentialKind = "none" | "env" | "file";

export interface CredentialStatus {
  readonly ref: string | null;
  readonly kind: CredentialKind;
  readonly label: string;
  readonly configured: boolean;
}

/**
 * Resolves a profile's `credentialRef` to a secret value inside the server
 * process only. The browser can select a reference and observe configured or
 * missing status, but never receives the value.
 */
export interface SecretResolver {
  resolve(
    ref: string | null | undefined,
    mode: ProfileMode,
  ): Promise<string | null>;
  status(
    ref: string | null | undefined,
    mode: ProfileMode,
  ): Promise<CredentialStatus>;
}

export interface SecretResolverOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Absolute directory roots under which mounted secret files are allowed. */
  readonly allowedFileRoots: readonly string[];
}

type ParsedRef =
  | { readonly kind: "env"; readonly name: string }
  | { readonly kind: "file"; readonly path: string };

function parseRef(ref: string): ParsedRef {
  if (URL_USERINFO.test(ref)) {
    throw new AppError(
      "INVALID_CREDENTIAL_REF",
      "A credential reference must not embed URL userinfo.",
      400,
    );
  }
  if (ref.startsWith("env:")) {
    const name = ref.slice("env:".length);
    if (!ENV_NAME.test(name)) {
      throw new AppError(
        "INVALID_CREDENTIAL_REF",
        "An env: credential reference must name a valid environment variable.",
        400,
      );
    }
    return { kind: "env", name };
  }
  if (ref.startsWith("file:")) {
    const path = ref.slice("file:".length);
    if (!isAbsolute(path)) {
      throw new AppError(
        "INVALID_CREDENTIAL_REF",
        "A file: credential reference must be an absolute path.",
        400,
      );
    }
    return { kind: "file", path };
  }
  throw new AppError(
    "INVALID_CREDENTIAL_REF",
    "A credential reference must be env:NAME or file:/absolute/path.",
    400,
  );
}

/** Whether a ref is syntactically a supported reference (does not resolve it). */
export function isValidCredentialRef(ref: unknown): boolean {
  if (ref === null || ref === undefined) return true;
  if (typeof ref !== "string") return false;
  try {
    parseRef(ref);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves a path to its real location even when the leaf does not exist yet:
 * walk up to the nearest existing ancestor, realpath that (following any
 * symlinks), then re-append the missing tail. Returns null when no ancestor
 * can be resolved. This keeps containment meaningful for a missing-but-allowed
 * file instead of misreporting it as outside the allowlist.
 */
function canonicalPath(path: string): string | null {
  let current = resolve(path);
  const tail: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return null;
    tail.unshift(basename(current));
    current = parent;
  }
  try {
    const real = realpathSync(current);
    return tail.length === 0 ? real : join(real, ...tail);
  } catch {
    return null;
  }
}

function isUnderRoot(path: string, root: string): boolean {
  let realRoot: string;
  try {
    realRoot = realpathSync(resolve(root));
  } catch {
    return false;
  }
  const canonical = canonicalPath(path);
  if (canonical === null) return false;
  if (canonical === realRoot) return true;
  const rel = relative(realRoot, canonical);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(`..${sep}`);
}

export function createSecretResolver(
  options: SecretResolverOptions,
): SecretResolver {
  return {
    async resolve(ref, _mode) {
      if (ref === null || ref === undefined || ref === "") {
        // Neither mode has a reference to resolve: a local profile uses the
        // placeholder and a cloud profile fails closed. Nothing ambient is
        // ever borrowed.
        return null;
      }
      const parsed = parseRef(ref);
      if (parsed.kind === "env") {
        const value = options.env[parsed.name];
        return value === undefined || value === "" ? null : value;
      }
      if (
        !options.allowedFileRoots.some((root) => isUnderRoot(parsed.path, root))
      ) {
        throw new AppError(
          "CREDENTIAL_REF_NOT_ALLOWED",
          "The credential file is outside the configured secrets directory.",
          400,
        );
      }
      if (!existsSync(parsed.path)) return null;
      return readFileSync(parsed.path, "utf8").trim();
    },

    async status(ref, mode) {
      if (ref === null || ref === undefined || ref === "") {
        return {
          ref: null,
          kind: "none",
          label: mode === "local" ? "Local placeholder" : "(none)",
          // A local profile needs no credential; a cloud profile without one is
          // not configured.
          configured: mode === "local",
        };
      }
      const parsed = parseRef(ref);
      if (parsed.kind === "env") {
        const value = options.env[parsed.name];
        return {
          ref,
          kind: "env",
          label: parsed.name,
          configured: value !== undefined && value !== "",
        };
      }
      const allowed = options.allowedFileRoots.some((root) =>
        isUnderRoot(parsed.path, root),
      );
      return {
        ref,
        kind: "file",
        label: parsed.path,
        configured: allowed && existsSync(parsed.path),
      };
    },
  };
}

/** The process resolver: environment plus the configured secrets directory. */
export function createDefaultSecretResolver(): SecretResolver {
  const secretsDir = process.env.JOURNAL_SECRETS_DIR;
  return createSecretResolver({
    env: process.env,
    allowedFileRoots:
      secretsDir === undefined || secretsDir.trim() === "" ? [] : [secretsDir],
  });
}

const SECRET_KEY_NAMES = new Set([
  "authorization",
  "xapikey",
  "apikey",
  "cfaigauthorization",
  "password",
  "token",
  "secret",
  "cookie",
]);

function isSecretHeader(name: string): boolean {
  return SECRET_KEY_NAMES.has(name.toLowerCase().replace(/[_-]/g, ""));
}

/** Replaces sensitive header values with a fixed marker, preserving keys. */
export function redactHeaders(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key] = isSecretHeader(key) ? "[redacted]" : value;
  }
  return result;
}

/**
 * Removes credential material from a log line or snapshot string: URL
 * userinfo, bearer tokens, credential headers and secret query parameters.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/gi, "$1[redacted]@")
    .replace(
      /([?&](?:api[_-]?key|key|token|access_token|authorization)=)[^&\s]+/gi,
      "$1[redacted]",
    )
    .replace(/([Bb]earer)\s+[A-Za-z0-9._~+/-]+=*/g, "$1 [redacted]")
    .replace(
      /(authorization|x-api-key|api[_-]?key|password|token|secret)(\s*[:=]\s*)(\S+)/gi,
      "$1$2[redacted]",
    );
}
