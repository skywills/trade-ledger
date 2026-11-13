import { describe, expect, it } from "vitest";
import type { GroupingContext } from "../../src/server/strategies/grouping-context.js";
import { draftsHolding } from "../../src/server/strategies/grouping-draft-index.js";
import {
  addLeg,
  emptyDraft,
  legOf,
  type StrategyDraft,
} from "../../src/server/strategies/projection.js";
import {
  call as baseCall,
  put as basePut,
  execution,
} from "../fixtures/lifecycles.js";

// IBKR option symbols carry the full contract, so put and call differ.
const call = { ...baseCall, symbol: "XYZ   261218C00100000" };
const put = { ...basePut, symbol: "XYZ   261218P00090000" };

function contextOf(drafts: Map<string, StrategyDraft>): GroupingContext {
  return { drafts } as unknown as GroupingContext;
}

function draftWith(id: string, instrument: typeof call): StrategyDraft {
  const draft = emptyDraft(id);
  addLeg(
    draft,
    legOf(execution(`${id}-open`, instrument, "-1", "100", 1, "open"), "open"),
  );
  return draft;
}

describe("draftsHolding (close-matching candidate index)", () => {
  it("over-includes only drafts sharing a conid or symbol, in draft order", () => {
    const drafts = new Map([
      ["b", draftWith("b", call)],
      ["a", draftWith("a", put)],
      ["c", draftWith("c", call)],
    ]);
    expect(draftsHolding(contextOf(drafts), call).map((d) => d.id)).toEqual([
      "b",
      "c",
    ]);
  });

  it("matches by symbol when the close has no conid", () => {
    const drafts = new Map([["a", draftWith("a", call)]]);
    expect(
      draftsHolding(contextOf(drafts), { ...call, conid: null }).map(
        (d) => d.id,
      ),
    ).toEqual(["a"]);
  });

  it("catches up with drafts and legs added after the first lookup", () => {
    const drafts = new Map([["a", draftWith("a", put)]]);
    const context = contextOf(drafts);
    expect(draftsHolding(context, call)).toEqual([]);
    const later = draftWith("later", call);
    drafts.set("later", later);
    const a = drafts.get("a");
    if (!a) throw Error("missing draft");
    addLeg(
      a,
      legOf(execution("a-call", call, "1", "-20", 2, "close"), "close"),
    );
    expect(draftsHolding(context, call).map((d) => d.id)).toEqual([
      "a",
      "later",
    ]);
  });
});
