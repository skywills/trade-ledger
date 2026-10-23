import { Decimal } from "decimal.js";
import { expect, it, vi } from "vitest";
import { closeCandidates } from "../../src/server/strategies/grouping-close-candidates.js";
import { createGroupingContext } from "../../src/server/strategies/grouping-context.js";
import { execution, fixture, stock } from "../fixtures/lifecycles.js";

it.each([
  ["100", "-100"],
  ["-100", "100"],
])(
  "skips zero exposures while retaining a %s share position for a %s close",
  (quantity, closeQuantity) => {
    const opening = execution("opening", stock, quantity, "-10000", 1, "open");
    const close = execution("close", stock, closeQuantity, "10100", 2, "close");
    const { ledger } = fixture([
      ["position", opening],
      ["position", close],
    ]);
    const context = createGroupingContext(ledger, [], () => "position");
    for (let i = 0; i < 200; i++) context.draftFor(`empty-${i}`, "A", "USD");
    const eligible = context.draftFor("position", "A", "USD");
    eligible.legs.push({
      executionKey: opening.key,
      instrument: stock,
      quantity,
      date: opening.date,
      role: "open",
      event: "trade",
      multiplier: "1",
      netCash: "-10000",
      brokerPnl: null,
      sources: opening.sources,
    });
    const format = vi.spyOn(Decimal.prototype, "toFixed");
    try {
      expect(
        closeCandidates(context, close, closeQuantity).map((draft) => draft.id),
      ).toEqual(["position"]);
      // Operation budget avoids machine-dependent timing assertions.
      expect(format.mock.calls.length).toBeLessThan(5);
    } finally {
      format.mockRestore();
    }
  },
);
