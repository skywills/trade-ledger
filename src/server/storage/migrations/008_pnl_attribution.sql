ALTER TABLE strategy_allocations ADD COLUMN pnl_attribution TEXT
  CHECK (pnl_attribution IN ('broker-reported', 'basis-reconciled', 'estimated'));
