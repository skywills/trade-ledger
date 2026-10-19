import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { NativeBackendOptions } from "@nathapp/nax-agent";
import { buildBackendOptions } from "./catalog.js";
import {
  LOCAL_PLACEHOLDER_API_KEY,
  type SecretResolver,
} from "./credentials.js";
import {
  type LlmProfileSnapshot,
  type ProfileMode,
  requireSecureCloudEndpoint,
} from "./profiles.js";

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

/** Response headers safe to relay upstream (avoids double-decoding etc.). */
const RELAYED_RESPONSE_HEADERS = new Set([
  "content-type",
  "cache-control",
  "retry-after",
]);

export interface GatewayOptions {
  /** Fixed upstream base URL the gateway is confined to. */
  readonly upstream: string;
  readonly protocol: string;
  readonly mode: ProfileMode;
  /** Resolves the real upstream credential from server-side secret memory. */
  readonly resolveCredential: () => Promise<string | null>;
  readonly timeoutMs: number;
  readonly maxResponseBytes?: number;
}

export interface Gateway {
  /** The loopback base URL the library is pointed at. */
  readonly baseUrl: string;
  /** Private per-connection token the client presents to the gateway. */
  readonly token: string;
  /** The most recent gateway-level failure reason, if any. */
  failure(): string | null;
  close(): Promise<void>;
}

function isProtocolPath(method: string, pathname: string): boolean {
  if (method === "POST") {
    return (
      pathname.endsWith("/chat/completions") ||
      pathname.endsWith("/responses") ||
      pathname.endsWith("/messages")
    );
  }
  if (method === "GET") {
    return pathname.endsWith("/models");
  }
  return false;
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

function presentToken(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  if (typeof authorization === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match !== null) return match[1] ?? null;
  }
  const apiKey = request.headers["x-api-key"];
  if (typeof apiKey === "string") return apiKey;
  return null;
}

