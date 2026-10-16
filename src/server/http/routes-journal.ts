import type { FastifyInstance } from "fastify";
import {
  pageSlice,
  parsePageParams,
  parseSortSpec,
  sortWithAllowlist,
  toEnvelope,
} from "../../shared/api.js";
import { AppError } from "../../shared/errors.js";
import { normalizeStrategyDescription } from "../../shared/symbols.js";
import {
  activeBuildMeta,
  activeLedgerSnapshot,
  activeProjection,
} from "../builds/service.js";
import { readStrategyMetadata } from "../decisions/service.js";
import type { Store } from "../storage/database.js";

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
      ["id", "openingDate", "status", "currency", "type"],
      "openingDate",
    );
    const active = activeProjection(store);
    const strategies = (active.projection?.strategies ?? []).map(
      (strategy) => ({
        ...strategy,
        description: normalizeStrategyDescription(strategy.description),
      }),
    );
    const all = sortWithAllowlist(strategies, sort, {
      id: (entry) => entry.id,
      openingDate: (entry) => entry.openingDate ?? "",
      status: (entry) => entry.status,
      currency: (entry) => entry.currency,
      type: (entry) => entry.type,
    });
    return toEnvelope(
      pageSlice(all, params),
      params,
      all.length,
      active.buildId,
      active.stale,
    );
  });

  app.get("/api/strategies/:id", async (request) => {
    const { id } = request.params as { id: string };
    const active = activeProjection(store);
    const strategy = active.projection?.strategies.find(
      (entry) => entry.id === id,
    );
    if (strategy === undefined) {
      throw new AppError(
        "STRATEGY_NOT_FOUND",
        `No strategy exists for id ${id} in the active build.`,
        404,
      );
    }
    const allocations = (active.projection?.allocations ?? []).filter(
      (entry) => entry.strategyId === id,
    );
    const links = (active.projection?.links ?? []).filter(
      (entry) => entry.from === id || entry.to === id,
    );
    const metadata = readStrategyMetadata(store, id);
    return {
      strategy: {
        ...strategy,
        description: normalizeStrategyDescription(strategy.description),
      },
      allocations,
      links,
      metadata,
      buildId: active.buildId,
      stale: active.stale,
    };
  });
}
