export type Id = string;
export type DecimalText = string;

export interface SourceRef {
  importId: Id;
  rowNumber: number;
}

export interface Issue {
  key: string;
  code: string;
  sources: SourceRef[];
  severity: "warning" | "error";
}

export interface Instrument {
  key: string;
  assetClass: string;
  symbol: string;
  underlying: string | null;
  conid: string | null;
  expiry: string | null;
  strike: DecimalText | null;
  putCall: "P" | "C" | null;
  multiplier: DecimalText | null;
}

export interface Execution {
  key: string;
  account: string;
  instrument: Instrument;
  date: string;
  rawDateTime: string;
  timezone: string | null;
  quantity: DecimalText;
  price: DecimalText | null;
  currency: string;
  netCash: DecimalText;
  proceeds: DecimalText | null;
  commission: DecimalText | null;
  taxes: DecimalText | null;
  basis: DecimalText | null;
  brokerPnl: DecimalText | null;
  action: "open" | "close" | "mixed" | "unknown";
  event:
    | "trade"
    | "assignment"
    | "exercise"
    | "expiry"
    | "cash_settlement"
    | "unsupported";
  brokerIds: Record<string, string>;
  codes: string[];
  sources: SourceRef[];
}

export interface RawRow {
  rowNumber: number;
  section: string | null;
  fields: Record<string, string>;
  kind: "execution" | "lot" | "summary" | "marker" | "quarantine";
  issues: Issue[];
}

export interface ParsedImport {
  hash: string;
  rows: RawRow[];
  capabilities: string[];
  issues: Issue[];
}

export interface LedgerSnapshot {
  id: Id;
  inputHash: string;
  executions: Execution[];
  lots: RawRow[];
  issues: Issue[];
  conflicts: number;
}

export interface Decision {
  id: Id;
  sequence: number;
  kind: string;
  sources: SourceRef[];
  strategyIds: Id[];
  payload: Record<string, unknown>;
  supersedesId: Id | null;
}

export interface Allocation {
  strategyId: Id;
  executionKey: string;
  quantity: DecimalText;
  netCash: DecimalText;
  brokerPnl: DecimalText | null;
  pnlEstimated: boolean;
  role: "open" | "close";
}

export interface Strategy {
  id: Id;
  type: string;
  currency: string;
  description: string;
  openingDate: string | null;
  closeDate: string | null;
  expiry: string | null;
  expiryYear: number | null;
  status: "open" | "partially_closed" | "closed" | "unresolved";
  complete: boolean;
  openingAmount: DecimalText | null;
  cashflow: DecimalText | null;
  brokerPnl: DecimalText | null;
  reconstructedPnl: DecimalText | null;
  positions: Array<{ instrumentKey: string; quantity: DecimalText }>;
  reasons: string[];
}

export interface Projection {
  ledgerId: Id;
  watermark: number;
  strategies: Strategy[];
  allocations: Allocation[];
  links: Array<{ from: Id; to: Id; type: string; sources: SourceRef[] }>;
  issues: Issue[];
}

export interface BuildResult {
  id: Id;
  status: "active" | "stale" | "failed" | "cancelled";
  issues: Issue[];
}
