# Batch Connection Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve selected connections for one underlying in date order using one share lifecycle.

**Architecture:** Keep existing contract groups and add underlying/account/currency sections. A batch dialog orchestrates existing preview, decision and rebuild APIs sequentially with retained retry state.

**Tech Stack:** React, TypeScript, Zod, Vitest, Playwright.

**Spec:** docs/superpowers/specs/2026-10-25-batch-connection-review-design.md

## Global Constraints

- Preserve the server's earlier-connection and coverage validation.
- Use one shared share lifecycle for Connect.
- Keep accounts and currencies separate.
- Stop on failure and retain completed items and request IDs.

## Review Focus

- Unselected earlier dependencies must block saving later connections.
- Rebuild failure must retry without duplicating a saved decision.
- Lost save response must retry the original request and payload.
- Concurrent changes must stop the batch before another save.
- Date ties must respect known execution chronology.

### Task 1: Batch planning and sequential processing

**Files:** Create `src/web/lifecycles/connection-batch.ts`; test `test/unit/connection-batch.test.ts`.

**Interfaces:** Expose underlying sections, common candidates, ordered batch items and a sequential runner using existing API schemas.

- [x] Write failing tests for grouping, chronology, shared targets, blocking preview, retry and stale journal behavior.
- [x] Run `npm test -- test/unit/connection-batch.test.ts` and observe failures.
- [x] Implement grouping and runner; preserve exact pending save payload and request ID for retries.
- [x] Run the targeted tests and typecheck.

### Task 2: Grouped review interface

**Files:** Modify `ConnectionQueue.tsx` and `connections.css`; create `BatchConnectionDialog.tsx`; add browser coverage in `e2e/connection-order.spec.ts`.

**Interfaces:** Consume Task 1 sections and runner. Keep individual review links and refresh queue after dialog dismissal.

- [x] Add failing browser coverage for selection, one shared lifecycle and chronological resolution.
- [x] Implement accessible selection, confirmation dialog, progress, stop/retry and refreshed results using existing styling.
- [x] Run browser connection tests, full unit suite, lint, typecheck and build.
- [x] Review the final diff against the approved design.

## Execution record

User approved design and instructed proceed. Executed inline in the supplied workspace. Final changes are prepared on `feat/batch-connection-review` for PR submission.

Task 1 complete: real projection/validator tests cover grouping, same-day chronology, shared target, account/currency isolation, missing dependency, stale build, partial success, save-response loss, rebuild failure and navigation. Task 2 browser scenarios cover connect, keep separate, dependency blocking, dropped response retry and the mobile Review page. Screenshot inspected at 390px width.

Independent code review found an interleaved-fill deadlock (A opens days 2/4, B opens day 3). Ruling: save the closure of mutually dependent selected contract groups in one decision, preserving complete source partitions; continue sequentially afterward. A regression with a later independent C now passes through the real server validator. Each grouped attempt retains one exact request and receipt across every included contract.

Follow-up review of the correction: clean. Final targeted browser run: 5 passed, including mobile Review page, individual dependency/recovery and new batch behavior. Build and typecheck passed. Lint passed with 4 existing warnings in unchanged `src/web/styles.css` and `test/integration/models.test.ts`; the build retains its existing main-chunk-size warning.

Final full unit/integration run after the correction: 97 files passed, 1006 tests passed. `git diff --check` passed. A fresh final code review before PR submission found no actionable issues; the full suite was rerun with the same passing result.
