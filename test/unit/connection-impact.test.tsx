import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { PreviewTotals } from "../../src/shared/proposal-preview.js";
import { ConnectionImpact } from "../../src/web/lifecycles/ConnectionImpact.js";

const before: PreviewTotals = {
  strategyCount: 3,
  lifecycleCount: 3,
  unresolvedStrategies: 1,
  issueCounts: [{ code: "PENDING_CALL_ATTACHMENT", count: 1 }],
  pnlByCurrency: [
    {
      currency: "USD",
      brokerPnl: null,
      reconstructedPnl: "12.345",
      missingBrokerPnl: 2,
      missingReconstructedPnl: 0,
    },
  ],
};

it("renders before and after journal totals and preserves unknown P/L", () => {
  const html = renderToStaticMarkup(
    <ConnectionImpact
      impact={{
        before,
        after: { ...before, lifecycleCount: 2, issueCounts: [] },
      }}
    />,
  );
  expect(html).toContain('aria-label="Connection preview"');
  expect(html).toContain("Before");
  expect(html).toContain("After");
  expect(html).toMatch(/Lifecycles<\/th><td>3<\/td><td>2<\/td>/);
  expect(html).toMatch(/Journal issues<\/th><td>1<\/td><td>0<\/td>/);
  expect(html).toContain("Unavailable");
  expect(html).toContain("2 strategies unavailable");
  expect(html).toContain("12.35");
  expect(html).not.toContain("0.00");
});

it("keeps currencies separate and does not invent amounts for missing currencies", () => {
  const html = renderToStaticMarkup(
    <ConnectionImpact
      impact={{
        before,
        after: {
          ...before,
          lifecycleCount: null,
          pnlByCurrency: [
            {
              currency: "EUR",
              brokerPnl: "-5",
              reconstructedPnl: null,
              missingBrokerPnl: 0,
              missingReconstructedPnl: 1,
            },
          ],
        },
      }}
    />,
  );
  expect(html).toContain("USD");
  expect(html).toContain("EUR");
  expect(html).toContain("-5.00");
  expect(html).toMatch(/Lifecycles<\/th><td>3<\/td><td>Unavailable<\/td>/);
  expect(html).toContain("1 strategy unavailable");
});
