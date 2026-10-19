import type { FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "../../shared/errors.js";
import { normalizeHost } from "../config.js";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Rejects browser mutations that do not carry the configured same origin. Runs
 * as an `onRequest` hook so it fires before any body is parsed or validated.
 * Operator CLI paths invoke services directly and never pass through here.
 */
export function createOriginGuard(allowedOrigin: string) {
  return async function originGuard(
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> {
    if (!MUTATING_METHODS.has(request.method)) return;
    if (!request.url.startsWith("/api/")) return;
    if (request.headers.origin !== allowedOrigin) {
      throw new AppError(
        "CROSS_ORIGIN_REJECTED",
        "Cross-origin mutations are not permitted.",
        403,
      );
    }
  };
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isAllowedHost(host: string, allowed: ReadonlySet<string>): boolean {
  if (allowed.has(host)) return true;
  return LOOPBACK_HOSTNAMES.has(new URL(`http://${host}`).hostname);
}

/**
 * Rejects every request (any method, API or static asset) whose `Host` header
 * is not an allowed authority. This is the DNS-rebinding defence: a page on an
 * attacker hostname that re-resolves to this server still sends its own
 * hostname in `Host`. Loopback names are accepted on any port because a
 * browser only sends them for a page that is itself on loopback, and port
 * mappings (Docker `-p`, app.inject) change the port the client sees.
 */
export function createHostGuard(allowedHosts: readonly string[]) {
  const allowed: ReadonlySet<string> = new Set(allowedHosts);
  return async function hostGuard(
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> {
    const raw = request.headers.host;
    const host = typeof raw === "string" ? normalizeHost(raw) : null;
    if (host !== null && isAllowedHost(host, allowed)) return;
    throw new AppError(
      "HOST_NOT_ALLOWED",
      "The request Host is not served by this journal.",
      421,
    );
  };
}
