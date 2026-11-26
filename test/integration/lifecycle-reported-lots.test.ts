import { expect, it } from "vitest";
import {
  ALGORITHM_VERSION,
  activeProjection,
  rebuild,
} from "../../src/server/builds/service.js";
import {
  commitImport,
  previewImport,
} from "../../src/server/imports/service.js";
import { createTestStore } from "../helpers/store.js";

it("attributes a stock sale and its broker P&L to the lots named by the report", async () => {
  const { store, dispose } = await createTestStore();
  try {
    // Both put assignments deliver into a single stock order. Of the 80
    // shares sold, the broker took 30 from the $100 lot and 50 from the $90 lot.
    const csv = [
      "ClientAccountID,CurrencyPrimary,Symbol,UnderlyingSymbol,AssetClass,Conid,Put/Call,Expiry,Strike,Multiplier,TradeID,DateTime,Quantity,NetCash,TradePrice,Notes/Codes,PositionActionID,IBOrderID,FifoPnlRealized,LevelOfDetail,OpenDateTime",
      "A,USD,XYZ,XYZ,OPT,11,P,2026-10-16,100,100,older,20261001;100000,-1,200,2,O,,older,,EXECUTION,",
      "A,USD,XYZ,XYZ,OPT,12,P,2026-10-16,90,100,newer,20261001;100000,-1,200,2,O,,newer,,EXECUTION,",
      "A,USD,XYZ,XYZ,OPT,11,P,2026-10-16,100,100,a1,20261002;100000,1,0,0,C;A,first,a1,200,EXECUTION,",
      "A,USD,XYZ,XYZ,STK,1,,,,1,s1,20261002;100000,100,-10000,100,O;A,first,stock,,EXECUTION,",
      "A,USD,XYZ,XYZ,OPT,12,P,2026-10-16,90,100,a2,20261003;100000,1,0,0,C;A,second,a2,200,EXECUTION,",
      "A,USD,XYZ,XYZ,STK,1,,,,1,s2,20261003;100000,100,-9000,90,O;A,second,stock,,EXECUTION,",
      "A,USD,XYZ,XYZ,STK,1,,,,1,sale,20261008;100000,-80,8400,105,C,,sale,900,EXECUTION,",
      "A,USD,XYZ,XYZ,STK,1,,,,1,sale,20261008;100000,-30,,,,,,,CLOSED_LOT,20261002;100000",
      "A,USD,XYZ,XYZ,STK,1,,,,1,sale,20261008;100000,-50,,,,,,,CLOSED_LOT,20261003;100000",
    ].join("\n");
    const preview = await previewImport(store, {
      filename: "reported-lots.csv",
      bytes: new TextEncoder().encode(csv),
      timezone: "UTC",
    });
    await commitImport(store, preview.id);
    await rebuild(store, {
      mode: "full",
      parserVersion: "flex-v1",
      algorithmVersion: ALGORITHM_VERSION,
      signal: new AbortController().signal,
    });
    const cycles = activeProjection(store).projection?.lifecycles;
    if (!cycles) throw new Error("Missing lifecycle projection");
    for (const [origin, quantity, brokerPnl, held] of [
      ["older", "-30", "150", "70"],
      ["newer", "-50", "750", "50"],
    ]) {
      const lifecycle = cycles.lifecycles.find(
        (l) => l.originOpeningExecutionKey === `txn:A:trade:${origin}`,
      );
      expect(lifecycle).toBeDefined();
      const sale = cycles.members.find(
        (m) =>
          m.lifecycleId === lifecycle?.id &&
          m.allocation.executionKey === "txn:A:trade:sale",
      );
      expect(sale).toMatchObject({ quantity, brokerPnl, estimated: false });
      expect(lifecycle?.positions).toContainEqual({
        instrumentKey: "conid:1",
        quantity: held,
      });
    }
  } finally {
    await dispose();
  }
});
