# Connection batch robustness hardening

Source: GitHub issue #32, follow-ups from the code review of PRs #27–#31.

## Decisions

- Re-run combined share-coverage validation for every fresh preview attempt, including after a partial-save retry. The check covers all non-complete items and runs once per new request, guarded by the first non-complete item that has no request.
- Add opt-in per-request timeouts to the shared web API client. Connection batch load, preview and save requests use a 30-second timeout; rebuild scheduling and job polling get the same bound. There is no global default timeout, so import and chat behavior is unchanged.
- Allow closing the batch dialog once any save receipt is confirmed. Closing stops observing the batch; the already-scheduled rebuild continues in the background. Closing remains blocked while a save is unconfirmed.
- Compare proposals canonically. Assignment emission order is not semantically meaningful, but quantities, lifecycle targets, roles and coverage requirements are.
- Keep basis-reconciled broker P&L outside the estimated warning tier. Counts are derived from the active projection on every build, and existing unit, integration and browser tests already assert the separation. This is documented rather than changed.

## Constraints

- Preserve retry idempotency: reuse the retained `clientRequestId` and exact payload; never save an acknowledged decision twice.
- Keep all server-side chronology, coverage and stale-build validation in force. The client changes add checks and timeouts; they do not replace server validation.
- Preserve the current separate versus connect behavior and the existing contract-group review flow.
- Keep money and quantities as decimal strings; never parse them into JavaScript numbers on the client.
- Do not add a global request timeout to import uploads, analytics downloads or chat requests.
- Treat the basis-reconciled tier as intentional; do not move those rows back into `estimatedClosed`.

## Approaches

Canonical comparison (chosen): sort assignments by stable allocation identity and serialize explicit fields. This keeps the "selected trades changed" guard without depending on projection member order.

Per-request timeout opt-in (chosen): expose `timeoutMs` on `request`/`requestJson`, combine it with any caller signal via `AbortSignal.any`, and map only the timeout abort to `ApiError("REQUEST_TIMEOUT", ...)`. A global default was rejected because imports and downloads can legitimately exceed 30 seconds.

Dismiss after confirmed save (chosen): derive `saved` from retained receipts in the batch state. This lets the user leave a hung rebuild without risking an unsaved decision.
