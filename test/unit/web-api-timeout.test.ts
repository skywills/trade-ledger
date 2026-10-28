import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApiError, request } from "../../src/web/api.js";

afterEach(() => vi.unstubAllGlobals());

it("maps an opt-in request timeout to REQUEST_TIMEOUT", async () => {
  vi.stubGlobal(
    "fetch",
    (_path: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason),
        );
      }),
  );
  await expect(
    request("/api/slow", z.null(), { timeoutMs: 5 }),
  ).rejects.toMatchObject({
    code: "REQUEST_TIMEOUT",
    status: 0,
    message: "The request timed out. Please retry.",
  });
});

it("does not convert a caller abort into REQUEST_TIMEOUT", async () => {
  vi.stubGlobal(
    "fetch",
    (_path: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason),
        );
      }),
  );
  const controller = new AbortController();
  const pending = request("/api/slow", z.null(), {
    signal: controller.signal,
    timeoutMs: 60_000,
  });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(controller.signal.aborted).toBe(true);
  expect(ApiError).toBeDefined();
});
