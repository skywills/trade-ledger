import { Decimal } from "decimal.js";
import type { Execution, Issue, SourceRef } from "../../shared/domain.js";
import { canonicalDecimal, normalizeDate } from "../imports/normalization.js";
import type { RevisionDraft } from "./revisions.js";

export interface CashEvidenceRow {
  id: string;
  importId: string;
  rowNumber: number;
  fields: Record<string, string>;
}

interface Payment {
  row: CashEvidenceRow;
  account: string;
  currency: string;
  date: string | null;
  event: "assignment" | "exercise";
  root: string;
  expiry: string | null;
  strike: string;
  right: string;
  amount: string | null;
  problem: string | null;
}

function cashAmount(fields: Record<string, string>): string | null {
  const amount = canonicalDecimal(fields.Amount);
  const debit = canonicalDecimal(fields.Debit);
  const credit = canonicalDecimal(fields.Credit);
  if ([amount, debit, credit].some((v) => v.status === "invalid")) return null;
  if (debit.status === "ok" && new Decimal(debit.value).gt(0)) return null;
  if (credit.status === "ok" && new Decimal(credit.value).lt(0)) return null;
  const hasParts = debit.status === "ok" || credit.status === "ok";
  if (!hasParts) return amount.status === "ok" ? amount.value : null;
  if (
    debit.status === "ok" &&
    credit.status === "ok" &&
    !new Decimal(debit.value).isZero() &&
    !new Decimal(credit.value).isZero()
  )
    return null;
  const sum = new Decimal(debit.status === "ok" ? debit.value : 0).plus(
    credit.status === "ok" ? credit.value : 0,
  );
  if (amount.status === "ok" && !sum.eq(amount.value)) return null;
  return sum.toFixed();
}

function payment(row: CashEvidenceRow): Payment | null {
  const f = row.fields;
  if (
    f.ActivityCode?.trim().toUpperCase() !== "ADJ" ||
    !/^Option Cash Settlement for:/i.test(f.ActivityDescription?.trim() ?? "")
  )
    return null;
  const match =
    /^Option Cash Settlement for:\s*(Assignment|Exercise)\s*\(\s*(\S+)\s+(\d{2})([A-Z]{3})(\d{2})\s+(\d+(?:\.\d+)?)\s+([CP])\s*\)\s*$/i.exec(
      f.ActivityDescription?.trim() ?? "",
    );
  const months = [
    "JAN",
    "FEB",
    "MAR",
    "APR",
    "MAY",
    "JUN",
    "JUL",
    "AUG",
    "SEP",
    "OCT",
    "NOV",
    "DEC",
  ];
  const month = months.indexOf(match?.[4]?.toUpperCase() ?? "") + 1;
  const expiry =
    match && month
      ? normalizeDate(
          `20${match[5]}-${String(month).padStart(2, "0")}-${match[3]}`,
        )
      : null;
  const amount = cashAmount(f);
  const currency = (f.CurrencyPrimary ?? f.Currency ?? "").trim();
  const account = f.ClientAccountID?.trim() ?? "";
  const date = normalizeDate(f.Date?.trim() ?? "");
  const rawSettleDate = f.SettleDate?.trim() ?? "";
  const settleDate = rawSettleDate ? normalizeDate(rawSettleDate) : null;
  return {
    row,
    account,
    currency,
    date,
    event: match?.[1]?.toLowerCase() === "exercise" ? "exercise" : "assignment",
    root: match?.[2]?.toUpperCase() ?? "",
    expiry,
    strike: match?.[6] ? new Decimal(match[6]).toFixed() : "",
    right: match?.[7]?.toUpperCase() ?? "",
    amount,
    problem:
      !match || !expiry
        ? "cash_settlement_contract_invalid"
        : !account
          ? "cash_settlement_account_missing"
          : !currency
            ? "cash_settlement_currency_missing"
            : !date
              ? "cash_settlement_date_invalid"
              : rawSettleDate && (!settleDate || settleDate < date)
                ? "cash_settlement_date_invalid"
                : amount === null || new Decimal(amount).isZero()
                  ? "cash_settlement_amount_invalid"
                  : null,
  };
}

function matches(p: Payment, e: Execution): boolean {
  const f = p.row.fields;
  const refs = [f.RelatedTradeID, f.TradeID]
    .map((ref) => ref?.trim())
    .filter(Boolean);
  const order = (f.IBOrderID || f.OrderID || "").trim();
  const conid = f.Conid?.trim();
  const symbol = f.Symbol?.trim().toUpperCase().replace(/\s+/g, " ");
  const contract = /\(\s*(.+?)\s*\)\s*$/
    .exec(f.ActivityDescription ?? "")?.[1]
    ?.toUpperCase()
    .replace(/\s+/g, " ");
  const quantity = canonicalDecimal(f.TradeQuantity);
  return (
    e.instrument.assetClass === "OPT" &&
    e.action === "close" &&
    (e.event === p.event || e.event === "cash_settlement") &&
    !new Decimal(e.quantity).isZero() &&
    e.account === p.account &&
    e.currency === p.currency &&
    e.date === p.date &&
    e.instrument.symbol.trim().split(/\s+/)[0]?.toUpperCase() === p.root &&
    e.instrument.expiry === p.expiry &&
    e.instrument.putCall === p.right &&
    e.instrument.strike !== null &&
    new Decimal(e.instrument.strike).eq(p.strike || "-1") &&
    refs.every((ref) => ref === e.brokerIds.TradeID) &&
    (!order || order === e.brokerIds.IBOrderID) &&
    (!conid || conid === e.instrument.conid) &&
    (!symbol ||
      symbol ===
        e.instrument.symbol.trim().toUpperCase().replace(/\s+/g, " ") ||
      symbol === contract) &&
    (quantity.status === "absent" ||
      (quantity.status === "ok" &&
        new Decimal(quantity.value).abs().eq(new Decimal(e.quantity).abs())))
  );
}

