# LigTAS backend

Express API and optional notification worker for the LigTAS Firebase project.

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
