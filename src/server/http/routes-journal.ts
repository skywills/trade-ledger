import type { FastifyInstance } from "fastify";
import {
  pageSlice,
  parsePageParams,
  parseSortSpec,
  sortWithAllowlist,
  toEnvelope,
} from "../../shared/api.js";
import { AppError } from "../../shared/errors.js";
import {
  filterStrategies,
  isJournalSortKey,
  JOURNAL_SORT_KEYS,
  sortStrategies,
} from "../../shared/journal-view.js";
import { normalizeStrategyDescription } from "../../shared/symbols.js";
import {
  activeBuildMeta,
  activeLedgerSnapshot,
  activeProjection,
} from "../builds/service.js";
import { readStrategyMetadata } from "../decisions/service.js";
import type { Store } from "../storage/database.js";
import { loadLedgerSnapshot } from "../storage/ledger.js";
import { selectStrategyEvidence } from "../strategies/evidence.js";

/** Journal, ledger and strategy read routes, all served from the active build. */
export async function registerJournalRoutes(
  app: FastifyInstance,
  store: Store,
): Promise<void> {
  app.get("/api/transactions", async (request) => {
    const params = parsePageParams(request.query);
    const sort = parseSortSpec(
      request.query,
      ["date", "symbol", "currency", "quantity"],
      "date",
    );
    const ledger = activeLedgerSnapshot(store);
    const all = sortWithAllowlist(ledger?.executions ?? [], sort, {
      date: (entry) => entry.date,
      symbol: (entry) => entry.instrument.symbol,
      currency: (entry) => entry.currency,
      quantity: (entry) => entry.quantity,
    });
    const meta = activeBuildMeta(store);
    return toEnvelope(
      pageSlice(all, params),
      params,
      all.length,
      meta.buildId,
      meta.stale,
    );
  });

  app.get("/api/lots", async (request) => {
    const params = parsePageParams(request.query);
    const sort = parseSortSpec(request.query, ["rowNumber"], "rowNumber");
    const ledger = activeLedgerSnapshot(store);
    const all = sortWithAllowlist(ledger?.lots ?? [], sort, {
      rowNumber: (entry) => entry.rowNumber,
    });
    const meta = activeBuildMeta(store);
    return toEnvelope(
      pageSlice(all, params),
      params,
      all.length,
      meta.buildId,
      meta.stale,
    );
  });

  app.get("/api/journal", async (request) => {
    const params = parsePageParams(request.query);
    const sort = parseSortSpec(
      request.query,
      ["id", "currency", "type", ...JOURNAL_SORT_KEYS],
      "openingDate",
    );
    const active = activeProjection(store);
    const strategies = (active.projection?.strategies ?? []).map(
      (strategy) => ({
        ...strategy,
        description: normalizeStrategyDescription(strategy.description),
      }),
    );
    const query = request.query as Record<string, unknown>;
    const { q = "", currency = "", status = "" } = query;
    if (
      typeof q !== "string" ||
      typeof currency !== "string" ||
      typeof status !== "string"
    ) {
      throw new AppError(
        "INVALID_INPUT",
        "Journal filters must be strings.",
        400,
      );
    }
    const matches = filterStrategies(strategies, {
      query: q,
      currency,
      status,
    });
    const sorted =
      query.sort !== undefined && isJournalSortKey(sort.key)
        ? sortStrategies(matches, { key: sort.key, direction: sort.direction })
        : sortWithAllowlist(matches, sort, {
            id: (entry) => entry.id,
            openingDate: (entry) => entry.openingDate ?? "",
            currency: (entry) => entry.currency,
            type: (entry) => entry.type,
          });
    return {
      ...toEnvelope(
        pageSlice(sorted, params),
        params,
        sorted.length,
        active.buildId,
        active.stale,
      ),
      currencies: [
        ...new Set(strategies.map((entry) => entry.currency)),
      ].sort(),
    };
  });

  app.get("/api/strategies/:id", async (request) => {
    const { id } = request.params as { id: string };
    const active = activeProjection(store);
    const query = request.query as Record<string, unknown>;
    if (
      query.expectedBuildId !== undefined &&
      typeof query.expectedBuildId !== "string"
    )
      throw new AppError(
        "INVALID_INPUT",
        "expectedBuildId must be a string.",
        400,
      );
    if (query.expectedBuildId && query.expectedBuildId !== active.buildId)
      throw new AppError(
        "ANALYTICS_BUILD_CHANGED",
        "The active build changed. Refresh before continuing.",
        409,
      );
    const strategy = active.projection?.strategies.find(
      (entry) => entry.id === id,
    );
    if (!active.projection || strategy === undefined) {
      throw new AppError(
        "STRATEGY_NOT_FOUND",
        `No strategy exists for id ${id} in the active build.`,
        404,
      );
    }
    const links = (active.projection?.links ?? []).filter(
      (entry) => entry.from === id || entry.to === id,
    );
    const ledger = loadLedgerSnapshot(store.db, active.projection.ledgerId);
    const evidence = selectStrategyEvidence(
      ledger,
      active.projection.allocations,
      id,
    );
    const metadata = readStrategyMetadata(store, id);
    return {
      strategy: {
        ...strategy,
        description: normalizeStrategyDescription(strategy.description),
      },
      ...evidence,
      links,
      metadata,
      buildId: active.buildId,
      stale: active.stale,
    };
  });
}
