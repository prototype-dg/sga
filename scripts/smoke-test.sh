#!/usr/bin/env bash
# Verifies the deployed stand: middleware health, mock endpoints, ingestion, flowable.
set -e
BASE="${BASE_URL:-https://sga-demo-stand.azurecontainerapps.io}"
echo "== healthz ==" ; curl -sf "$BASE/healthz" && echo
echo "== mock AXA ==" ; curl -sf -X POST "$BASE/mock/axa/questionnaire" && echo
echo "== mock AD ==" ; curl -sf "$BASE/mock/ad/users?q=AM" ; echo
echo "== mock DB ==" ; curl -sf "$BASE/mock/db/client/CLT-10042" ; echo
echo "== ingest (mobile app sim) ==" ; curl -sf -X POST "$BASE/ingest/dossier" -H 'Content-Type: application/json' -d '{"montant":2500000,"type":"IMMO"}' ; echo
echo "== flowable reachable =="; curl -sf -u "${FLOWABLE_USER:-rest-admin}:${FLOWABLE_PASS:-test}" "$FLOWABLE_URL/./service/repository/deployments" >/dev/null && echo ok
echo "SMOKE PASSED"
