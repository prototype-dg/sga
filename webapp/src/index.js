'use strict';
/* ============================================================
 * SGA Demo Stand — Middleware (v2: landing + mobile sim + reset)
 * Thin glue (no business rules):
 *  - Landing console (GET /) with live status + reset button
 *  - "APPLI SGA" mobile simulator (GET /mobile) — FR, SGA-branded
 *  - Reset demo data (POST /admin/reset): wipes Plane work items
 *    (both projects) + Flowable cases/processes, keeps models/states
 *  - Plane webhook receiver (HMAC verify, loop-guard)
 *  - Flowable REST client (start case / complete task)
 *  - Plane REST write-back (state, comment, property)
 *  - Mock external systems (AXA, SMS, AD, Core DB, Doc Generator)
 * All data fictional. Config via env (see .env.example).
 * ============================================================ */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
process.on('unhandledRejection', e => { try { log('unhandledRejection', (e && e.message) || String(e)); } catch (_) { } });
process.on('uncaughtException', e => { try { log('uncaughtException', (e && e.message) || String(e)); } catch (_) { } });

const ENV = process.env;
const PORT = Number(ENV.PORT || ENV.MIDDLEWARE_PORT || 3000);
const RING = [];
const CFG = {
  planeUrl: ENV.PLANE_URL || 'http://plane-proxy:80',
  planeToken: ENV.PLANE_ADMIN_TOKEN || '',
  planeWorkspace: ENV.PLANE_WORKSPACE || 'sga',
  planeCreditProject: ENV.PLANE_CREDIT_PROJECT || '',
  planeRfcProject: ENV.PLANE_RFC_PROJECT || '',
  webhookSecret: ENV.PLANE_WEBHOOK_SECRET || 'demo-secret-change-me',
  flowableUrl: ENV.FLOWABLE_URL || 'http://flowable:8080',
  flowableUser: ENV.FLOWABLE_USER || 'rest-admin',
  flowablePass: ENV.FLOWABLE_PASS || 'test',
  systemActor: ENV.SYSTEM_MEMBER_ID || '00000000-0000-0000-0000-000000000001',
  planePublicUrl: ENV.PLANE_PUBLIC_URL || 'https://sga-plane.andersenlab.com',
  sourceProperty: 'source', // custom property used for loop-guard
  jiraUrl: ENV.JIRA_URL || 'http://74.162.153.131:8080',
  jiraUser: ENV.JIRA_USER || 'azurea',
  jiraPass: ENV.JIRA_PASS || '',
  jiraProject: ENV.JIRA_PROJECT || 'OCP',
  jiraIssueType: ENV.JIRA_ISSUE_TYPE_ID || '10002',
  agentUrl: ENV.AGENT_URL || 'https://sga-plane.andersenlab.com/agent',
  agentToken: ENV.AGENT_TOKEN || '',
};

/* ---------------- tiny helpers ---------------- */
function log(...a) {
  RING.push('[' + new Date().toISOString() + '] ' + Array.from(arguments).map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' '));
  if (RING.length > 200) RING.shift(); console.log(new Date().toISOString(), ...a); }
function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function json(res, code, obj) { try { res.setHeader('cache-control', 'no-store'); } catch (e) { } const b = JSON.stringify(obj); res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(b) }); res.end(b); }
function send(res, code, text, ct = 'text/plain') { const b = Buffer.from(text); res.writeHead(code, { 'content-type': ct, 'content-length': b.length }); res.end(b); }
function html(res, code, text) { try { res.setHeader('cache-control', 'no-store'); } catch (e) { } return send(res, code, text, 'text/html; charset=utf-8'); }

/* ---------------- HTTP to Plane ---------------- */
async function planeApi(method, path, body) {
  const u = new URL(CFG.planeUrl + path);
  const res = await fetch(u, {
    method, headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CFG.planeToken}`,
      'X-API-Key': CFG.planeToken,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`PLANE ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return text; }
}
async function planeSetState(workItemId, stateId, projectId) {
  return planeApi('PATCH', `/api/v1/workspaces/${CFG.planeWorkspace}/projects/${projectId}/work-items/${workItemId}/`, { state: stateId });
}
async function planeComment(workItemId, projectId, htmlBody) {
  return planeApi('POST', `/api/v1/workspaces/${CFG.planeWorkspace}/projects/${projectId}/work-items/${workItemId}/comments/`, { comment_html: `<p>${htmlBody}</p>` });
}
const stateCache = new Map();
async function planeFirstStateId(projectId, namePrefix) {
  const key = projectId + ':' + namePrefix;
  if (stateCache.has(key)) return stateCache.get(key);
  try {
    const page = await planeApi('GET', `/api/v1/workspaces/${CFG.planeWorkspace}/projects/${projectId}/states/`);
    const hit = (page.results || []).find(st => st.name && st.name.toLowerCase().startsWith(namePrefix.toLowerCase()));
    if (hit) { stateCache.set(key, hit.id); return hit.id; }
  } catch (e) { log('state lookup warn', e.message.slice(0, 100)); }
  return null;
}
async function planeCreateWorkItem(projectId, payload) {
  return planeApi('POST', `/api/v1/workspaces/${CFG.planeWorkspace}/projects/${projectId}/work-items/`, payload);
}

