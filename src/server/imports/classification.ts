import type { RawRow } from "../../shared/domain.js";

export type RowKind = RawRow["kind"];

export interface Classification {
  kind: RowKind;
  /** Stable issue code when the row must be quarantined; otherwise null. */
  quarantineCode: string | null;
}

const SUPPORTING_LOT_CODES: ReadonlySet<string> = new Set(["ST", "LT"]);

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

/**
 * Classifies a mapped data row. LevelOfDetail wins when supplied. Without it,
 * rows carrying execution identities (TradeID/IBExecID) are executions even
 * when ST/LT codes are present; no-identity rows with ST/LT codes are the
 * inspected layouts' supporting lots. Everything else is quarantined.
 */
export function classifyFields(fields: Record<string, string>): Classification {
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
  if (codes.some((code) => SUPPORTING_LOT_CODES.has(code))) {
    return { kind: "lot", quarantineCode: null };
  }
  return { kind: "quarantine", quarantineCode: "unknown_row_type" };
}
