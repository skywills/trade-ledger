import { expect, it } from "vitest";

it("shows merge targets, exact attachment quantities and supersession before acceptance", async () => {
  const { proposalSummary } = await import(
    "../../src/web/review/proposalSummary.js"
  );
  expect(
    proposalSummary({
      kind: "group_merge",
      payload: {
        chosenStrategyId: "target",
        mergedStrategyIds: ["first", "second"],
      },
      supersedesId: "old",
    }),
  ).toEqual(["Merge first, second into target.", "Supersedes decision old."]);
  expect(
    proposalSummary({
      kind: "lifecycle_attachment",
      payload: {
        opening: {
          strategyId: "call",
          executionKey: "execution",
          role: "open",
        },
        targets: [{ lifecycleId: "cycle", quantity: "-1" }],
      },
    }),
  ).toContain("Attach -1 contracts to lifecycle cycle.");
  expect(
    proposalSummary({
      kind: "import_exclusion",
      payload: { importId: "import-1" },
    }),
  ).toEqual(["Exclude import import-1 from the next rebuild."]);
  expect(
    proposalSummary({
      kind: "notes",
      payload: { strategyId: "s", text: "<script>private text</script>" },
    }),
  ).toEqual(["Strategy s: <script>private text</script>"]);
});
