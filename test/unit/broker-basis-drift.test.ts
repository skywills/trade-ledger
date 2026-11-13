import { describe, expect, it } from "vitest";
import { explainedByBrokerBasis } from "../../src/shared/broker-basis.js";

// SOFI Jan31'25 17C: sold -3 for +155.3625432 (commission -0.6374568),
// bought back +3 for -513.64575 with IBKR CostBasis 155.341543 and
// FifoPnlRealized -358.304207.
const open = {
  quantity: "-3",
  netCash: "155.3625432",
  brokerPnl: "0",
  execution: {
    quantity: "-3",
    basis: "-155.3625432",
    commission: "-0.6374568",
  },
};
const close = {
  quantity: "3",
  netCash: "-513.64575",
  brokerPnl: "-358.304207",
  execution: { quantity: "3", basis: "155.341543", commission: "-0.64575" },
};

describe("broker basis drift (IBKR lot basis vs fill cash)", () => {
  it("accepts SOFI's 2-cent gap that IBKR's own cost basis explains", () => {
    expect(
      explainedByBrokerBasis(
        [open, close],
        "-358.2832068",
        "-358.304207",
        "USD",
      ),
    ).toBe(true);
  });

  it("still flags a gap larger than the fees on those fills (wrong lot)", () => {
    // Matched to a lot opened for 120 instead of 155: off by ~35, not cents.
    const wrongLot = { ...open, netCash: "120" };
    expect(
      explainedByBrokerBasis(
        [wrongLot, close],
        "-393.64575",
        "-358.304207",
        "USD",
      ),
    ).toBe(false);
  });

  it("still flags when IBKR's P&L is not cash plus its own basis", () => {
    const inconsistent = { ...close, brokerPnl: "-350" };
    expect(
      explainedByBrokerBasis(
        [open, inconsistent],
        "-358.2832068",
        "-350",
        "USD",
      ),
    ).toBe(false);
  });

  it("does not apply when a closing row has no IBKR cost basis", () => {
    const noBasis = {
      ...close,
      execution: { ...close.execution, basis: null },
    };
    expect(
      explainedByBrokerBasis(
        [open, noBasis],
        "-358.2832068",
        "-358.304207",
        "USD",
      ),
    ).toBe(false);
  });

  it("scales basis and fees when a fill is split across lifecycles", () => {
    const half = {
      ...close,
      quantity: "1.5",
      netCash: "-256.822875",
      brokerPnl: "-179.1521035",
    };
    const halfOpen = {
      ...open,
      quantity: "-1.5",
      netCash: "77.6812716",
      brokerPnl: "0",
    };
    expect(
      explainedByBrokerBasis(
        [halfOpen, half],
        "-179.1416034",
        "-179.1521035",
        "USD",
      ),
    ).toBe(true);
  });
});
