# Report incident grouping

Original `reports` documents and their attachments remain the source of evidence. Counts in existing dashboard/report summaries continue to count reports, not incidents.

## Model

`incidents/{generatedId}` stores `reportIds`, `reportCount`, `type`, `barangayIds`, status (`Verified`, `Resolved`, `Ungrouped`), creation/update actor IDs and server times, and resolution metadata where applicable. Original reports and existing road mirrors receive `incidentId`, `incidentReportIds`, and `incidentReportCount`. These fields are backend-owned. No existing records require migration; missing incident fields mean an ungrouped report.

All membership changes, associated verification/resolution changes, road-mirror updates and Activity Logs commit in one Firestore transaction. Each report can reference only one incident. An unchanged grouping or repeated resolution returns the existing result without repeating audit events or changing verification times. Membership changes do not rewrite evidence, locations, reporters or priorities.

## Endpoints

- `GET /reports/:id/related`: authenticated official suggestions. Same report type, within 250 metres and six hours of the original server-recorded submission time. Missing coordinates/times produce no automatic match. Suggestions exclude rejected/resolved, official-submitted, and already-grouped reports. BOs only receive their assigned barangay's records.
- `POST /reports/:id/incident`: `{operation: "group", reportIds: [...]}` verifies pending members and groups 2–50 distinct reports, including the anchor. BOs can create groups of resident reports in their assigned barangay. LGU/Superadmin may create/correct groups across barangays. Replacing membership detaches removed reports without reverting their verification.
- Same endpoint with `{operation: "ungroup"}` detaches all members, preserving originals and audit history. Municipality administrators only.
- Same endpoint with `{operation: "resolve"}` resolves all supporting reports and existing road mirrors together. Municipality administrators only.
- Existing `PATCH /reports/:id` supports LGU direct verification and continues BO barangay checks. Grouped reports require the incident operation, preventing an individual update from leaving a partially resolved incident.

Critical pending reports remain in existing LGU report/map reads. Grouping does not delay or hide them. Map markers retain their original geographic positions and display the shared incident identifier/support count.

## Release

Deploy the backend and the updated web application. Deploy the matching `ligtas-mobile/firestore.rules` before making grouping generally available: direct client changes/deletion of grouped reports and mirrors are blocked; incident documents are accessed only through authenticated backend operations. Build and distribute the updated mobile app (or use the existing supported update workflow). No new BO screen or Firebase composite index is required. Older clients cannot directly change the status of grouped records; they must update to use the backend review flow.

Verification includes backend incident/RBAC/idempotency tests, Firestore emulator rules tests, frontend interaction tests, and browser-based responsive checks of the existing BO verification modal and LGU report details. Browser fixtures do not write production records and do not replace physical-device release checks.
