import { z } from "zod";
import { formatMoney } from "../../shared/money.js";
import { useJson } from "../api.js";
import { BuildBadge, ErrorPanel, Loading } from "../components.js";
import { Link, navigate, useLocation } from "../navigation.js";
import { CampaignSchema, LifecycleSchema } from "./api.js";
import "./lifecycles.css";

const Covered = z.object({
  value: z.string().nullable(),
  knownValue: z.string().nullable(),
  known: z.number(),
  total: z.number(),
});
const Basis = z.object({
  eligible: z.number(),
  missing: z.number(),
  wins: z.number(),
  losses: z.number(),
  breakeven: z.number(),
  winRatePct: z.string().nullable(),
  pnl: Covered,
});
const CampaignDetailSchema = z.object({
  campaign: CampaignSchema,
  cycles: z.array(LifecycleSchema),
  summary: z.object({
    campaignId: z.string(),
    completed: z.number(),
    open: z.number(),
    unresolved: z.number(),
    complete: z.number(),
    missing: z.number(),
    broker: Basis,
    reconstructed: Basis,
    openValuation: Covered,
  }),
  buildId: z.string().nullable(),
  ledgerId: z.string().nullable(),
  stale: z.boolean(),
  generatedAt: z.string(),
});
export function CampaignDetail({ id }: { id: string }) {
  const { search } = useLocation();
  const expected = new URLSearchParams(search).get("expectedBuildId");
  const remote = useJson(
    `/api/campaigns/${encodeURIComponent(id)}${expected ? `?expectedBuildId=${encodeURIComponent(expected)}` : ""}`,
    CampaignDetailSchema,
  );
  if (remote.status === "loading") return <Loading label="Loading campaign…" />;
  if (!remote.data)
    return (
      <ErrorPanel
        message={remote.error?.message ?? "Unable to load campaign."}
        onRetry={() => {
          navigate(`/campaigns/${encodeURIComponent(id)}`);
          remote.reload();
        }}
      />
    );
  const { campaign: c, cycles, summary: s } = remote.data;
  const p = remote.data;
  return (
    <section className="lifecycles">
      <Link to="/lifecycles">← Lifecycles</Link>
      <h2>{c.name}</h2>
      <p>
        {c.account} · {c.underlyingKey} · {c.currency}
      </p>
      <BuildBadge buildId={p.buildId} stale={p.stale} />
      <p>
        {s.completed} completed cycles · {s.open} open · {s.unresolved}{" "}
        unresolved · {s.missing} completed cycles with missing results
      </p>
      <div className="card-grid">
        {(
          [
            ["Broker reported", s.broker],
            ["Reconstructed", s.reconstructed],
          ] as const
        ).map(([label, b]) => (
          <section className="card" key={label}>
            <h3>{label} completed P&amp;L</h3>
            <p>{formatMoney(b.pnl.value, c.currency)}</p>
            <p>
              {b.pnl.known} / {b.pnl.total} completed cycles known
            </p>
            {b.pnl.known < b.pnl.total && (
              <p>
                Available subtotal: {formatMoney(b.pnl.knownValue, c.currency)}.
                The complete total is unavailable.
              </p>
            )}
            <p>
              {b.wins} wins · {b.losses} losses · {b.breakeven} breakeven ·{" "}
              {b.missing} unavailable
            </p>
          </section>
        ))}
        <section className="card">
          <h3>Open cycle valuation</h3>
          <p>{formatMoney(s.openValuation.value, c.currency)}</p>
          <p>
            {s.openValuation.known} / {s.openValuation.total} open cycles valued
          </p>
          {s.openValuation.known < s.openValuation.total && (
            <p>
              Available subtotal:{" "}
              {formatMoney(s.openValuation.knownValue, c.currency)}. Add
              complete dated prices to the remaining cycles.
            </p>
          )}
        </section>
      </div>
      <p>
        <Link
          to={`/dashboard/analysis?unit=lifecycle&campaignId=${encodeURIComponent(c.id)}&account=${encodeURIComponent(c.account)}&currency=${encodeURIComponent(c.currency)}&basis=broker&preset=all`}
        >
          Analyze campaign lifecycles
        </Link>
      </p>
      <h3>Independent cycles</h3>
      <ul>
        {cycles.map((l) => (
          <li key={l.id}>
            <Link
              to={`/lifecycles/${encodeURIComponent(l.id)}?expectedBuildId=${encodeURIComponent(p.buildId ?? "")}`}
            >
              {l.description || l.id}
            </Link>{" "}
            · {l.stage.replaceAll("_", " ")} · {l.status.replaceAll("_", " ")}
          </li>
        ))}
      </ul>
      <p>
        Each completed lifecycle counts once in performance. Campaigns do not
        add observations.
      </p>
    </section>
  );
}
