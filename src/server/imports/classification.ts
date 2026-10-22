import type { RawRow } from "../../shared/domain.js";

export type RowKind = RawRow["kind"];

export interface Classification {
  kind: RowKind;
  /** Stable issue code when the row must be quarantined; otherwise null. */
  quarantineCode: string | null;
}

const SUPPORTING_LOT_CODES: ReadonlySet<string> = new Set(["ST", "LT"]);

const OPEN_CLOSE_MARKS: ReadonlySet<string> = new Set(["O", "C"]);

const LEVEL_OF_DETAIL_KINDS: Readonly<Record<string, RowKind>> = {
  EXECUTION: "execution",
  CLOSED_LOT: "lot",
  SUMMARY: "summary",
};

export function splitCodes(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(";")
    .map((code) => code.trim())
    .filter((code) => code !== "");
}

export function hasBrokerIdentity(raw: string | undefined): boolean {
  const value = (raw ?? "").trim();
  return value !== "" && value.toUpperCase() !== "N/A";
}

/** Statement of Funds has cash columns and may repeat ordinary trade IDs. */
export function isStatementOfFunds(fields: Record<string, string>): boolean {
  return (
    "ActivityCode" in fields &&
    "ActivityDescription" in fields &&
    ("Amount" in fields || "Debit" in fields || "Credit" in fields)
  );
}

/** Classify cash evidence before applying the existing trade/lot rules. */
export function classifyFields(fields: Record<string, string>): Classification {
  // A funds row may carry the same TradeID as a trade. It is supporting cash
  // evidence, never a second execution, irrespective of LevelOfDetail.
  if (isStatementOfFunds(fields)) return { kind: "cash", quarantineCode: null };
  const levelOfDetail = (fields["LevelOfDetail"] ?? "").trim().toUpperCase();
  if (levelOfDetail !== "") {
    const kind = LEVEL_OF_DETAIL_KINDS[levelOfDetail];
    if (kind === undefined) {
      return { kind: "quarantine", quarantineCode: "unknown_level_of_detail" };
    }
    return { kind, quarantineCode: null };
  }

  const codes = splitCodes(fields["Notes/Codes"]);
  if (
    hasBrokerIdentity(fields["TradeID"]) ||
    hasBrokerIdentity(fields["IBExecID"])
  ) {
    return { kind: "execution", quarantineCode: null };
  }
  // Exports without per-fill ids (expiries, assignment deliveries) still mark
  // each trade as an opening or closing one.
  if (
    splitCodes(fields["Open/CloseIndicator"]).some((mark) =>
      OPEN_CLOSE_MARKS.has(mark.toUpperCase()),
    )
  ) {
    return { kind: "execution", quarantineCode: null };
  }
  if (codes.some((code) => SUPPORTING_LOT_CODES.has(code))) {
    return { kind: "lot", quarantineCode: null };
  }
  return { kind: "quarantine", quarantineCode: "unknown_row_type" };
}
