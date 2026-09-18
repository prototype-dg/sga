# Deploy SGA demo via Azure Portal (manual first deploy)

App already provisioned (by automation) — verify or reuse:

    Web App:  app-sga-demo-stand
    Resource group:  Dima-Gibert-RG
    Plan:  sga-demo-plan (Linux, B1)
    Runtime:  Node 22 LTS
    URL:  https://app-sga-demo-stand.azurewebsites.net
    Kudu:  https://app-sga-demo-stand.scm.azurewebsites.net

## Steps (browser only)

1. Open https://portal.azure.com → App Services → `app-sga-demo-stand`
   (create it if missing: Create → Resource group `Dima-Gibert-RG`, plan `sga-demo-plan`,
   Runtime stack Node 22 LTS, Linux, B1.)

2. Settings → Configuration → General settings → **Startup Command**:
   `node src/index.js`  → Save.

3. Deployment Center → FTPS credentials (tab "FTP") → **App credentials** → Reset/Show:
   note `Username` (format `app-sga-demo-stand\$app-sga-demo-stand`) and `Password`.

4. In a browser open the Kudu ZipDeploy page:
   https://app-sga-demo-stand.scm.azurewebsites.net/ZipDeploy
   → sign in with the App credentials from step 3.

5. **Drag & drop `sga-demo-webapp-deploy.zip`** onto the page.
   Wait for "Deployment successful" (auto-extracts to wwwroot).

6. App Service → Overview → **Restart**.

7. Verify: open https://app-sga-demo-stand.azurewebsites.net/healthz
   → expect `{"ok":true,...}`.

## Endpoints after deploy
- GET /healthz            — health
- POST /webhook/plane     — Plane webhook receiver (HMAC)
- POST /ingest/dossier    — "mobile app" ingestion demo
- /mock/axa/* /mock/sms/* /mock/ad/* /mock/db/* /mock/docgen/* — mock externals

## App settings already present (check/keep)
NODE_ENV=production · PLANE_URL=http://localhost:8080 · FLOWABLE_URL=http://localhost:8081
PLANE_WEBHOOK_SECRET=demo-secret-change-me · (empty PLANE_ADMIN_TOKEN ok) · FLOWABLE_USER/PASS default
