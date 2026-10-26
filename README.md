# LigTAS backend

Express API and optional notification worker for the LigTAS Firebase project.

## Balagtas monitoring and resolution update — 26 October 2026

- `GET /dashboard` now includes `waterTrend`, built from the same authorized
  report snapshot. Stored incident coordinates must lie inside the existing
  Balagtas polygon. The rolling window is the preceding 24 hours. Only verified
  or resolved observations are included. Missing coordinates, timestamps and
  categories are excluded, rather than assigned zero values.
- Flood body-depth categories and road-flooding categories are returned as
  separate series. The frontend selects one scale at a time. Each hour contains
  its highest reported category; missing hours remain gaps. This is a report
  observation chart, not a measured river-level feed. A Balagtas gauge source
  is still needed for metre measurements.
- `GET /dashboard/weather` requires the same official access as the dashboard
  and requests only the fixed target 14.8187,120.9054 in Balagtas. No location
  supplied by the caller overrides it. Open-Meteo provides weather-model data,
  not municipal station observations; its grid cell may extend outside town.
  The service validates units/timestamps, coalesces concurrent requests, caches
  ten minutes and backs off after failures. Weather failure does not prevent
  the reports dashboard from loading. Rainfall is the sum of 24 complete hourly
  rain-plus-showers values; incomplete data remains null.
- `PATCH /reports/:id` accepts Resolved only after verification, records its own
  event time and preserves the earlier verification/review times. Retrying the
  same decision preserves timestamps. The website exposes this through the
  existing report-details action area. Old incomplete events are not backfilled.
- No new environment variables or dependencies are required. Keep your existing
  Firebase credentials and API settings; restart the updated source processes.

Sources: https://open-meteo.com/en/docs . Municipal boundary is copied from the
existing project geometry (OpenStreetMap relation 17638449).

Validation: 43 backend tests pass, including boundary checks, missing time/depth
records, separate category scales, permission scoping, weather validation/cache
behavior, failure isolation and resolution transitions. The paired website has
53 passing tests; mobile has 59 service tests and 15 isolated Firestore emulator
tests. A read-only live weather fetch succeeded. Firebase workflow tests used
fixtures/emulation, not live reports.

## Reports analytics update — 26 October 2026

Use this backend together with the updated website ZIP and restart both
processes. `GET /analytics/reports` now returns `analyticsVersion: 1`, a
retrieval timestamp, selected period, authorization scope, report counts,
rankings, hourly counts, timing coverage and a six-month submission trend.
The existing `total`, `byStatus`, `byType` and `byBarangay` fields remain.

The response also includes `presentation.version: 1` for the restored original
website layout. The backend prepares its five metric tuples, barangay/road
rankings, response-time bars, status gradient and legend, chart coordinates,
notes and CSV rows from the same aggregate. The frontend only binds this data;
its original on-screen stylesheet and panel structure are retained. Missing
measurements are Not recorded. The existing Evacuation and Alert History rows
stay unmeasured because these event durations are absent from reports.

- With no month query, totals cover all saved reports. `?month=YYYY-MM` selects
  reports submitted in that month using Asia/Manila boundaries. The trend ends
  in the selected month, or the current Manila month for all-time results.
- LGU administrators see municipality-wide reports. Barangay officials see
  only records matching their assigned `barangayId`. All requests require a
  Firebase ID token and an official role. Responses use `Cache-Control: no-store`.
- Counts use the canonical `reports` collection, without duplicating linked
  `roadConditions` records. Barangay labels come from `barangays`. Road rankings
  group saved road names/locations and count submissions, including duplicates.
- Status charts keep Verified, Resolved, Pending, Rejected and unknown statuses
  separate. Approval rate includes Verified and Resolved. The selected month is
  a submission cohort; its statuses and recorded durations reflect the latest
  saved state, not historical snapshots of that month.
- Durations use recorded submission/review/verification/resolution timestamps.
  Missing, negative or future intervals are excluded and measured sample counts
  are included. `updatedAt` is never substituted for a missing event timestamp.
  Reports verified on submission can have a real zero-minute verification time.
  Old records with overwritten review times and no distinct verification time
  remain unmeasured. No historical timestamps or live data are rewritten.
