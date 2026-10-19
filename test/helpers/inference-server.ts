import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A synthetic OpenAI-compatible SSE server for gateway and compatibility tests.
 *
 * It records every request it receives and answers `POST .../chat/completions`
 * with a streaming chat-completion. No journal bytes are ever sent to it: the
 * only prompt used is the fixed synthetic probe in the compatibility service.
 * It is deliberately not a general-purpose mock endpoint — modes cover exactly
 * the failure shapes the guarded transport must distinguish.
 */
export type InferenceMode =
  | "tool-call"
  | "text"
  | "malformed-arguments"
  | "no-tool-call";

/**
 * One scripted assistant reply. A plan is consumed one step per chat-completion
 * request, in order, so a test can drive a real multi-round agent turn: a
 * `tool-call` step then a `text` step makes the loop run the tool and then end.
 */
export interface InferencePlanStep {
  readonly kind: "tool-call" | "text";
  readonly toolName?: string;
  /** Parsed arguments object; serialized as the function-call arguments string. */
  readonly arguments?: unknown;
  readonly text?: string;
  /** Provider-visible thinking, delivered before the answer. */
  readonly thinking?: string;
  /** Separate chunks to test rendering before turn completion. */
  readonly textChunks?: readonly string[];
  /** Pause a scripted reply until the test is ready to observe it. */
  readonly beforeReply?: () => Promise<void>;
  /** Hold a chunk until the test has observed the in-progress reply. */
  readonly textChunkGate?: (index: number) => Promise<void>;
  /** Include a `usage` block (defaults to true) so token accounting is exercised. */
  readonly usage?: boolean;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
}

export interface InferenceServerOptions {
  readonly mode?: InferenceMode;
  readonly modelId?: string;
  readonly toolName?: string;
  readonly text?: string;
  /** Delay every response by this many milliseconds (timeout tests). */
  readonly delayMs?: number;
  /** Answer every request with a 302 to this absolute URL. */
  readonly redirectTo?: string;
  /** Answer every request with this HTTP status instead of streaming. */
  readonly failStatus?: number;
  /**
   * Scripted replies, consumed one per chat-completion request. When present,
   * takes precedence over `mode`; once exhausted the server answers with a
   * closing text reply.
   */
  readonly plan?: readonly InferencePlanStep[];
  /**
   * When set, the `plan` advances only for requests whose advertised tools
   * include this name; other requests fall back to `mode` (so a compatibility
   * probe and an analysis turn can share one endpoint).
   */
  readonly planGateTool?: string;
  /** Delay only the requests that consume a `plan` step (leaves probes fast). */
  readonly planDelayMs?: number;
  /** When true, a request whose messages contain no tool result answers with a question first. */
}

export interface RecordedInferenceRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly json: unknown;
}

export interface InferenceServer {
  /** Origin only, e.g. `http://127.0.0.1:41234`. */
  readonly origin: string;
  /** Origin plus `/v1`, the OpenAI-style base URL. */
  readonly url: string;
  receivedRequests(): readonly RecordedInferenceRequest[];
  interruptedRequests(): number;
  /** Wait for all current handlers, including delayed disconnected responses. */
  waitForIdle(): Promise<void>;
  close(): Promise<void>;
}