/* ---------------- HTTP to Flowable ---------------- */
async function flowableApi(method, path, body) {
  const u = new URL(CFG.flowableUrl.replace(/\/$/, '') + path);
  const res = await fetch(u, {
    method, headers: {
      'Content-Type': 'application/json',
      Authorization: 'Basic ' + Buffer.from(`${CFG.flowableUser}:${CFG.flowablePass}`).toString('base64'),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`FLOWABLE ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return text; }
}
async function flowableStartCase(defKey, vars) {
  return flowableApi('POST', '/service/cmmn-runtime/case-instances', {
    caseDefinitionKey: defKey, variables: Object.entries(vars).map(([name, value]) => ({ name, value })),
  });
}

/* ---------------- HTTP to Jira (DC 9.12.5) ---------------- */
async function jiraApi(method, path, body) {
  const u = new URL(CFG.jiraUrl + path);
  const res = await fetch(u, {
    method, headers: {
      'Content-Type': 'application/json',
      Authorization: 'Basic ' + Buffer.from(`${CFG.jiraUser}:${CFG.jiraPass}`).toString('base64'),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`JIRA ${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return text; }
}
async function flowableStartProcess(defKey, vars) {
  return flowableApi('POST', '/service/runtime/process-instances', { processDefinitionKey: defKey, variables: Object.entries(vars).map(([name, value]) => ({ name, value })) });
}
let DEMO_DATASET = null;
try { DEMO_DATASET = JSON.parse(fs.readFileSync(path.join(__dirname, 'assets', 'demo-dataset.json'), 'utf8')); log('demo dataset loaded:', (DEMO_DATASET.records || []).length, 'records'); } catch (e) { log('demo dataset NOT loaded:', e.message.slice(0, 100)); }
async function agentRun(id) {
  const r = await fetch(CFG.agentUrl + '/run', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Token': CFG.agentToken }, body: JSON.stringify({ id }) });
  return r.json();
}

async function jiraWipeIssues() {
  let del = 0, start = 0, guard = 0;
  while (guard++ < 40) {
    const sr = await jiraApi('POST', '/rest/api/2/search', { jql: `project = ${CFG.jiraProject}`, maxResults: 50, startAt: 0, fields: ['summary'] });
    const iss = sr.issues || [];
    if (!iss.length) break;
    for (const it of iss) { try { await jiraApi('DELETE', `/rest/api/2/issue/${it.key}`); del++; } catch (e) { } }
  }
  return del;
}
async function jiraSeedDataset(job) {
  const recs = (DEMO_DATASET && DEMO_DATASET.records) || [];
  job.total = recs.length;
  let ok = 0;
  for (const rec of recs) {
    let key = null;
    try {
      const ni = await jiraApi('POST', '/rest/api/2/issue', { fields: { project: { key: CFG.jiraProject }, summary: `Dossier ${rec.demandeur} - ${rec.ref}`, issuetype: { id: CFG.jiraIssueType }, description: `Demo dataset ${rec.ref} | ${rec.produit} | ${rec.montant} DZD | Agence ${rec.agence}` } });
      key = ni.key;
      for (const tname of (rec.path || [])) {
        const tn = String(tname).replace('[common] ', '');
        const trs = await jiraApi('GET', `/rest/api/2/issue/${key}/transitions`);
        const ts = trs.transitions || [];
        const hit = ts.find(t => t.name === tn) || ts.find(t => t.name && t.name.toLowerCase() === tn.toLowerCase());
        if (!hit) throw new Error('transition not offered: ' + tn);
        await jiraApi('POST', `/rest/api/2/issue/${key}/transitions`, { transition: { id: hit.id } });
      }
      rec.jira_key = key; ok++;
    } catch (e) { job.errors.push(`${rec.ref}/${key || '?'}: ${e.message.slice(0, 120)}`); }
    job.done++; job.phase = `re-seeding Jira ${job.done}/${job.total}`;
  }
  return ok;
}

/* ---------------- Mock external systems ---------------- */
const mockDb = require('fs').existsSync('/app/data/clients.json') ? require('/app/data/clients.json') : require('./mock-data.json');
const mocks = {
  axa: {
    'POST /questionnaire': () => ({ status: 'received', ref: 'AXA-' + Date.now().toString().slice(-6) }),
    'GET /status/:ref': () => ({ status: 'in_progress', ref: 'Getting medical review' }),
    'POST /avis': (b) => ({ avis: b.avis || 'favorable', date: new Date().toISOString() }),
  },
  sms: { 'POST /send': (b) => ({ queued: true, to: b.to, text: b.text, log: `SMS → client ${b.to}: ${b.text}` }) },
  ad: {
    'GET /users': (_, u) => ({ users: ['AMINE H.', 'BOUKHAROUBA Y.', 'HEMRI M.', 'NEMRI S.', 'OUALID A.'].filter(n => !(u && u.get && u.get('q')) || n.toLowerCase().includes(u.get('q').toLowerCase())) }),
    'GET /groups': () => ({ groups: ['CAD', 'ETUDE-CREDIT', 'AGENCE', 'BACK-OFFICE', 'SECURITE', 'DIRECTION'] }),
  },
  db: { 'GET /client/:id': (b, u, p) => ({ id: (p && p.id) || 'CLT-10042', nom: 'AMINE H.', situation: 'OK', encours: 1250000, plafond: 3500000, risque: 'FAIBLE' }) },
  docgen: {
    'POST /render': (b) => ({ file: `DECISION_${(b.dossier || 'OCR').toUpperCase()}.txt`, content: 'Décision de crédit (MOCK)\n=======================\n' + JSON.stringify(b, null, 2) }),
  },
};
function routeMocks(pathname, method, body, u, res) {
  const parts = pathname.replace('/mock/', '').split('/');
  const svc = parts[0]; const op = method + ' /' + parts.slice(1).join('/');
  for (const key of Object.keys(mocks[svc] || {})) {
    const pat = new RegExp('^' + key.replace(/:[a-z]+/g, '([^/]+)') + '$', 'i');
    const m = op.match(pat);
    if (m) { const params = {}; [...key.matchAll(/:([a-z]+)/g)].forEach((k, i) => params[k[1]] = m[i + 1]); return json(res, 200, mocks[svc][key](body, u.searchParams, params)); }
  }
  return json(res, 404, { error: 'mock not found', path: pathname });
}

/* ---------------- Plane webhook handling ---------------- */
const seen = new Map(); // idempotency
let MIGRATED = false;        // Inspector shows the migrated model only after a successful workflow migration
let SUPPRESS_WEBHOOK = false; // true during reset / bulk import: seeded + migrated dossiers carry no live case
function findWorkItem(node, depth) {
  if (!node || typeof node !== 'object' || depth > 6) return null;
  if (Array.isArray(node)) { for (let i = 0; i < node.length; i++) { const f = findWorkItem(node[i], depth + 1); if (f) return f; } return null; }
  if (node.id && (node.project_id || node.project) && node.name !== undefined) return node;
  for (const k of Object.keys(node)) { const f = findWorkItem(node[k], depth + 1); if (f) return f; }
  return null;
}
async function handleWebhook(bodyBuf, signature) {
  let body = {};
  try { body = JSON.parse(bodyBuf.toString('utf8') || '{}'); } catch (e) { return { error: 'bad json' }; }
  const expected = crypto.createHmac('sha256', ENV.PLANE_WEBHOOK_SECRET || 'demo-secret-change-me').update(bodyBuf).digest('hex');
  if (signature && signature !== expected) { log('webhook bad signature'); return { error: 'bad signature' }; }
  let ev = body.event || body.event_type || '';
  if (ev === 'issue' && body.action) ev = 'workitem.' + (body.action === 'create' ? 'created' : body.action === 'update' ? 'updated' : body.action === 'delete' ? 'deleted' : body.action);
  log('webhook event', ev);
  if (ev !== 'workitem.created') return { skipped: 'event ' + ev };
  if (SUPPRESS_WEBHOOK) { log('webhook supprime (reset/import en cours)', ev); return { skipped: 'suppressed during reset/import' }; }
  const wi = findWorkItem(body, 0);
  if (!wi) { log('webhook skip: aucun work item dans le payload (keys=' + Object.keys(body).join(',') + ')'); return { skipped: 'no work item in payload' }; }
  const proj = wi.project_id || wi.project || null;
  if (!wi.id) { log('webhook skip: work item partiel (data=' + JSON.stringify(Object.keys(body.data || {})) + ')'); return { skipped: 'no work item in payload' }; }
  log('webhook work item', String(wi.name || wi.id), 'projet', String(proj || '?'));
  if (String(proj) !== String(CFG.planeCreditProject)) { log('webhook skip: autre projet', String(proj)); return { skipped: 'other project' }; }
  let ci = null;
  try {
    ci = await flowableStartProcess('OCP_case', { dossierId: String(wi.id), dossierName: String(wi.name || ''), stateId: String(wi.state_id || '') });
    log('flowable case started', ci.id);
  } catch (e) { log('flowable start failed', e.message.slice(0, 160)); }
  try { await planeComment(wi.id, proj, `Dossier ouvert par le moteur (réf. Flowable <i>${ci ? ci.id : 'n/a'}</i>) — comportement « post-fonction » natif.`); } catch (e) { log('comment warn', e.message.slice(0, 120)); }
  return { ok: true, caseId: ci ? ci.id : null };
}

/* ---------------- REST ingestion (mobile app / API) ---------------- */
async function ingestDossier(body) {
  const projectId = CFG.planeCreditProject;
  const client = body.client || {};
  const nom = client.nom || body.client || 'Client anonyme';
  const type = (body.type || body.produit || 'CONSO').toUpperCase();
  const wi = await planeCreateWorkItem(projectId, {
    name: `Dossier ${nom}`,
    description_html: `<p>Demande de crédit reçue depuis l'application mobile (mock).</p><ul><li>Client : <b>${nom}</b></li><li>Téléphone : ${client.telephone || body.telephone || '—'}</li><li>Produit : ${type}</li><li>Montant : ${body.montant} DZD</li><li>Durée : ${body.duree || '—'} mois</li><li>Agence : ${body.agence || '—'}</li></ul>`,
    work_item_type: 'dossier-credit',
    properties: { montant: body.montant, type, duree_mois: body.duree || null, telephone: client.telephone || body.telephone || null, agence: body.agence || null },
  });
  log('ingest created work item', wi.id);
  return wi;
}

/* ---------------- Reset demo data ---------------- */
/* ---------------- Reset demo data (Plane + Flowable + Jira) ---------------- */
function execPage() {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>SGA — Terminal opérateur</title><style>
*{box-sizing:border-box;margin:0}body{background:#14141a;color:#e8e6e1;font-family:'Montserrat',system-ui,sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:28px 16px}
.wrap{width:100%;max-width:900px}h1{font-size:20px;color:#fff;display:flex;align-items:center;gap:10px}h1 .dot{width:10px;height:10px;border-radius:50%;background:#E9041E;display:inline-block}
.sub{color:#9a9a9a;font-size:12.5px;margin:6px 0 18px}.chips{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px}
.chip{background:#23232c;border:1px solid #3a3a44;color:#e8e6e1;font-size:11.5px;padding:7px 11px;border-radius:6px;cursor:pointer;font-family:inherit}.chip:hover{border-color:#E9041E;color:#fff}.chip.on{background:#E9041E;border-color:#E9041E;color:#fff}
.term{background:#0c0c10;border:1px solid #2a2a33;border-radius:10px;overflow:hidden;box-shadow:0 20px 50px rgba(0,0,0,.5)}
.bar{background:#1b1b22;padding:8px 12px;display:flex;gap:6px;align-items:center}.bar i{width:11px;height:11px;border-radius:50%;display:inline-block}.bar i:nth-child(1){background:#ff5f57}.bar i:nth-child(2){background:#febc2e}.bar i:nth-child(3){background:#28c840}.bar span{margin-left:8px;color:#8a8a8a;font-size:11px}
.out{padding:14px;font:12.5px/1.55 'SF Mono','Fira Code',Consolas,monospace;height:420px;overflow-y:auto;white-space:pre-wrap;word-break:break-word}
.cmd{color:#28c840}.err{color:#ff6b6b}.dim{color:#6f6f78}.exit{color:#febc2e}
.inrow{display:flex;gap:8px;padding:12px;border-top:1px solid #2a2a33;background:#101016}
.prompt{color:#E9041E;font:12.5px 'SF Mono',monospace;padding:9px 0;white-space:nowrap}
input{flex:1;background:#0c0c10;border:1px solid #2a2a33;color:#e8e6e1;font:12.5px 'SF Mono',monospace;padding:8px 10px;border-radius:6px;outline:none}input:focus{border-color:#E9041E}
button{background:#E9041E;color:#fff;border:none;border-radius:6px;padding:8px 18px;font-family:inherit;font-weight:600;cursor:pointer}button:disabled{opacity:.5}
.note{color:#6f6f78;font-size:11px;margin-top:12px}</style></head><body><div class="wrap">
<h1><span class="dot"></span>SGA Demo Stand — Terminal opérateur</h1>
<div class="sub">Exécute les commandes opérateur sur la VM (liste blanche, token-gated) — équivalent web du runbook SSH.</div>
<div class="chips" id="chips"></div>
<div class="term"><div class="bar"><i></i><i></i><i></i><span>operator@sga-demo-stack — zsh</span></div>
<div class="out" id="out"><span class="dim">SGA operator shell — choisissez une commande puis Entrée. Les imports complètent en 30–90 s.</span>
</div><div class="inrow"><span class="prompt">operator@sga:~$</span><input id="inp" placeholder="id de commande (ex: jira-dry)" spellcheck="false"/><button id="run">Run</button></div></div>
<div class="note">Commandes admises : workflow-migrate · jira-dry · jira-import · jira-import-wipe (les trois intègrent la migration du workflow) · docker-ps · flowable-instances · jira-count · plane-count — tout autre id est refusé par l'agent.</div>
</div><script>
var CMDS={'workflow-migrate':'python3 workflow_convert.py — lit le XML du workflow Jira (34 étapes, 122 transitions) et déploie le BPMN converti dans Flowable','jira-dry':'docker exec -w /code sga-api-1 python manage.py jira_import --jira-url http://74.162.153.131:8080 --pat *** --jira-project OCP --plane-project 7843…7c5 --dry-run','jira-import':'docker exec -w /code sga-api-1 python manage.py jira_import --jira-url … --pat *** --jira-project OCP --plane-project 7843…7c5','jira-import-wipe':'workflow-migrate + jira_import --wipe-all (migre le workflow PUIS remplace le contenu du projet)','jira-import-phases':'workflow-migrate + jira_import --wipe-all --phase-board 2 (migre le workflow, remplace le contenu du projet et applique les 7 colonnes du board Jira comme \u00e9tats Plane \u2014 statuts d\u00e9taill\u00e9s conserv\u00e9s en \u00e9tiquettes)','docker-ps':'docker ps --format {{.Names}}\\t{{.Status}}','flowable-instances':"curl -u rest-admin:test http://localhost:8081/flowable-rest/service/runtime/process-instances",'jira-count':"curl -u azurea:*** http://74.162.153.131:8080/rest/api/2/search?jql=project=OCP",'plane-count':'psql: SELECT state, count(*) FROM issues GROUP BY state'};
var out=document.getElementById('out'),inp=document.getElementById('inp'),btn=document.getElementById('run'),chips=document.getElementById('chips');
Object.keys(CMDS).forEach(function(id){var b=document.createElement('button');b.className='chip';b.textContent=id;b.title=CMDS[id];b.onclick=function(){inp.value=id;[].forEach.call(document.querySelectorAll('.chip'),function(c){c.classList.remove('on')});b.classList.add('on')};chips.appendChild(b)});
function line(txt,cls){var s=document.createElement('span');if(cls)s.className=cls;s.textContent=txt+String.fromCharCode(10);out.appendChild(s);out.scrollTop=out.scrollHeight;return s}
inp.addEventListener('keydown',function(e){if(e.key==='Enter')go()});
btn.onclick=go;
function go(){var id=inp.value.trim();if(!id)return;if(!CMDS[id]){line('[agent] commande inconnue: '+id+' (liste blanche refusée)','err');return}
line('operator@sga:~$ '+CMDS[id],'cmd');btn.disabled=true;btn.textContent='…';
fetch('/admin/exec',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id})}).then(function(r){return r.json()}).then(function(d){
 if(d.stdout)line(d.stdout.trim());if(d.stderr)line('[stderr] '+d.stderr.trim(),'err');
 line('[exit '+(d.exit!==undefined?d.exit:'?')+']','exit');
}).catch(function(e){line('[fetch error] '+e,'err')}).finally(function(){btn.disabled=false;btn.textContent='Run'})}
</script></body></html>`;
}

function inspectorPage() {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>SGA — Process Inspector</title>
<script src="/assets/bpmn-viewer.js"></script>
<style>
*{box-sizing:border-box;margin:0}body{background:#14141a;color:#e8e6e1;font-family:'Montserrat',system-ui,sans-serif;padding:20px}
h1{font-size:19px;color:#fff;display:flex;gap:10px;align-items:center}.dot{width:10px;height:10px;border-radius:50%;background:#E9041E}
.sub{color:#9a9a9a;font-size:12px;margin:6px 0 16px}
.grid{display:grid;grid-template-columns:1fr 340px;gap:14px}
.panel{background:#1b1b22;border:1px solid #2a2a33;border-radius:10px;padding:12px;overflow:hidden}
.panel h2{font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:#E9041E;margin-bottom:8px}
#canvas{height:480px;background:#0c0c10;border-radius:8px}
#canvas .bjs-powered-by{display:none}
.tl{max-height:210px;overflow-y:auto;font-size:12px;line-height:1.7}
.tl .t{padding:3px 8px;border-left:2px solid #3a3a44;margin-bottom:2px}
.tl .t.done{border-color:#28c840;color:#cfcfcf}.tl .t.act{border-color:#E9041E;color:#fff;background:rgba(233,4,30,.12);font-weight:600}
.vars{font-size:12px;line-height:1.8}.vars b{color:#febc2e}
.log{font:11px/1.5 'SF Mono',Consolas,monospace;color:#9fd6a0;max-height:200px;overflow-y:auto;white-space:pre-wrap}
select{background:#0c0c10;color:#e8e6e1;border:1px solid #2a2a33;border-radius:6px;padding:6px 8px;font-family:inherit;width:100%}
.btn{background:#E9041E;color:#fff;border:none;border-radius:6px;padding:7px 14px;font-family:inherit;font-weight:600;cursor:pointer;margin-top:8px}
.empty{color:#6f6f78;font-size:12px}
@keyframes pulse{0%,100%{fill-opacity:.55}50%{fill-opacity:.15}}
.bjs-active rect{fill:#E9041E !important;fill-opacity:.4 !important;animation:pulse 1.6s infinite}
.bjs-done rect{fill:#28c840 !important;fill-opacity:.28 !important}
.bjs-done circle{fill:#28c840 !important;fill-opacity:.28 !important}
.bjs-active circle{fill:#E9041E !important;fill-opacity:.4 !important}

.t-auto .djs-label{fill:#fff !important}
.lbl-light .djs-label{fill:#e8e6e1 !important;paint-order:stroke !important;stroke:#0c0c10 !important;stroke-width:3px !important;stroke-linejoin:round !important}
.t-ext .djs-label,.t-ext text.djs-label{fill:#B00016 !important;stroke:none !important;font-size:12px !important;font-weight:700 !important}
.t-int .djs-label,.t-int text.djs-label{fill:#9a4d06 !important;stroke:none !important;font-size:12px !important;font-weight:700 !important}
.t-manual .djs-label,.t-manual text.djs-label{fill:#111 !important;paint-order:stroke !important;stroke:#ffffff !important;stroke-width:2.5px !important}
.lbl-hide{display:none !important}
.zbar{position:absolute;top:10px;right:12px;display:flex;gap:6px;z-index:10}
.zbar button{background:#1b1b22;border:1px solid #3a3a44;color:#e8e6e1;width:30px;height:30px;border-radius:6px;font-size:15px;cursor:pointer;font-family:monospace}
.zbar button:hover{border-color:#E9041E;color:#fff}
.legend{display:flex;gap:14px;align-items:center;color:#9a9a9a;font-size:11px;margin-top:6px}
.legend i{display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:5px;vertical-align:-2px}
.legend i.m{background:#fff}.legend i.a{background:#E9041E}.legend i.i{background:#E9741E}
.djs-connection .djs-visual path{stroke:#b9bec9 !important;stroke-width:1.7px !important}
svg defs marker path{fill:#b9bec9 !important;stroke:#b9bec9 !important}
.edge-name{fill:#e8e6e1 !important;font-size:10px;font-weight:600;font-family:Montserrat,system-ui,sans-serif}
.edge-plate{fill:#14141a;opacity:.92}
</style></head><body>
<h1><span class="dot"></span>SGA Process Inspector — Octroi de Crédit</h1>
<div class="sub"><span style="color:#6f6f78;font-size:10px;border:1px solid #2a2a33;border-radius:4px;padding:1px 6px">build 2026-10-09.5</span> Ce qui se passe DERRIÈRE chaque action : moteur Flowable en direct — étape courante du processus, historique d'exécution, variables du dossier, journal d'appels de la couche d'intégration.</div>
<div class="grid"><div class="card"><span class="eyebrow">Step 1 — The story starts</span><h2>APPLI SGA — mobile simulator</h2><p>Submit a credit application the way a bank customer would, from a phone. The dossier is created in Plane in real time — zero human input on the tool side.</p><a class="btn" href="/mobile target="_blank" rel="noopener">Open the app simulator</a></div><div class="card"><span class="eyebrow">Before migration — the legacy state</span><h2>Jira DC — l'existant à répliquer</h2><p>Réplica Jira Data Center du workflow Octroi de Crédit : 34 étapes, transitions [APPLI], script SIL — et le jeu de démonstration de 100 dossiers (90 % traités, 10 % en cours). C'est cette instance qui sera migrée vers Plane pendant la démo.</p><a class="btn" href="${CFG.jiraUrl}" target="_blank" rel="noopener">Open Jira</a></div><div class="card"><span class="eyebrow">Step 2 — Follow the journey</span><h2>Plane — work tracking</h2><p>The OCR board carries the dossier through the real workflow states; the RFC project shows the same engine carrying IT change requests.</p><a class="btn" href="${CFG.planePublicUrl} target="_blank" rel="noopener">Open Plane</a><span class="meta">Sign-in: d.gibert@andersenlab.com / DemoAdmin123! (change after first login)</span></div><div class="card"><span class="eyebrow">Operator</span><h2>Terminal web</h2><p>Les commandes opérateur du runbook — import Jira → Plane, état des conteneurs, comptages — exécutables depuis le navigateur, en liste blanche sécurisée.</p><a class="btn" href="/terminal target="_blank" rel="noopener">Ouvrir le terminal</a></div><div class="card"><span class="eyebrow">Sous le capot</span><h2>Process Inspector</h2><p>La visualisation Flowable en direct : l'étape courante du processus en rouge sur le modèle BPMN, l'historique d'exécution, les variables du dossier et le journal des appels — ce qui se passe derrière chaque action.</p><a class="btn" href="/inspector target="_blank" rel="noopener">Ouvrir l'inspecteur</a></div></div>
<details class="more"><summary>More components — integration layer &amp; mocks, process models, architecture dossier, demo reset</summary>
<div class="grid"><div class="card"><span class="eyebrow">Under the hood</span><h2>Integration layer &amp; mocks</h2><p>This site is the middleware itself: ingestion API, signed webhooks, Flowable client, and mocked externals — AXA, Active Directory, customer DB, SMS, doc generator.</p><a class="btn ghost" href="/healthz target="_blank" rel="noopener">healthz</a>&nbsp;<a class="btn ghost" href="/mock/db/client/CLT-10042 target="_blank" rel="noopener">mock DB example</a></div><div class="card"><span class="eyebrow">Standards, not scripts</span><h2>Process models (GitHub)</h2><p>The CMMN case, DMN scoring table and RFC BPMN process that execute the demo — readable by business, versioned by Git.</p><a class="btn ghost" href="https://github.com/prototype-dg/sga/blob/main/models/ocp/OCP_case.cmmn target="_blank" rel="noopener">OCP_case.cmmn</a>&nbsp;<a class="btn ghost" href="https://github.com/prototype-dg/sga/blob/main/models/ocp/scoring.dmn target="_blank" rel="noopener">scoring.dmn</a>&nbsp;<a class="btn ghost" href="https://github.com/prototype-dg/sga/blob/main/models/rfc/RFC_process.bpmn target="_blank" rel="noopener">RFC_process.bpmn</a></div><div class="card"><span class="eyebrow">Reference</span><h2>Architecture dossier (PDF)</h2><p>The 19-page walkthrough delivered ahead of this demo: architecture, scenario mapping, migration economics.</p><a class="btn ghost" href="https://www.genspark.ai/api/files/s/DxrWQRCd target="_blank" rel="noopener">Open the dossier</a></div><div class="card danger"><span class="eyebrow">Operator only</span><h2>Reset demo data</h2><p>Wipes Plane work items, Flowable processes and every Jira issue in the OCP project — then re-seeds the full 100-dossier demo dataset (90% completed / 10% in progress) in Jira and the Plane seed dossiers. Runs as a background job — allow 5–10 min. Projects, states, models and mocks are kept.</p><button class="btn" onclick="askReset()">Reset demo data</button><div id="resetOut"></div></div></div>
</details>
</div></div>
span><h2>Reset demo data</h2><p>Wipes Plane work items, Flowable processes and every Jira issue in the OCP project — then re-seeds the full 100-dossier demo dataset (90% completed / 10% in progress) in Jira and the Plane seed dossiers. Runs as a background job — allow 5–10 min. Projects, states, models and mocks are kept.</p><button class="btn" onclick="askReset()">Reset demo data</button><div id="resetOut"></div></div>
</div></div>
<div class="modal" id="modal"><div class="box"><h3>Reset all demo data?</h3><p>This deletes <b>every work item</b> in <i>Octroi de Credit</i> and <i>RFC</i>, all Flowable processes and <b>every Jira issue</b> — then re-seeds the 100-dossier demo dataset (90/10). Runs in the background, allow 5–10 min.</p><div class="row"><button class="btn ghost" style="background:#fff;color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:10px 18px;font-family:Montserrat;font-weight:700" onclick="closeModal()">Cancel</button><button class="btn" onclick="doReset()">Yes, reset everything</button></div></div></div>
<footer>Société Générale Algérie — internal demonstration environment. Every record, client and document shown here is fictional (mock).</footer>
<script>
function askReset(){document.getElementById('modal').classList.add('on')}
function closeModal(){document.getElementById('modal').classList.remove('on')}
async function doReset(){closeModal();const b=document.getElementById('resetOut');b.style.display='block';b.textContent='Reset started — wiping Plane, Flowable and Jira, then re-seeding the 100-dossier dataset (5–10 min)…';
 try{const r=await fetch('/admin/reset',{method:'POST'});if(r.status===409)b.textContent='A reset is already running…';
  const poll=setInterval(async()=>{try{const s=await(await fetch('/admin/reset/status')).json();b.textContent='Phase: '+s.phase+(s.total?('  '+s.done+'/'+s.total):'')+(s.errors.length?(' | Errors: '+s.errors.length):'');if(!s.running){clearInterval(poll);b.textContent='Reset complete. '+JSON.stringify(s.result,null,1);setTimeout(()=>location.reload(),4000)}}catch(e){}},5000);
 }catch(e){b.textContent='Reset failed: '+e}}
</script>
</body></html>`;
}

/* ---------------- Mobile simulator page ---------------- */
function mobilePage() {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>APPLI SGA — Demande de crédit (simulation)</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@600;700;800&family=Source+Sans+3:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{--red:#E9041E;--black:#000;--canvas:#F9F9F9;--grey:#F3F4F5;--body:#5A5A5A;--line:#e6e4e1}
*{box-sizing:border-box;margin:0}
body{min-height:100vh;background:#e8e6e2;display:flex;align-items:center;justify-content:center;font-family:'Source Sans 3',Arial,sans-serif;padding:24px}
.phone{width:390px;max-width:100%;height:820px;background:#fff;border-radius:47px;box-shadow:0 24px 60px rgba(0,0,0,.35),0 0 0 12px #111,0 0 0 14px #3a3a3a;overflow:hidden;position:relative;display:flex;flex-direction:column}
.notch{position:absolute;top:0;left:50%;transform:translateX(-50%);width:150px;height:28px;background:#111;border-radius:0 0 16px 16px;z-index:5}
.statusbar{height:44px;background:#fff;display:flex;justify-content:space-between;align-items:flex-end;padding:0 26px 4px;font-family:Montserrat,Arial,sans-serif;font-size:.72rem;font-weight:700}
.apphead{background:var(--red);color:#fff;padding:14px 20px 16px;display:flex;align-items:center;gap:10px}
.apphead img{height:20px;background:#fff;border-radius:4px;padding:3px}
.apphead .t{font-family:Montserrat,Arial,sans-serif;font-weight:700;font-size:1rem}
.apphead .s{font-size:.72rem;opacity:.85;display:block}
.screen{flex:1;overflow-y:auto;background:var(--canvas);padding:18px 18px 90px}
.eyebrow{font-family:Montserrat,Arial,sans-serif;font-size:.62rem;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--red);margin-bottom:4px}
h1.step{font-family:Montserrat,Arial,sans-serif;font-size:1.3rem;font-weight:800;margin-bottom:2px}
.lead{color:var(--body);font-size:.85rem;margin-bottom:16px}
.field{margin-bottom:13px}
.field label{display:block;font-family:Montserrat,Arial,sans-serif;font-weight:600;font-size:.72rem;margin-bottom:5px}
.field input,.field select{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:8px;font-family:'Source Sans 3',Arial,sans-serif;font-size:.95rem;background:#fff}
.field input:focus,.field select:focus{outline:2px solid var(--red);outline-offset:0;border-color:var(--red)}
.two{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.submit{width:100%;background:var(--red);color:#fff;border:none;border-radius:10px;padding:14px;font-family:Montserrat,Arial,sans-serif;font-weight:700;font-size:.95rem;cursor:pointer}
.submit:disabled{opacity:.6}
.note{font-size:.7rem;color:var(--body);text-align:center;margin-top:10px}
.success{display:none;text-align:center;padding:36px 10px}
.success .check{width:64px;height:64px;border-radius:50%;background:var(--red);color:#fff;font-size:2rem;line-height:64px;margin:0 auto 16px}
.success h2{font-family:Montserrat,Arial,sans-serif;font-size:1.2rem;margin-bottom:6px}
.success p{color:var(--body);font-size:.88rem;margin-bottom:8px}
.success .ref{font-family:'Courier New',monospace;background:var(--grey);border-radius:8px;padding:8px;display:inline-block;margin:8px 0 16px;font-size:.8rem}
.success a,.success button{display:inline-block;background:var(--red);color:#fff;text-decoration:none;border:none;border-radius:8px;padding:11px 18px;font-family:Montserrat,Arial,sans-serif;font-weight:700;font-size:.85rem;cursor:pointer;margin:4px}
.success a.ghost{background:#fff;color:var(--ink);border:1px solid var(--line)}
.tabbar{position:absolute;bottom:0;left:0;right:0;height:78px;background:#fff;border-top:1px solid var(--line);display:flex;justify-content:space-around;align-items:flex-start;padding-top:10px}
.tab{font-family:Montserrat,Arial,sans-serif;font-size:.6rem;font-weight:600;color:#9a9895;text-align:center}
.tab.on{color:var(--red)}
.tab .ic{font-size:1.1rem;display:block;margin-bottom:2px}
</style></head><body>
<div class="phone"><div class="notch"></div>
<div class="statusbar"><span>9:41</span><span>▮▮▮ ▲ ⬤</span></div>
<div class="apphead"><img src="${LOGO_DARK}" alt="SGA"><div><span class="t">APPLI SGA</span><span class="s">Demande de crédit — simulation</span></div></div>
<div class="screen">
  <div id="form">
    <div class="eyebrow">Nouvelle demande</div><h1 class="step">Crédit personnel</h1>
    <p class="lead">Remplissez le formulaire — votre demande sera transmise instantanément à votre agence.</p>
    <div class="field"><label for="f-nom">Nom &amp; prénom *</label><input id="f-nom" type="text" placeholder="ex : AMINE Hakim" required></div>
    <div class="field"><label for="f-tel">Téléphone *</label><input id="f-tel" type="tel" placeholder="ex : +213 6 61 23 45 67" required></div>
    <div class="field"><label for="f-type">Type de crédit *</label><select id="f-type"><option value="IMMO">Immobilier</option><option value="CONSO" selected>Consommation</option><option value="AUTO">Auto</option></select></div>
    <div class="two">
      <div class="field"><label for="f-montant">Montant (DZD) *</label><input id="f-montant" type="number" min="50000" step="50000" value="2500000" required></div>
      <div class="field"><label for="f-duree">Durée (mois) *</label><input id="f-duree" type="number" min="3" max="360" value="120" required></div>
    </div>
    <div class="field"><label for="f-agence">Agence *</label><select id="f-agence"><option>Alger Centre</option><option>Bab Ezzouar</option><option>Oran</option><option>Constantine</option><option>Annaba</option></select></div>
    <button class="submit" id="go" onclick="submitApp()">Soumettre la demande</button>
    <p class="note">Environnement de démonstration — aucune donnée réelle n'est transmise.</p>
  </div>
  <div class="success" id="ok">
    <div class="check">✓</div><h2>Demande enregistrée</h2>
    <p>Votre demande a été transmise à votre agence.<br>Elle apparaît à l'instant dans l'outil de suivi.</p>
    <div class="ref" id="ref"></div><br>
    <a href="${CFG.planePublicUrl}" target="_blank">Voir le tableau (Plane)</a>
    <button class="ghost" onclick="location.reload()">Nouvelle demande</button>
  </div>
</div>
<div class="tabbar"><span class="tab on"><span class="ic">⌂</span>Accueil</span><span class="tab"><span class="ic">▤</span>Demandes</span><span class="tab"><span class="ic">✉</span>Messages</span><span class="tab"><span class="ic">☉</span>Profil</span></div>
</div>
<script>
async function submitApp(){
  const nom=document.getElementById('f-nom').value.trim(), tel=document.getElementById('f-tel').value.trim();
  if(!nom||!tel){alert('Merci de renseigner votre nom et votre téléphone.');return}
  const b={client:{nom:nom,telephone:tel},type:document.getElementById('f-type').value,montant:Number(document.getElementById('f-montant').value),duree:Number(document.getElementById('f-duree').value),agence:document.getElementById('f-agence').value};
  const btn=document.getElementById('go');btn.disabled=true;btn.textContent='Envoi en cours…';
  try{const r=await fetch('/ingest/dossier',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});
    if(!r.ok)throw new Error('HTTP '+r.status);const j=await r.json();
    document.getElementById('ref').textContent='Référence dossier : '+String(j.workItem).slice(0,8).toUpperCase();
    document.getElementById('form').style.display='none';document.getElementById('ok').style.display='block';
  }catch(e){alert("Échec de l'envoi : "+e);btn.disabled=false;btn.textContent='Soumettre la demande'}
}
</script>
</body></html>`;
}

/* ---------------- routes ---------------- */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathName = u.pathname; const method = req.method;
  try {
    if (method === 'GET' && pathName === '/healthz') return json(res, 200, { ok: true, ts: Date.now() });
    if (method === 'GET' && pathName === '/') { const st = await liveStatus(); return html(res, 200, landingPage(st)); }
    if (method === 'GET' && pathName === '/mobile') return html(res, 200, mobilePage());
    if (method === 'GET' && pathName.startsWith('/assets/')) return serveAsset(res, pathName.slice('/assets/'.length));
    if (method === 'POST' && pathName === '/webhook/plane') {
      const body = await readBody(req);
      const sig = (req.headers['x-plane-signature'] || '').trim();
      const out = await handleWebhook(body, sig);
      return json(res, 200, out);
    }
    if (method === 'POST' && pathName === '/ingest/dossier') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const wi = await ingestDossier(body);
      return json(res, 201, { ok: true, workItem: wi.id });
    }
    if (method === 'POST' && pathName === '/admin/reset') {
      if (resetJob.running) return json(res, 409, { error: 'reset already running', job: jobSnap() });
      runResetJob().catch(e => log('reset job error', e.message));
      return json(res, 202, { started: true, job: jobSnap() });
    }
    if (method === 'GET' && pathName === '/admin/reset/status') return json(res, 200, jobSnap());
    if (method === 'POST' && pathName === '/migrate/jira-to-plane') {
      if (migJob.running || resetJob.running) return json(res, 409, { error: 'another job is running' });
      runMigrationJob().catch(e => log('migration job error', e.message));
      return json(res, 202, { started: true, job: migSnap() });
    }
    if (method === 'GET' && pathName === '/migrate/status') return json(res, 200, migSnap());
    if (method === 'GET' && pathName === '/terminal') return html(res, 200, execPage());
    if (method === 'GET' && pathName === '/inspector') return html(res, 200, inspectorPage());
    if (method === 'GET' && pathName === '/inspector/api/model') {
      if (!MIGRATED) {
        try {
          const defs = await flowableApi('GET', '/service/repository/process-definitions?latest=false&size=200');
          if ((defs.data || []).some(x => x.key === 'OCP_case' && (x.version || 0) > 1)) { MIGRATED = true; log('modele migr\u00e9 detect\u00e9 c\u00f4t\u00e9 Flowable (auto)'); }
        } catch (e) { }
        if (!MIGRATED) return json(res, 404, { empty: true, reason: 'Aucun workflow migr\u00e9 \u2014 la migration Jira\u2192BPMN se fait en direct pendant la d\u00e9mo (terminal op\u00e9rateur).' });
      }
      try {
        const r = await fetch(CFG.agentUrl + '/model', { headers: { 'X-Agent-Token': CFG.agentToken } });
        if (r.ok) return send(res, 200, await r.text(), 'application/xml; charset=utf-8');
      } catch (e) { }
      const xml = fs.readFileSync(path.join(__dirname, 'assets', 'OCP_case.bpmn'), 'utf8');
      return send(res, 200, xml, 'application/xml; charset=utf-8');
    }
    if (method === 'GET' && pathName === '/inspector/api/instances') return json(res, 200, await flowableApi('GET', '/service/runtime/process-instances?size=20&includeProcessVariables=true'));
    if (method === 'GET' && pathName.startsWith('/inspector/api/instance/')) {
      const pid = pathName.split('/').pop();
      const [hist, det] = await Promise.all([
        flowableApi('GET', `/service/history/historic-activity-instances?processInstanceId=${pid}`).catch(() => ({ data: [] })),
        flowableApi('GET', `/service/runtime/process-instances/${pid}?includeProcessVariables=true`).catch(() => ({})),
      ]);
      const acts = (hist.data || []).filter(a => a.activityType !== 'sequenceFlow').sort((a, b) => String(a.startTime).localeCompare(String(b.startTime))).map(a => ({ activityId: a.activityId, name: a.activityName, type: a.activityType, start: a.startTime, end: a.endTime }));
      return json(res, 200, { id: pid, activities: acts, variables: det.variables || {} });
    }
    if (method === 'GET' && pathName === '/inspector/api/log') return send(res, 200, RING.slice(-100).join(String.fromCharCode(10)), 'text/plain; charset=utf-8');
    if (method === 'POST' && pathName === '/admin/exec') {
      if (!CFG.agentToken) return json(res, 500, { error: 'agent token not configured' });
      const raw = await new Promise(r2 => { let d = ''; req.on('data', c => d += c); req.on('end', () => r2(d)); });
      let id = null; try { id = JSON.parse(raw || '{}').id; } catch (e) { }
      if (!id) return json(res, 400, { error: 'missing id' });
      const bulk = (id === 'jira-import' || id === 'jira-import-wipe' || id === 'jira-import-phases');
      if (bulk) SUPPRESS_WEBHOOK = true;
      try {
        const out = await agentRun(id);
        if (out && out.exit === 0 && ['workflow-migrate', 'jira-dry', 'jira-import', 'jira-import-wipe', 'jira-import-phases'].indexOf(id) !== -1) MIGRATED = true;
        return json(res, 200, out);
      } catch (e) { return json(res, 502, { error: e.message.slice(0, 160) }); } finally { if (bulk) setTimeout(function () { SUPPRESS_WEBHOOK = false; log('fenetre de suppression webhook fermee (90s)'); }, 90000); }
    }
    if (method === 'GET' && pathName === '/status') return json(res, 200, await liveStatus());
    if (pathName.startsWith('/mock/')) return routeMocks(pathName, method, req.method === 'POST' ? safeJson((await readBody(req)).toString('utf8')) : null, u, res);
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    log('ERROR', pathName, e.message);
    json(res, 500, { error: e.message });
  }
});
function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
server.listen(PORT, () => log(`middleware listening on :${PORT}`));
