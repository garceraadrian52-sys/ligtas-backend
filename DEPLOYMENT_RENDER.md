# Free Render deployment

This repository includes a Render Blueprint in `render.yaml`. It creates a free Node web service from the `balagtas-monitoring` branch and uses `/health` for the health check.

## Deploy the API

1. Sign in to [Render](https://render.com/) and choose **New → Blueprint**.
2. Connect `garceraadrian52-sys/ligtas-backend` and select the `balagtas-monitoring` branch.
3. Review the `ligtas-backend` service and apply the Blueprint.
4. Open the service's **Environment** page. Upload the Firebase Admin service-account JSON under **Secret Files** with the filename `firebase-service-account.json`.
5. Add this environment variable:

   | Key | Value |
   | --- | --- |
   | `GOOGLE_APPLICATION_CREDENTIALS` | `/etc/secrets/firebase-service-account.json` |

6. Set the Blueprint's `FIREBASE_WEB_API_KEY` value using the Web API key from Firebase Console → Project settings → General → your web app. This is the Firebase client API key, not the service-account private key.
7. Save and let Render deploy. Open `https://<your-service>.onrender.com/health`; it should return JSON with `status: "ok"`. This confirms the web process is responding, but does not verify that Firebase credentials can read or write data; verify that separately with an authenticated API request.

Keep the service-account JSON in Render Secret Files only. Do not put it in Git, the Render Blueprint, or this guide. Notification workers are intentionally disabled in the Blueprint to avoid sending messages during initial setup; enable them only after verifying the recipient targeting and push delivery configuration.

## Connect the website

The website is in a separate repository, so deploy it separately in Render with **New → Static Site**. Use the website repository, build command `npm ci && npm run build`, and publish directory `build`. Set this build-time environment variable to the API's Render URL (without a trailing slash):

| Key | Value |
| --- | --- |
| `REACT_APP_API_URL` | `https://<your-service>.onrender.com` |

After the static site has a public URL, set the API's `CORS_ORIGIN` environment variable to the static site's exact origin (for example, `https://your-site.onrender.com`), then redeploy the API. The website is a separate repository and is not deployed by this Blueprint. The static site remains available while the free API may be waking from idle.

## Free-plan behavior

The free API is publicly reachable, but Render spins it down after 15 minutes without inbound traffic. The next request wakes it and can take about a minute. That makes it useful for a free demo/shareable test URL, but it is not an always-awake 24/7 production service. Render's free service also has an ephemeral filesystem, so persistent uploads or local database files must live in Firebase or another external store.

## Local development

This setup does not change local development. Continue using `npm install` and `npm run dev` for the local backend.
