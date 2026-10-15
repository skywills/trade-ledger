import type { SessionEvent } from "@nathapp/nax-agent";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TURN_LIMITS,
  UsageMeter,
} from "../../src/server/ai/session-host.js";

const base = {
  sessionId: "s",
  turnId: "t",
  at: "2026-10-15T00:00:00Z",
  metadata: {},
};
function usage(
  round: number,
  outputTokens: number,
  costUsd: number,
  costSource?: "computed" | "unpriced",
): SessionEvent {
  return {
    ...base,
    type: "usage",
    round,
    inputTokens: 10,
    outputTokens,
    costUsd,
    ...(costSource ? { costSource } : {}),
  } as SessionEvent;
}

describe("UsageMeter", () => {
  it("accumulates tokens and priced cost", () => {
    const meter = new UsageMeter(DEFAULT_TURN_LIMITS);
    expect(meter.observe(usage(1, 100, 0.01))).toBeNull();
    expect(meter.observe(usage(2, 50, 0.02))).toBeNull();
    expect(meter.usage).toMatchObject({
      rounds: 2,
      inputTokens: 20,
      outputTokens: 150,
      generatedTokens: 150,
    });
    expect(meter.costUsd).toBeCloseTo(0.03);
    expect(meter.costSource).toBe("computed");
  });

  it("never sums unpriced cost", () => {
    const meter = new UsageMeter(DEFAULT_TURN_LIMITS);
    meter.observe(usage(1, 10, 99, "unpriced"));
    expect(meter.costUsd).toBe(0);
    expect(meter.costSource).toBe("unpriced");
  });

  it("reports each limit breach", () => {
    const limits = {
      maxOutputTokens: 100,
      maxModelRounds: 2,
      maxTotalGeneratedTokens: 150,
    };
    expect(new UsageMeter(limits).observe(usage(3, 1, 0))).toBe(
      "limit:max_rounds",
    );
    expect(new UsageMeter(limits).observe(usage(1, 101, 0))).toBe(
      "limit:max_output_tokens",
    );
    const meter = new UsageMeter(limits);
    meter.observe(usage(1, 90, 0));
    expect(meter.observe(usage(2, 90, 0))).toBe("limit:max_generated_tokens");
  });

  it("takes authoritative totals from turn_end", () => {
    const meter = new UsageMeter(DEFAULT_TURN_LIMITS);
    meter.observe(usage(2, 10, 0.01));
    meter.observe({
      ...base,
      type: "turn_end",
      status: "completed",
      output: "x",
      usage: { inputTokens: 40, outputTokens: 30 },
      costUsd: 0.05,
    } as SessionEvent);
    expect(meter.usage).toMatchObject({
      rounds: 2,
      inputTokens: 40,
      outputTokens: 30,
      generatedTokens: 30,
    });
    expect(meter.costUsd).toBeCloseTo(0.05);
  });
});