/** Add explicit settlement cash to its unique option close after trade identity
 * resolution. Funds BUY/SELL rows never contribute again. Ambiguity, conflicts,
 * absent currency, and already-recorded cash cannot manufacture another payment. */
export function applyCashSettlements(
  revisions: RevisionDraft[],
  rows: readonly CashEvidenceRow[],
): Issue[] {
  const payments = rows.map(payment).filter((p): p is Payment => p !== null);
  const issues: Issue[] = [];
  const warn = (code: string, group: readonly Payment[]) => {
    const sources: SourceRef[] = group.map((p) => ({
      importId: p.row.importId,
      rowNumber: p.row.rowNumber,
    }));
    issues.push({
      key: `ledger:${code}:${sources
        .map((s) => `${s.importId}:${s.rowNumber}`)
        .sort()
        .join(",")}`,
      code,
      severity: "warning",
      sources,
    });
  };
  // Repeated exports corroborate one another only with the same explicit
  // transaction ID. Weak rows are never collapsed merely to balance P&L.
  const groups = new Map<string, Payment[]>();
  const ids = new Map<string, Set<string>>();
  for (const p of payments) {
    const fingerprint = JSON.stringify([
      p.account,
      p.currency,
      p.date,
      p.event,
      p.root,
      p.expiry,
      p.strike,
      p.right,
      p.amount,
      p.row.fields.SettleDate ?? "",
      p.row.fields.Conid ?? "",
      p.row.fields.RelatedTradeID ?? "",
      p.row.fields.TradeID ?? "",
      p.row.fields.IBOrderID ?? "",
    ]);
    const group = groups.get(fingerprint) ?? [];
    group.push(p);
    groups.set(fingerprint, group);
    const id = p.row.fields.TransactionID?.trim();
    if (id) {
      const key = `${p.account}\0${p.currency}\0${id}`;
      const fingerprints = ids.get(key) ?? new Set<string>();
      fingerprints.add(fingerprint);
      ids.set(key, fingerprints);
    }
  }
  const active = revisions.filter((r) => r.state === "active");
  const candidates = [...groups.values()].flatMap((group) => {
    const first = group[0];
    if (!first) return [];
    const matched = active.filter((r) =>
      group.every((p) => matches(p, r.payload)),
    );
    const transactionIds = new Set(
      group.map((p) => p.row.fields.TransactionID?.trim()).filter(Boolean),
    );
    const duplicate =
      new Set(group.map((p) => p.row.importId)).size !== group.length ||
      transactionIds.size > 1 ||
      (group.length > 1 &&
        group.some((p) => !p.row.fields.TransactionID?.trim()));
    const idConflict = group.some((p) => {
      const id = p.row.fields.TransactionID?.trim();
      return (
        id && (ids.get(`${p.account}\0${p.currency}\0${id}`)?.size ?? 0) > 1
      );
    });
    const problem =
      first.problem ??
      (duplicate || idConflict ? "cash_settlement_ambiguous" : null);
    return [{ group, first, matched, problem }];
  });
  const uses = new Map<RevisionDraft, number>();
  for (const c of candidates)
    for (const revision of c.matched)
      uses.set(revision, (uses.get(revision) ?? 0) + 1);
  for (const c of candidates) {
    const revision = c.matched.length === 1 ? c.matched[0] : undefined;
    const problem =
      c.problem ??
      (!revision
        ? "cash_settlement_unmatched"
        : uses.get(revision) !== 1
          ? "cash_settlement_ambiguous"
          : null);
    if (problem || !revision || c.first.amount === null) {
      warn(problem ?? "cash_settlement_unmatched", c.group);
      continue;
    }
    const e = revision.payload;
    const amount = new Decimal(c.first.amount);
    if (amount.isPositive() === new Decimal(e.quantity).isPositive()) {
      warn("cash_settlement_sign_conflict", c.group);
      continue;
    }
    // A matching nonzero close already carries this payment; corroborate it,
    // never add it twice. A different nonzero value requires investigation.
    if (!new Decimal(e.netCash).isZero() && !amount.eq(e.netCash)) {
      warn("cash_settlement_cash_conflict", c.group);
      continue;
    }
    e.netCash = amount.toFixed();
    e.event = "cash_settlement";
    for (const p of c.group) {
      revision.importRowIds.push(p.row.id);
      e.sources.push({ importId: p.row.importId, rowNumber: p.row.rowNumber });
    }
  }
  return issues;
}
