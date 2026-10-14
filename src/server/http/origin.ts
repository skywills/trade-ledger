import type { FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "../../shared/errors.js";

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