async function readBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxBytes) {
      throw new Error("request_too_large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Starts an ephemeral loopback gateway bound to `127.0.0.1` on an OS-assigned
 * port. The library only ever talks to this origin; the gateway owns redirect
 * policy and upstream auth, so a redirect can never carry evidence elsewhere.
 */
export async function startGateway(options: GatewayOptions): Promise<Gateway> {
  const upstream = new URL(options.upstream);
  const basePath = upstream.pathname.replace(/\/+$/, "");
  const token = `gw_${randomBytes(24).toString("hex")}`;
  const maxResponseBytes =
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  let failure: string | null = null;

  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      failure = failure ?? "gateway_error";
      if (!response.headersSent) sendJson(response, 500, { error: "gateway" });
      else response.end();
    });
  });

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://127.0.0.1");
    } catch {
      sendJson(response, 400, { error: "bad_request" });
      return;
    }
    if (!isProtocolPath(request.method ?? "GET", url.pathname)) {
      sendJson(response, 404, { error: "unknown_path" });
      return;
    }
    if (presentToken(request) !== token) {
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }

    let body: Buffer;
    try {
      body = await readBody(request, MAX_REQUEST_BYTES);
    } catch {
      sendJson(response, 413, { error: "request_too_large" });
      return;
    }

    let upstreamCredential: string | null;
    try {
      upstreamCredential = await options.resolveCredential();
    } catch {
      failure = "credential_unavailable";
      sendJson(response, 502, { error: "credential_unavailable" });
      return;
    }
    if (options.mode === "cloud" && upstreamCredential === null) {
      failure = "credential_missing";
      sendJson(response, 502, { error: "credential_missing" });
      return;
    }
    const authorization =
      upstreamCredential ??
      (options.mode === "local" ? LOCAL_PLACEHOLDER_API_KEY : null);

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      if (value === undefined) continue;
      const lower = key.toLowerCase();
      if (
        HOP_BY_HOP.has(lower) ||
        lower === "authorization" ||
        lower === "x-api-key"
      ) {
        continue;
      }
      headers[lower] = Array.isArray(value) ? value.join(", ") : value;
    }
    if (authorization !== null) {
      headers.authorization = `Bearer ${authorization}`;
    }

    const target = `${upstream.origin}${basePath}${url.pathname}${url.search}`;
    const controller = new AbortController();
    const onClose = (): void => controller.abort();
    // IncomingMessage closes when its request body has been consumed. The
    // response stays open for the entire inference stream, including the wait
    // for upstream headers, so it owns downstream cancellation.
    response.once("close", onClose);
    if (response.destroyed) controller.abort();
    const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
    const signal = AbortSignal.any([controller.signal, timeoutSignal]);

    const init: RequestInit = {
      method: request.method ?? "GET",
      headers,
      redirect: "manual",
      signal,
    };
    if (body.length > 0) init.body = new Uint8Array(body);

    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(target, init);
    } catch (error) {
      response.removeListener("close", onClose);
      const timedOut = timeoutSignal.aborted;
      failure = timedOut ? "timeout" : "upstream_unreachable";
      if (!response.headersSent) {
        sendJson(response, timedOut ? 504 : 502, {
          error: failure,
          cause: error instanceof Error ? error.name : "unknown",
        });
      } else {
        response.end();
      }
      return;
    }

    if (upstreamResponse.status >= 300 && upstreamResponse.status < 400) {
      const location = upstreamResponse.headers.get("location");
      let crossOrigin = false;
      if (location !== null) {
        try {
          crossOrigin =
            new URL(location, upstream.origin).origin !== upstream.origin;
        } catch {
          crossOrigin = true;
        }
      } else {
        crossOrigin = true;
      }
      response.removeListener("close", onClose);
      failure = crossOrigin ? "cross_origin_redirect" : "redirect_rejected";
      sendJson(response, 502, { error: failure });
      return;
    }

    const relayed: Record<string, string> = {};
    for (const [key, value] of upstreamResponse.headers.entries()) {
      if (RELAYED_RESPONSE_HEADERS.has(key.toLowerCase())) relayed[key] = value;
    }
    response.writeHead(upstreamResponse.status, relayed);

    if (upstreamResponse.body === null) {
      response.removeListener("close", onClose);
      response.end();
      return;
    }
    const reader = upstreamResponse.body.getReader();
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxResponseBytes) {
          failure = "response_too_large";
          response.destroy();
          return;
        }
        response.write(Buffer.from(value));
      }
      response.end();
    } catch {
      response.destroy();
    } finally {
      controller.abort();
      response.removeListener("close", onClose);
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    token,
    failure: () => failure,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/**
 * A live gateway plus the backend options a session opens through. The client
 * credential is only ever the gateway token; the real upstream credential
 * stays in gateway memory.
 */
export interface ModelConnection {
  readonly profile: LlmProfileSnapshot;
  readonly baseUrl: string;
  readonly token: string;
  readonly backendOptions: NativeBackendOptions;
  failure(): string | null;
  close(): Promise<void>;
}

export async function openModelConnection(
  profile: LlmProfileSnapshot,
  secrets: SecretResolver,
): Promise<ModelConnection> {
  // Re-checked here, not only on save: a cloud profile stored before the https
  // rule must never send its bearer credential in cleartext.
  if (profile.mode === "cloud") requireSecureCloudEndpoint(profile.endpoint);
  const gateway = await startGateway({
    upstream: profile.endpoint,
    protocol: profile.protocol,
    mode: profile.mode,
    timeoutMs: profile.timeoutSeconds * 1000,
    resolveCredential: () =>
      secrets.resolve(profile.credentialRef, profile.mode),
  });
  return {
    profile,
    baseUrl: gateway.baseUrl,
    token: gateway.token,
    backendOptions: buildBackendOptions(
      profile,
      gateway.baseUrl,
      gateway.token,
    ),
    failure: () => gateway.failure(),
    close: () => gateway.close(),
  };
}
