# Deploy the LigTAS API to Cloud Run

Use this API with Firebase Hosting as described in `ligtas-web/DEPLOYMENT_FIREBASE.md`.
The included `Dockerfile` builds and starts the Express server. It binds to
`0.0.0.0` and Cloud Run's `PORT` value.

The existing Firebase project is Spark. Cloud Run deployment requires Google
Cloud billing, so enable Blaze and configure a budget alert first. For the low-cost demo configuration, set Cloud Run minimum instances to 0.
The service can scale to zero while idle, so its first request after inactivity
may be slower. Scaling to zero reduces idle compute charges but does not remove
the need for a linked billing account or prevent charges if usage exceeds the
free tier.

Attach a dedicated runtime service account to Cloud Run. Grant Firestore data
access and Firebase Auth administration to that account. The Firebase Admin
SDK will use Cloud Run Application Default Credentials, so do not upload or
commit a service-account key.

Set these runtime variables in Cloud Run:

- `FIREBASE_PROJECT_ID=ligtas-d7a4c`
- `FIREBASE_WEB_API_KEY` from Firebase project settings
- `CORS_ORIGIN` to the Firebase Hosting origin(s)
- `ENABLE_NOTIFICATION_WORKERS=false`

Keep notification workers disabled until push credentials, queue ownership,
and recipient targeting are reviewed. Starting workers can send real resident
notifications. `GET /health` confirms the HTTP process responds; it does not
verify Firestore access.
