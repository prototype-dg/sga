# SGA Demo Stand (Flowable + Plane)

Live demo mirroring Société Générale Algérie's customised Jira (OCP "Octroi de Crédit" and RFC change
management), built from the 2026-09-08 client walkthrough recording. **All data is mock.**

## Components
- **Middleware** (this repo's service): Plane webhook receiver (HMAC), Flowable REST client, Plane
  write-back, loop-guard, REST-ingestion simulator ("mobile app"), and mock externals (AXA, SMS, AD,
  Core DB, Document Generator). Single Node HTTP service — port 3000.
- **Plane CE** (self-hosted): work/case UI. Projects *Octroi de Crédit* + *RFC*, work item types,
  French states, dashboards.
- **Flowable** (open-source engines): OCP CMMN case, RFC BPMN, credit-scoring DMN (`models/`).
- Mock externals all inside the middleware (`/mock/*`).

## Local run
```
cp .env.example .env            # set PLANE_ADMIN_TOKEN after first plane boot
cp plane/plane.env.example plane/plane.env
docker compose up -d
curl -s localhost:3000/healthz   # middleware
node plane/seed/seed.js          # idempotent seed (after plane is up)
```
A full local stack needs ~4 GB RAM (postgres+redis+minio+plane+flowable+middleware).

## Deploy to Azure (GitHub Actions pipeline)
The pipeline deploys the middleware to **Azure Container Apps** with a custom domain. History:
other engagement chats used Azure **Web App Service** for single-container apps; this stand is
multi-container (Plane + Flowable + DBs), so Container Apps is the fit. If you specifically need
Web App Service, the middleware is a plain Node container and can be deployed as one: swap the
`azure/container-apps@` step for `azure/webapps-deploy@v2` — the Dockerfile stays identical.

### Required secrets/vars (GitHub repo settings)
| Name | Value |
|---|---|
| `AZURE_CREDENTIALS` (secret) | Service principal JSON: `az ad sp create-for-rbac --name sga-demo-cicd --role Contributor --scopes /subscriptions/<sub> --sdk-auth` |
| `AZURE_RG` (var) | `sga-demo` |
| `AZURE_ACR` (var) | `sgademoacr` (unique-global) |
| `AZURE_APP` (var) | `sga-demo-stand` |

Then: push to `main` (or `workflow_dispatch`) → pipeline builds + pushes image to ACR → updates the
container app. Monitoring: `az containerapp logs show --name ... -g ...`.

### Domain (sga.andersenlab.com)
1. After first deploy, note the container app FQDN: `az containerapp show -n sga-demo-stand -g sga-demo --query properties.configuration.ingress.fqdn -o tsv`.
2. In the DNS provider for `andersenlab.com`, create a **CNAME**: `sga.andersenlab.com → <fqdn>`
   (plus a TXT `asuid.sga.andersenlab.com` verification value shown by:
   `az containerapp hostname add --hostname sga.andersenlab.com -g sga-demo -n sga-demo-stand`).
3. Bind: `az containerapp hostname bind --hostname sga.andersenlab.com -g sga-demo -n sga-demo-stand`.
4. Certificate (managed): enable via portal > App > TLS/SSL, or
   `az containerapp cert upload --hostname sga.andersenlab.com ...` after binding.

The Plane/Flowable bundle for a full single-webapp demo, and the CMMN/BPMN/DMN model tuning, are the
build phase after the pipeline is green.

## Confidence & provenance
Built from the single 2026-09-08 recording (video, transcript, frames). HIGH/MEDIUM/LOW confidence
markers per claim live in the architecture document (SGA Demo Stand — Solution Architecture &
Walkthrough Script). Nothing here is SGA production data.
