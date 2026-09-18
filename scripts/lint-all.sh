#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/.."
node --check apps/middleware/src/index.js
node --check plane/seed/seed.js
python3 - <<'PY'
import yaml, glob
for f in glob.glob('**/*.yml', recursive=True) + glob.glob('**/*.yaml', recursive=True):
    yaml.safe_load(open(f)); print('yaml ok:', f)
import xml.dom.minidom, glob as g
for f in g.glob('models/**/*', recursive=True):
    if f.endswith(('.cmmn','.bpmn','.dmn')):
        xml.dom.minidom.parse(f)
print('xml ok')
PY
bash -n infra/azure/deploy.sh scripts/*.sh apps/middleware/run-tests.sh
echo "ALL LINT PASSED"
