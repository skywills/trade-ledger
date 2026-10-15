// src/server/chat/turn.ts

import type { AgentSession } from "@nathapp/nax-agent";
import { Decimal } from "decimal.js";
import { AppError } from "../../shared/errors.js";
import { UsageMeter } from "../ai/session-host.js";
import type { Store } from "../storage/database.js";
import type { TurnAccumulator } from "./accumulator.js";
import type { ThreadEventBus } from "./frames.js";
import type { ChatLimits } from "./service.js";
import {
  type ChatThread,
  readThread,
  type ThreadStatus,
  updateMessage,
  updateThread,
} from "./threads.js";

export interface TurnInput {
  readonly store: Store;
  readonly bus: ThreadEventBus;
  readonly session: AgentSession;
  readonly thread: ChatThread;
  readonly assistantMessageId: string;
  readonly prompt: string;
  readonly limits: ChatLimits;
  readonly accumulator: TurnAccumulator;
  readonly now: () => Date;
}

function threadBreach(
  thread: ChatThread,
  meter: UsageMeter,
  limits: ChatLimits,
): string | null {
  if (
    new Decimal(thread.cost)
      .plus(meter.costUsd)
      .greaterThan(limits.maxThreadCostUsd)
  )
    return "limit:thread_cost";
  if (
    thread.usage.generatedTokens + meter.usage.generatedTokens >
    limits.maxThreadGeneratedTokens
  )
    return "limit:thread_tokens";
  return null;
}

/** Drives one `send()` to completion and persists the outcome. Never throws. */
export async function runTurn(input: TurnInput): Promise<void> {
  const { store, bus, session, thread, accumulator: acc } = input;
  const meter = new UsageMeter(input.limits);
  let cancelReason: string | null = null;
  let failure: string | null = null;
  const emit = (frames: ReturnType<TurnAccumulator["apply"]>) => {
    for (const f of frames) bus.emit(thread.id, f);
  };
  try {
    for await (const event of session.send(input.prompt)) {
      const pendingBefore = acc.pending;
      emit(acc.apply(event));
      if (acc.pending !== pendingBefore) {
        await updateThread(store, thread.id, {
          pending: acc.pending,
          status: acc.pending === null ? "running" : "waiting",
          now: input.now(),
        });
      }
      const breach =
        meter.observe(event) ?? threadBreach(thread, meter, input.limits);
      if (breach !== null && cancelReason === null) {
        cancelReason = breach;
        session.cancel(breach);
      }
    }
  } catch (error) {
    failure =
      error instanceof AppError
        ? error.code
        : error instanceof Error
          ? error.message
          : String(error);
  }
  await finishTurn(input, meter, cancelReason, failure);
}

function outcomeOf(
  acc: TurnAccumulator,
  cancelReason: string | null,
  failure: string | null,
): { status: "complete" | "cancelled" | "failed"; error: string | null } {
  const end = acc.end;
  const status =
    end?.status === "completed" && failure === null
      ? "complete"
      : end?.status === "cancelled" && cancelReason === null
        ? "cancelled"
        : "failed";
  const error =
    status === "complete"
      ? null
      : (cancelReason ??
        failure ??
        end?.errorCode ??
        end?.status ??
        "TURN_FAILED");
  return { status, error };
}

function addUsage(current: ChatThread["usage"], turn: UsageMeter["usage"]) {
  return {
    rounds: current.rounds + turn.rounds,
    inputTokens: current.inputTokens + turn.inputTokens,
    outputTokens: current.outputTokens + turn.outputTokens,
    generatedTokens: current.generatedTokens + turn.generatedTokens,
    cacheReadTokens: current.cacheReadTokens + turn.cacheReadTokens,
    cacheWriteTokens: current.cacheWriteTokens + turn.cacheWriteTokens,
  };
}

async function finishTurn(
  input: TurnInput,
  meter: UsageMeter,
  cancelReason: string | null,
  failure: string | null,
): Promise<void> {
  const { store, bus, thread, accumulator: acc } = input;
  const { status, error } = outcomeOf(acc, cancelReason, failure);
  const turnCost =
    meter.costSource === "unpriced"
      ? "0"
      : new Decimal(meter.costUsd).toFixed();
  await updateMessage(store, input.assistantMessageId, {
    content: acc.finalContent(),
    tools: acc.tools,
    status,
    error,
    usage: meter.usage,
    cost: turnCost,
  }).catch(() => undefined);
  const current = readThread(store, thread.id) ?? thread;
  const usage = addUsage(current.usage, meter.usage);
  const cost = new Decimal(current.cost).plus(turnCost).toFixed();
  const threadStatus: ThreadStatus =
    cancelReason?.startsWith("limit:thread_") === true
      ? "limit_reached"
      : "idle";
  const saved = await updateThread(store, thread.id, {
    status: threadStatus,
    pending: null,
    usage,
    cost,
    now: input.now(),
  }).catch(() => null);
  if (failure !== null)
    bus.emit(thread.id, {
      event: "error",
      data: { code: "TURN_FAILED", message: failure },
    });
  bus.emit(thread.id, {
    event: "message",
    data: { messageId: input.assistantMessageId },
  });
  bus.emit(thread.id, {
    event: "thread",
    data: { status: saved?.status ?? threadStatus, usage, cost },
  });
}
