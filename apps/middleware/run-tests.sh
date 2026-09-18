#!/usr/bin/env bash
# Syntax gate for CI / local pre-commit
set -e
node --check src/index.js
python3 - <<'PY'
import yaml, sys
for f in ['../../docker-compose.yml','../../.github/workflows/deploy.yml']:
    yaml.safe_load(open(f))
print('yaml ok')
PY
echo "lint ok"
