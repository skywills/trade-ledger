# Trade Ledger UX audit

The audit followed three trader tasks: checking performance, tracing a figure back to its CSV row, and resolving work that needs attention. The visual direction keeps the existing ledger tables, currency precision and signed P&L. The changes give more space to records and actions, especially on phones. The design reference was Damir Sokolovsky’s [Unslop skill](https://github.com/heydamir/unslop/blob/main/skills/unslop/SKILL.md).

| Page | Finding and outcome |
| --- | --- |
| Navigation | On a 375px screen, later destinations were offscreen in a strip with a hidden scrollbar. A Menu button now exposes all destinations. Escape closes it and returns focus. |
| Agent home and conversation | A decorative mark and a long introduction preceded model setup. The home screen now leads with the journal question, shows a ready indicator only for a verified, enabled model and links directly to model profiles. The conversation view retains its existing thread drawer and streaming controls. |
| Dashboard overview | The slogan, category label, filters and zero-count summary pushed the initial import action below the fold. A new journal now gets one import action beneath the dashboard tabs. |
| Open positions | The header could suggest a historical date range for current holdings. It now identifies the current scope. |
| Analysis | The dashboard header now distinguishes open-ended date ranges, and the four view links take less vertical space on phones. The existing contribution tables and drilldowns retain their scope. |
| Reports | Removed the extra category line above the report title. The date range, currency, P&L basis, provenance and print action remain together. |
| Journal | An empty journal offered filters and sortable columns before there were any strategies. The import action now leads directly to setup. A search with zero matches keeps the filters and their clear action. |
| Strategy detail | At 375px the History tab extended beyond the viewport. Compact, wrapping tabs now fit the available width. Wide allocation and lot tables scroll within keyboard-focusable regions. A failed or superseded strategy link offers a return to the journal. |
| Lifecycles and campaign detail | The lifecycle introduction now describes the holdings and events being tracked. Empty-build guidance links to import. Campaign load failures provide a path back to the lifecycle list. |
| Transactions | The ledger stopped after 100 transactions. Linked pages now expose later records, and numeric columns align on the right. An empty ledger explains how to import trades. |
| Imports and source rows | “View rows” opened the import form without displaying records. Each import now opens a paged row list. Selecting a row reads it by its original row number, including rows beyond the first 100. The committed-file table scrolls within the page. |
| Review | Loading could briefly announce a missing build, and a journal without a build could report a clean review. Build and review messages now wait for the corresponding data. |
| Maintenance | Model setup links previously landed above rebuild, rollback and reset controls. They now focus the model profiles heading. Rebuild and backup progress are announced as status updates. |
| Unknown address | The error page now includes a dashboard link. |

## Coverage

The browser checks used temporary journals and synthetic Flex records. Desktop and phone checks used 1280px and 375px viewports. The regression suite also exercises conversation streaming, campaign coverage, dashboard filters, print output, source links, review decisions and maintenance confirmations.

## Large-journal follow-up

Search, currency and status filters, and column sorting now apply to the full active build before the server returns a page. The journal shows the number of matches, and its URL stores the filters, sort and page so a trader can return to the same results after opening a strategy.