function normaliseHeaders(
  headers: IncomingHttpHeaders,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    result[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return result;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startInferenceServer(
  options: InferenceServerOptions = {},
): Promise<InferenceServer> {
  const requests: RecordedInferenceRequest[] = [];
  const mode = options.mode ?? "tool-call";
  const modelId = options.modelId ?? "test-local-a";
  const toolName = options.toolName ?? "journal_probe";
  let planIndex = 0;
  let interrupted = 0;
  const handlers = new Set<Promise<void>>();

  const server = createServer((request, response) => {
    response.once("close", () => {
      if (!response.writableFinished) interrupted += 1;
    });
    const handler = (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks).toString("utf8");
      let pathname = "/";
      try {
        pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      } catch {
        pathname = request.url ?? "/";
      }
      requests.push({
        method: request.method ?? "GET",
        path: pathname,
        headers: normaliseHeaders(request.headers),
        body,
        json: parseJson(body),
      });

      if (options.delayMs !== undefined && options.delayMs > 0) {
        await sleep(options.delayMs);
      }

      if (options.redirectTo !== undefined) {
        response.writeHead(302, { location: options.redirectTo });
        response.end();
        return;
      }

      if (options.failStatus !== undefined) {
        response.writeHead(options.failStatus, {
          "content-type": "application/json",
        });
        response.end(JSON.stringify({ error: "synthetic failure" }));
        return;
      }

      if (request.method === "GET" && pathname.endsWith("/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ object: "list", data: [] }));
        return;
      }

      if (
        request.method !== "POST" ||
        !pathname.endsWith("/chat/completions")
      ) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "unknown path" }));
        return;
      }

      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });

      const base = {
        id: "chatcmpl-synthetic",
        object: "chat.completion.chunk",
        created: 1_700_000_000,
        model: modelId,
      };
      const sendChunk = (
        delta: Record<string, unknown>,
        finish: string | null = null,
      ): void => {
        response.write(
          `data: ${JSON.stringify({
            ...base,
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`,
        );
      };

      sendChunk({ role: "assistant", content: "" });
      const effectiveMode: InferenceMode =
        mode === "no-tool-call" ? "text" : mode;

      const requestJson = parseJson(body) as {
        tools?: Array<{ function?: { name?: unknown } }>;
      } | null;
      const requestToolNames = (requestJson?.tools ?? [])
        .map((tool) => tool.function?.name)
        .filter((name): name is string => typeof name === "string");
      const gate = options.planGateTool;
      const planActive =
        options.plan !== undefined &&
        (gate === undefined || requestToolNames.includes(gate));

      if (planActive && (options.planDelayMs ?? 0) > 0) {
        await sleep(options.planDelayMs ?? 0);
      }

      let planStep: InferencePlanStep | undefined;
      if (planActive && options.plan !== undefined) {
        planStep = options.plan[planIndex];
        planIndex += 1;
      }

      if (planStep !== undefined) {
        await planStep.beforeReply?.();
        if (planStep.thinking !== undefined) {
          sendChunk({ reasoning_content: planStep.thinking });
        }
        if (planStep.kind === "tool-call") {
          sendChunk({
            tool_calls: [
              {
                index: 0,
                id: `call_plan_${planIndex}`,
                type: "function",
                function: {
                  name: planStep.toolName ?? toolName,
                  arguments: JSON.stringify(planStep.arguments ?? {}),
                },
              },
            ],
          });
          sendChunk({}, "tool_calls");
        } else {
          let chunkIndex = 0;
          for (const text of planStep.textChunks ?? [
            planStep.text ?? "synthetic plan text",
          ]) {
            sendChunk({ content: text });
            await planStep.textChunkGate?.(chunkIndex++);
          }
          sendChunk({}, "stop");
        }
      } else if (planActive) {
        sendChunk({ content: "synthetic plan complete" });
        sendChunk({}, "stop");
      } else if (effectiveMode === "text") {
        sendChunk({ content: options.text ?? "synthetic text reply" });
        sendChunk({}, "stop");
      } else if (effectiveMode === "tool-call") {
        sendChunk({
          tool_calls: [
            {
              index: 0,
              id: "call_probe_1",
              type: "function",
              function: {
                name: toolName,
                arguments: JSON.stringify({ value: "ok" }),
              },
            },
          ],
        });
        sendChunk({}, "tool_calls");
      } else {
        // malformed-arguments: valid framing, invalid JSON payload.
        sendChunk({
          tool_calls: [
            {
              index: 0,
              id: "call_probe_1",
              type: "function",
              function: { name: toolName, arguments: "{" },
            },
          ],
        });
        sendChunk({}, "tool_calls");
      }

      if (planStep?.usage === false) {
        response.write("data: [DONE]\n\n");
        response.end();
        return;
      }

      response.write(
        `data: ${JSON.stringify({
          ...base,
          choices: [],
          usage: {
            prompt_tokens: 7,
            completion_tokens: planStep?.outputTokens ?? 3,
            total_tokens: 7 + (planStep?.outputTokens ?? 3),
            completion_tokens_details: {
              reasoning_tokens: planStep?.reasoningTokens ?? 0,
            },
          },
        })}\n\n`,
      );
      response.write("data: [DONE]\n\n");
      response.end();
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
    handlers.add(handler);
    void handler.finally(() => handlers.delete(handler));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    url: `${origin}/v1`,
    receivedRequests: () => requests,
    interruptedRequests: () => interrupted,
    waitForIdle: async () => {
      while (handlers.size > 0) await Promise.all(handlers);
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
