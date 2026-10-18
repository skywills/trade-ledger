import { describe, expect, it } from "vitest";
import {
  classifyLegs,
  type Leg,
} from "../../src/server/strategies/matching.js";
import {
  emptyDraft,
  recomputePresentation,
} from "../../src/server/strategies/projection.js";
import type { Instrument } from "../../src/shared/domain.js";

function leg(
  putCall: "P" | "C",
  strike: string,
  quantity: string,
  overrides: Partial<Instrument> = {},
): Leg {
  return {
    quantity,
    instrument: {
      key: `${putCall}:${strike}`,
      assetClass: "OPT",
      symbol: "UNH",
      underlying: "UNH",
      conid: null,
      expiry: "2026-09-18",
      strike,
      putCall,
      multiplier: "100",
      ...overrides,
    },
  };
}

function presentation(legs: Leg[]) {
  const draft = emptyDraft("example");
  draft.openingLegs = legs.map((entry, index) => ({
    ...entry,
    executionKey: `fill-${index}`,
    date: "2026-08-01",
    role: "open",
    event: "trade",
    multiplier: entry.instrument.multiplier,
    netCash: "0",
    brokerPnl: null,
    sources: [],
  }));
  recomputePresentation(draft);
  return draft;
}

const patterns: { type: string; legs: Leg[] }[] = [
  {
    type: "custom",
    legs: [
      leg("C", "90", "1"),
      leg("C", "90", "1", { multiplier: "10" }),
      leg("C", "100", "-1"),
    ],
  },
  {
    type: "custom",
    legs: [
      leg("C", "90", "1", { conid: "same" }),
      leg("C", "90", "1", { conid: "same", expiry: "2026-10-16" }),
      leg("C", "100", "-1"),
    ],
  },

  { type: "long_straddle", legs: [leg("P", "100", "1"), leg("C", "100", "1")] },
  {
    type: "short_straddle",
    legs: [leg("P", "100", "-2"), leg("C", "100", "-2")],
  },
  { type: "long_strangle", legs: [leg("P", "90", "1"), leg("C", "110", "1")] },
  {
    type: "short_strangle",
    legs: [leg("P", "90", "-2"), leg("C", "110", "-2")],
  },
  {
    type: "jade_lizard",
    legs: [leg("P", "90", "-1"), leg("C", "100", "-1"), leg("C", "110", "1")],
  },
  {
    type: "call_ratio_spread",
    legs: [leg("C", "90", "1"), leg("C", "100", "-2")],
  },
  {
    type: "put_ratio_spread",
    legs: [leg("P", "100", "1"), leg("P", "90", "-2")],
  },
  {
    type: "call_ratio_spread",
    legs: [leg("C", "90", "2"), leg("C", "100", "-3")],
  },
  {
    type: "call_backspread",
    legs: [leg("C", "100", "3"), leg("C", "90", "-1")],
  },
  {
    type: "put_backspread",
    legs: [leg("P", "90", "2"), leg("P", "100", "-1")],
  },
  {
    type: "call_zebra_candidate",
    legs: [leg("C", "90", "2"), leg("C", "100", "-1")],
  },
  {
    type: "put_zebra_candidate",
    legs: [leg("P", "100", "4"), leg("P", "90", "-2")],
  },
  {
    type: "call_zebra_candidate",
    legs: [leg("C", "90", "1"), leg("C", "90", "1"), leg("C", "100", "-1")],
  },
  { type: "custom", legs: [leg("P", "110", "1"), leg("C", "90", "1")] },
  { type: "custom", legs: [leg("P", "90", "-1"), leg("C", "110", "-2")] },
  { type: "custom", legs: [leg("P", "90", "1"), leg("C", "110", "-1")] },
  {
    type: "custom",
    legs: [
      leg("C", "100", "2", { conid: "first" }),
      leg("C", "100", "-1", { conid: "different" }),
    ],
  },
  {
    type: "custom",
    legs: [leg("P", "90", "-1"), leg("C", "100", "1"), leg("C", "110", "-1")],
  },
  {
    type: "custom",
    legs: [leg("P", "90", "-1"), leg("C", "100", "-2"), leg("C", "110", "1")],
  },
  {
    type: "custom",
    legs: [
      leg("C", "90", "2"),
      leg("C", "100", "-1", { expiry: "2026-10-16" }),
    ],
  },
  {
    type: "custom",
    legs: [leg("P", "90", "-1"), leg("C", "110", "-1", { underlying: "SPX" })],
  },
  {
    type: "custom",
    legs: [leg("P", "90", "-1"), leg("C", "110", "-1", { multiplier: "10" })],
  },
];

describe("additional option strategies", () => {
  it.each(patterns)(
    "recognizes $type with order-independent contract totals",
    ({ type, legs }) => {
      expect(classifyLegs(legs)).toBe(type);
      expect(classifyLegs([...legs].reverse())).toBe(type);
    },
  );
});

describe("strategy descriptions", () => {
  it.each([
    {
      legs: [leg("P", "390", "-1"), leg("P", "380", "1")],
      want: "UNH Sep18'26 380/390 Bull Put Spread",
    },
    {
      legs: [leg("P", "90", "-1"), leg("C", "100", "-1"), leg("C", "110", "1")],
      want: "UNH Sep18'26 90P/100C/110C Jade Lizard",
    },
    {
      legs: [leg("P", "100", "-1"), leg("C", "100", "-1")],
      want: "UNH Sep18'26 100C/100P Short Straddle",
    },
    {
      legs: [leg("P", "90", "1"), leg("C", "110", "1")],
      want: "UNH Sep18'26 90P/110C Long Strangle",
    },
    {
      legs: [leg("C", "90", "1"), leg("C", "90", "1"), leg("C", "100", "-4")],
      want: "UNH Sep18'26 90/100 1×2 Call Ratio Spread",
    },
    {
      legs: [leg("P", "100", "1"), leg("P", "90", "-1.5")],
      want: "UNH Sep18'26 90/100 2×3 Put Ratio Spread",
    },
    {
      legs: [leg("P", "90", "4"), leg("P", "100", "-2")],
      want: "UNH Sep18'26 90/100 2×1 Put Backspread",
    },
    {
      legs: [leg("C", "90", "2"), leg("C", "100", "-1")],
      want: "UNH Sep18'26 90/100 2×1 Call ZEBRA Candidate",
    },
    { legs: [leg("C", "100.50", "1")], want: "UNH Sep18'26 100.5 Long Call" },
    {
      legs: [
        leg("P", "90", "1"),
        leg("P", "100", "-1", { expiry: "2026-10-16" }),
      ],
      want: "UNH Sep18'26 90 / Oct16'26 100 Custom",
    },
  ])("formats $want", ({ legs, want }) => {
    expect(presentation(legs).description).toBe(want);
    expect(presentation([...legs].reverse()).description).toBe(want);
  });

  it("keeps stock descriptions free of option fields", () => {
    expect(
      presentation([
        leg("C", "0", "100", {
          assetClass: "STK",
          expiry: null,
          strike: null,
          putCall: null,
        }),
      ]).description,
    ).toBe("UNH Stock");
  });
});
