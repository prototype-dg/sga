#!/usr/bin/env bash
# Azure Container Apps provisioning for the SGA demo stand (custom domain sga.andersenlab.com).
# Prereqs: az login (service principal or device code) — see README; env: RG, LOC, ENV, ACR names.
set -euo pipefail
RG="${RG:-sga-demo}"
LOC="${LOC:-westeurope}"
ACA_ENV="${ACA_ENV:-sga-demo-env}"
ACR="${ACR:-sgademoacr}"
APP_NAME="${APP_NAME:-sga-demo-stand}"

az group create --name "$RG" --location "$LOC" --output none
az acr create --resource-group "$RG" --name "$ACR" --sku Basic --admin-enabled true --output none
ACR_USER=$(az acr credential show -n "$ACR" -g "$RG" --query username -o tsv)
ACR_PASS=$(az acr credential show -n "$ACR" -g "$RG" --query 'passwords[0].value' -o tsv)

# Log Analytics workspace for the container app environment
aws_name="$ACA_ENV-logs"
az monitor log-analytics workspace create -g "$RG" -n "$aws_name" -l "$LOC" --output none >/dev/null 2>&1 || true
LAWS=$(az monitor log-analytics workspace show -g "$RG" -n "$aws_name" --query id -o tsv)

az containerapp env create --name "$ACA_ENV" --resource-group "$RG" --location "$LOC" \
  --logs-workspace-id "$LAWS" --output none

# Build + push our own images to ACR
az acr login --name "$ACR" >/dev/null
docker build -t "$ACR.azurecr.io/sga-middleware:latest" apps/middleware
docker push "$ACR.azurecr.io/sga-middleware:latest"

# Deploy the container app (middleware only in ACA; Plane+Flowable run as one bundle container
# for the single-webapp pattern; see README §Deployment for the Plane self-host bundling)
az containerapp create --name "$APP_NAME" --resource-group "$RG" --environment "$ACA_ENV" \
  --image "$ACR.azurecr.io/sga-middleware:latest" \
  --ingress external --target-port 3000 \
  --env-vars PLANE_URL="${PLANE_URL:-http://localhost:8080}" FLOWABLE_URL="${FLOWABLE_URL:-http://localhost:8081}" \
  --output table

echo "=== DEPLOYED ==="
az containerapp show -n "$APP_NAME" -g "$RG" --query properties.configuration.ingress.fqdn -o tsv
echo "Custom domain (once DNS exists): az containerapp hostname bind --hostname sga.andersenlab.com --resource-group $RG --name $APP_NAME --environment $ACA_ENV"
