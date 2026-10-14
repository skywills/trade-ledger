-- Task 9: persist every field the shared Strategy/Allocation types carry into
-- the projection tables. Existing rows are left untouched; the added columns
-- default to NULL or an empty list so prior builds remain readable.

ALTER TABLE strategy_views ADD COLUMN broker_pnl TEXT;
ALTER TABLE strategy_views ADD COLUMN reconstructed_pnl TEXT;
ALTER TABLE strategy_views ADD COLUMN cashflow TEXT;
ALTER TABLE strategy_views ADD COLUMN reasons_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE strategy_allocations ADD COLUMN broker_pnl TEXT;
ALTER TABLE strategy_allocations ADD COLUMN pnl_estimated INTEGER NOT NULL DEFAULT 0
  CHECK(pnl_estimated IN (0, 1));