- Resolving through this API preserves earlier review/verification times. Retrying
  the same decision preserves event times and avoids another audit entry. Returning
  a report to Pending clears obsolete review and resolution metadata.

Validation: `npm test` builds TypeScript and passes 43 tests, including analytics
calculations, Manila date boundaries, authorization scope, missing data, failed
reads, original-layout presentation values and report timestamp preservation. Fixtures replace Firebase in automated
tests. This source update does not deploy or configure a live server.

The updated website was also exercised in Chromium against these routes with
an in-memory database, including a report decision appearing through the
15-second refresh and matching CSV values.

## Local setup

1. Run `npm ci`.
2. Copy `.env.example` to `.env` and set the project configuration.
3. Set `GOOGLE_APPLICATION_CREDENTIALS` to an absolute path to a Firebase service-account JSON file for `ligtas-d7a4c`. Alternatively, use an existing Application Default Credentials setup or place the key at the ignored `serviceAccountKey.json` path in this repository. Never commit or share the key. See [Firebase Admin setup](https://firebase.google.com/docs/admin/setup).
4. Set `FIREBASE_WEB_API_KEY` from that same project's web-app configuration if using `/auth/login`.
5. Run `npm test`, then `npm run build` and `npm start`, or use `npm run dev`.

The default local address is `http://127.0.0.1:4000`. `GET /health` proves the HTTP process is available; it deliberately does not claim Firebase access. Without administrator credentials, authenticated database operations will not work. The read-only `/test-firestore` diagnostic requires an official's Firebase ID token.

## Relationship to the mobile app

The mobile app at `F:\Ligtas\ligtas-mobile` already signs in using the Firebase client SDK and reads/writes Firestore directly. Configure this backend for the same Firebase project to share those records. The mobile app does not currently call this Express API; downloading and starting this server does not change that architecture.

`POST /auth/login` is currently for LGU web-dashboard access only. Do not replace the resident mobile login with it. For an authorized API request, send a current Firebase ID token as `Authorization: Bearer <token>`; the middleware loads the user's role from Firestore.

Localhost refers to the phone itself when used on a physical phone. Future direct API integration would require an explicit mobile API client plus a reachable server address (and HTTPS outside local development).

## Notification workers

`ENABLE_NOTIFICATION_WORKERS=false` is the default. Leave it disabled during initial setup. Enabling it starts Firestore watchers and can process real queued push notifications. Running this Express worker is separate from deploying the mobile repository's Firebase Functions; do not run both delivery implementations without coordinating their ownership. No billing change or cloud deployment is performed by local setup.

Push delivery still requires valid device tokens, mobile push credentials, and a compatible device build. The current watchers skip existing source records at startup, so offline-period changes require further review before treating notifications as reliable emergency delivery.

## Validation and remaining work

`npm test` builds TypeScript and checks HTTP startup, unauthenticated route rejection, and login input validation without making database writes or sending notifications. It is not a full endpoint/security or mobile integration test.

Before public deployment, review all Admin SDK authorization and data-schema checks: Admin SDK operations bypass mobile Firestore rules. In particular, web-created road reports and review links need compatibility testing against the mobile map; the backup route is still a placeholder. Confirm live database access, then test authorized flows with dedicated accounts before enabling notification delivery.

## Backend reliability update — October 1, 2026

- Temporary Firebase/profile lookup failures return 503; invalid or expired tokens return 401. This prevents a database outage from looking like an expired session.
- Barangay officials need a barangay assignment before official routes can run. LGU administrators retain municipality-wide access.
- Login input is type/length checked and the upstream Firebase sign-in call has a 15-second timeout.
- Reports validate text, document IDs and paired coordinates. Valid latitude/longitude is persisted for map use. Returning a report to Pending or Rejected clears obsolete verification metadata; resolving records a resolvedAt timestamp.
- Draft publishing uses a transaction. Retrying an active/published alert does not overwrite its publish time or write another audit entry. Closed/resolved alerts return 409 rather than becoming active.
- Account creation validates name/password types and official barangay assignments before creating an Auth account. Center registration rejects malformed counts and contact fields.

Validation: TypeScript build and 18 automated tests pass. Tests use mock data for mutation routes. Existing live admin login and a read-only dashboard request both returned HTTP 200. Website source/layout and live records were not changed in this pass. Changes remain local; no GitHub push or public deployment was performed.
