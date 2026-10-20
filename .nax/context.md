# trade-ledger

Single-user, local-first journal for IBKR Flex CSV exports. One Node 22 process
serves a Fastify API and a compiled React (Vite) frontend on the same origin;
all state is SQLite under a writable `/data` volume. Model inference is optional
and never required for readiness.

## Layout

- `src/server/` - Fastify app, config, storage (SQLite + migrations), imports,
  ledger, builds, strategies, lifecycles, analytics, chat/agent tools, jobs.
- `src/shared/` - types and contracts shared by server and web.
- `src/web/` - React frontend (dashboard, journal, imports, review, chat, ...).
- `test/unit/`, `test/integration/` - Vitest (`*.test.ts` / `*.test.tsx`).
- `e2e/` - Playwright browser acceptance (`*.spec.ts`).
- `docs/` - SETUP, TEST-PLAN, implementation status, design specs and plans.

## Commands (npm)

- `npm run lint` - Biome check (`-- --write` to fix)
- `npm run typecheck` - `tsc --noEmit`
- `npm test` - Vitest unit + integration
- `npm run test:coverage` - Vitest with v8 coverage
- `npm run build` - server tsc + migrations copy + Vite build
- `npm run test:e2e` - Playwright (needs a build and Chromium)

CI (`.github/workflows/trade-ledger.yml`) runs `check:all`, `test:coverage`,
build smoke, Playwright and Docker smoke.

## Conventions

- TypeScript strict with `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`; ES modules (`NodeNext`).
- Money and quantities keep exact decimal values; never round-trip through
  floats for stored or exported amounts.
- Missing amounts stay unavailable (no zero-filling); fees and credits keep
  their signs.
- New behaviour gets a Vitest test under `test/`; user-visible flows get a
  Playwright spec under `e2e/`.
