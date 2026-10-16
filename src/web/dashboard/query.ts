import {
  type AnalyticsQuery,
  AnalyticsQuerySchema,
} from "../../shared/analytics.js";
export type DashboardView = "overview" | "analysis" | "reports";
export type Preset =
  | "all"
  | "this-month"
  | "last-month"
  | "this-year"
  | "custom";
export interface DashboardQueryState {
  query: AnalyticsQuery;
  preset: Preset;
  section: "performance" | "transactions";
  detail: Record<string, string>;
  error: string | null;
}
export function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const filterKeys = [
  "from",
  "to",
  "currency",
  "basis",
  "symbol",
  "underlying",
  "strategyType",
  "assetClass",
] as const;
export function readDashboardQuery(
  search: string,
  view: DashboardView,
  today: string,
): DashboardQueryState {
  const params = new URLSearchParams(search);
  const raw = Object.fromEntries(
    filterKeys.filter((k) => params.has(k)).map((k) => [k, params.get(k)!]),
  );
  const preset = (params.get("preset") ??
    (params.has("from") || params.has("to")
      ? "custom"
      : view === "reports"
        ? "this-month"
        : "all")) as Preset;
  if (preset !== "all" && preset !== "custom" && !raw.from && !raw.to) {
    const year = Number(today.slice(0, 4)),
      month = Number(today.slice(5, 7));
    const start =
      preset === "last-month"
        ? new Date(Date.UTC(year, month - 2, 1))
        : preset === "this-year"
          ? new Date(Date.UTC(year, 0, 1))
          : new Date(Date.UTC(year, month - 1, 1));
    const end =
      preset === "last-month"
        ? new Date(Date.UTC(year, month - 1, 0))
        : preset === "this-year"
          ? new Date(Date.UTC(year, 11, 31))
          : new Date(Date.UTC(year, month, 0));
    raw.from = start.toISOString().slice(0, 10);
    raw.to = end.toISOString().slice(0, 10);
  }
  const parsed = AnalyticsQuerySchema.safeParse(raw);
  const detail = Object.fromEntries(
    [
      "kind",
      "scope",
      "outcome",
      "groupBy",
      "group",
      "date",
      "expectedBuildId",
      "sort",
      "direction",
      "page",
      "pageSize",
    ]
      .filter((k) => params.has(k))
      .map((k) => [k, params.get(k)!]),
  );
  return {
    query: parsed.success
      ? parsed.data
      : {
          ...raw,
          basis: raw.basis === "reconstructed" ? "reconstructed" : "broker",
        },
    preset,
    section:
      params.get("section") === "transactions" ? "transactions" : "performance",
    detail,
    error: !["all", "this-month", "last-month", "this-year", "custom"].includes(
      preset,
    )
      ? "Choose a valid period."
      : parsed.success
        ? null
        : parsed.error.issues.map((x) => x.message).join(" "),
  };
}
export function dashboardHref(
  view: DashboardView,
  state: DashboardQueryState,
): string {
  const p = new URLSearchParams();
  p.set("preset", state.preset);
  for (const [k, v] of Object.entries(state.query)) if (v) p.set(k, v);
  if (view === "analysis") p.set("section", state.section);
  for (const [k, v] of Object.entries(state.detail)) p.set(k, v);
  return `/dashboard${view === "overview" ? "" : `/${view}`}?${p}`;
}
export function changeDashboard(
  state: DashboardQueryState,
  patch: Partial<AnalyticsQuery>,
): DashboardQueryState {
  return {
    ...state,
    query: { ...state.query, ...patch },
    detail: {},
    error: null,
  };
}
