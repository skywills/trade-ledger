# Batch connection review — final code review

Verdict: no outstanding actionable findings.

Reviewed the grouped queue, shared lifecycle selection, dialog lifecycle, batch processor, parent-page refresh wiring, styles, unit tests and browser scenarios against the approved design.

Confirmed:

- Accounts and currencies remain separate; Connect requires one common eligible share lifecycle.
- Each save uses a fresh server preview and watermark, followed by a rebuild and refreshed projection.
- Existing chronology and coverage validation remain authoritative. Interleaved selected contract groups share a decision to avoid circular dependencies while retaining complete source partitions.
- Uncertain save retries preserve the original payload and request ID. Acknowledged saves retry only their rebuild.
- Partial failures retain completed items; navigation stops subsequent decisions while allowing an acknowledged save to rebuild.
- Review and Trade Lifecycles refresh after the dialog closes.

An earlier review found the interleaved-fill dependency deadlock; the fix is covered by real server validation in the regression suite and passed a follow-up review. A fresh review of the final full change found no further actionable defects.

Validation: 97 unit/integration test files and 1006 tests passed; 5 connection browser scenarios passed, including the narrow Review page. Production build and TypeScript checks passed. Changed TypeScript files are lint-clean. Repository lint retains 4 existing warnings in unchanged files; the build retains its existing main-chunk-size warning.
