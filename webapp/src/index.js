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

const ENV = process.env;
const PORT = Number(ENV.PORT || ENV.MIDDLEWARE_PORT || 3000);
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
};

/* ---------------- tiny helpers ---------------- */
function log(...a) { console.log(new Date().toISOString(), ...a); }
function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function json(res, code, obj) { const b = JSON.stringify(obj); res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(b) }); res.end(b); }
function send(res, code, text, ct = 'text/plain') { const b = Buffer.from(text); res.writeHead(code, { 'content-type': ct, 'content-length': b.length }); res.end(b); }
function html(res, code, text) { return send(res, code, text, 'text/html; charset=utf-8'); }

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
async function handleWebhook(bodyBuf, signature) {
  const expected = crypto.createHmac('sha256', CFG.webhookSecret).update(bodyBuf).digest('hex');
  if (signature && signature !== expected) throw new Error('bad signature');
  const evt = JSON.parse(bodyBuf.toString('utf8'));
  const { event, payload } = evt;
  const actor = evt.actor || payload.actor || '';
  if (actor === CFG.systemActor) { log('loop-guard: system write ignored'); return { skipped: 'system' }; }
  const dedupe = evt.event_id || evt.delivery_id || (event + ':' + (payload.work_item_id || ''));
  if (seen.has(dedupe)) { log('dedupe hit', dedupe); return { skipped: 'duplicate' }; }
  seen.set(dedupe, Date.now()); if (seen.size > 5000) seen.clear();
  log('webhook event', event);
  if (event === 'workitem.created') {
    const wi = payload.work_item || {};
    const project = wi.project_id;
    const title = wi.name || wi.title || 'Dossier';
    const flat = JSON.parse(JSON.stringify(wi, (k, v) => typeof v === 'object' && v !== null ? undefined : v));
    if ((CFG.planeCreditProject && project === CFG.planeCreditProject) || /ocr|credit|dossier/i.test(title)) {
      let ci = { id: 'n/a' };
      try { ci = await flowableStartProcess('OCP_case', { dossier: title, montant: flat.montant_demande || 0, workItemId: wi.id, projectId: project, actor }); } catch (e) { log('flowable unavailable, continuing:', e.message); }
      await planeSetState(wi.id, 'state-demandes-en-etude', project).catch(e => log('write-back state warn', e.message));
      await planeComment(wi.id, project, `Dossier ouvert par le moteur (réf. Flowable <i>${ci.id}</i>) — comportement « post-fonction » natif.`);
      return { ok: true, caseId: ci.id };
    }
    return { ok: true, note: 'not a credit dossier' };
  }
  if (event === 'workitem.updated') {
    const wi = payload.work_item || {};
    log('workitem updated', wi.id, wi.state);
    return { ok: true };
  }
  return { ok: true, note: 'event not handled' };
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
async function resetDemoData() {
  const out = { deletedWorkItems: 0, deletedCases: 0, deletedProcesses: 0, errors: [] };
  const projects = [CFG.planeCreditProject, CFG.planeRfcProject].filter(Boolean);
  for (const pid of projects) {
    try {
      let after = null; let guard = 0;
      while (guard++ < 50) {
        const page = await planeApi('GET', `/api/v1/workspaces/${CFG.planeWorkspace}/projects/${pid}/work-items/?per_page=100${after ? `&cursor=${after}` : ''}`);
        const items = (page.results || page || []);
        if (!Array.isArray(items) || items.length === 0) break;
        for (const wi of items) {
          try { await planeApi('DELETE', `/api/v1/workspaces/${CFG.planeWorkspace}/projects/${pid}/work-items/${wi.id}/`); out.deletedWorkItems++; }
          catch (e) { out.errors.push(`workitem ${wi.id}: ${e.message.slice(0, 120)}`); }
        }
        after = page.next_cursor || null;
        if (!after || page.next_page_results === false) break;
      }
    } catch (e) { out.errors.push(`project ${pid}: ${e.message.slice(0, 160)}`); }
  }
  try {
    const cases = await flowableApi('GET', '/service/cmmn-runtime/case-instances?size=100');
    for (const c of (cases.data || [])) {
      try { await flowableApi('DELETE', `/service/cmmn-runtime/case-instances/${c.id}?cascade=true`); out.deletedCases++; }
      catch (e) { out.errors.push(`case ${c.id}: ${e.message.slice(0, 120)}`); }
    }
  } catch (e) { out.errors.push(`cases list: ${e.message.slice(0, 160)}`); }
  try {
    const procs = await flowableApi('GET', '/service/runtime/process-instances?size=100');
    for (const p of (procs.data || [])) {
      try { await flowableApi('DELETE', `/service/runtime/process-instances/${p.id}?cascade=true`); out.deletedProcesses++; }
      catch (e) { out.errors.push(`proc ${p.id}: ${e.message.slice(0, 120)}`); }
    }
  } catch (e) { out.errors.push(`processes list: ${e.message.slice(0, 160)}`); }
  log('reset done', JSON.stringify(out));
  return out;
}

/* ---------------- Live status ---------------- */
async function liveStatus() {
  const st = { middleware: 'ok', plane: 'down', flowable: 'down', workItems: null };
  try {
    const page = await planeApi('GET', `/api/v1/workspaces/${CFG.planeWorkspace}/projects/${CFG.planeCreditProject}/work-items/?per_page=1`);
    st.plane = 'ok'; st.workItems = page.total_results != null ? page.total_results : ((page.results || []).length);
  } catch (e) { st.plane = 'down: ' + e.message.slice(0, 80); }
  try { await flowableApi('GET', '/service/management/engine'); st.flowable = 'ok'; } catch (e) { st.flowable = 'down: ' + e.message.slice(0, 80); }
  return st;
}

/* ---------------- Static assets ---------------- */
const ASSETS = path.join(__dirname, 'assets');
function serveAsset(res, name) {
  const file = path.join(ASSETS, path.basename(name));
  if (!fs.existsSync(file)) return json(res, 404, { error: 'asset not found' });
  const b = fs.readFileSync(file);
  res.writeHead(200, { 'content-type': name.endsWith('.svg') ? 'image/svg+xml' : 'image/png', 'cache-control': 'public, max-age=3600', 'content-length': b.length });
  res.end(b);
}

/* ---------------- Landing page ---------------- */
const LOGO_DARK = '/assets/logo-dark.png';
const LOGO_LIGHT = '/assets/logo-light.png';
function landingPage(st) {
  const badge = (label, v) => {
    const ok = v === 'ok';
    return `<div class="badge ${ok ? 'ok' : 'bad'}"><span class="dot"></span>${label}: ${String(v).slice(0, 40)}</div>`;
  };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SGA Demo Stand — Credit Origination on Flowable + Plane</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@600;700;800&family=Source+Sans+3:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{--red:#E9041E;--red-deep:#C6361B;--black:#000;--ink:#1c1c1c;--canvas:#F9F9F9;--grey:#F3F4F5;--body:#5A5A5A;--rose:#D9939B;--line:#e6e4e1}
*{box-sizing:border-box;margin:0}
body{font-family:'Source Sans 3',Arial,sans-serif;background:var(--canvas);color:var(--ink);line-height:1.5}
.top{background:#fff;border-bottom:1px solid var(--line)}
.top .in{max-width:1060px;margin:0 auto;padding:14px 24px;display:flex;align-items:center;gap:16px}
.top img{height:34px}
.top .tag{font-family:Montserrat,Arial,sans-serif;font-size:.72rem;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--body)}
.hero{background:var(--black);color:#fff;padding:44px 24px}
.hero .in{max-width:1060px;margin:0 auto}
.hero .rule{width:64px;height:4px;background:var(--red);margin-bottom:18px}
.hero h1{font-family:Montserrat,Arial,sans-serif;font-size:2rem;font-weight:800;line-height:1.2;max-width:640px}
.hero p{color:#d9d6d1;max-width:640px;margin-top:10px;font-size:1.02rem}
.wrap{max-width:1060px;margin:0 auto;padding:28px 24px 60px}
.status{display:flex;flex-wrap:wrap;gap:10px;margin:-26px 0 26px}
.badge{display:inline-flex;align-items:center;gap:8px;background:#fff;border:1px solid var(--line);border-radius:999px;padding:8px 16px;font-family:Montserrat,Arial,sans-serif;font-size:.78rem;font-weight:700;box-shadow:0 2px 8px rgba(0,0,0,.06)}
.badge .dot{width:9px;height:9px;border-radius:50%;background:#1db954}
.badge.bad .dot{background:var(--red)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:18px}
.card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:22px;display:flex;flex-direction:column;gap:10px}
.card .eyebrow{font-family:Montserrat,Arial,sans-serif;font-size:.68rem;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--red)}
.card h2{font-family:Montserrat,Arial,sans-serif;font-size:1.15rem;font-weight:700}
.card p{color:var(--body);font-size:.92rem}
.card a.btn,.card button.btn{margin-top:auto;align-self:flex-start;display:inline-block;background:var(--red);color:#fff;text-decoration:none;border:none;border-radius:8px;padding:10px 18px;font-family:Montserrat,Arial,sans-serif;font-weight:700;font-size:.9rem;cursor:pointer}
.card a.ghost{background:#fff;color:var(--ink);border:1px solid var(--line)}
.card .meta{font-size:.8rem;color:var(--body)}
.danger{border:1px solid #f3c6ca;background:#fff7f7}
.modal{position:fixed;inset:0;background:rgba(0,0,0,.45);display:none;align-items:center;justify-content:center;z-index:50}
.modal.on{display:flex}
.modal .box{background:#fff;border-radius:12px;max-width:430px;width:92%;padding:24px}
.modal h3{font-family:Montserrat,Arial,sans-serif;margin-bottom:8px}
.modal p{color:var(--body);font-size:.9rem}
.modal .row{display:flex;gap:10px;justify-content:flex-end;margin-top:18px}
#resetOut{display:none;margin-top:10px;background:var(--grey);border-radius:8px;padding:10px 12px;font-family:'Courier New',monospace;font-size:.78rem;white-space:pre-wrap}
footer{border-top:1px solid var(--line);background:#fff;padding:18px 24px;text-align:center;color:var(--body);font-size:.8rem}
</style></head><body>
<div class="top"><div class="in"><img src="${LOGO_DARK}" alt="Société Générale Algérie"><span class="tag">Demo Stand · Environment de démonstration</span></div></div>
<div class="hero"><div class="in"><div class="rule"></div><h1>Octroi de Crédit &amp; RFC on Flowable + Plane</h1>
<p>A working replica of the SGA credit-origination journey — mobile submission, insurance round-trip, DMN scoring, credit committee, execution — running live. All data is fictional.</p></div></div>
<div class="wrap">
<div class="status" id="status">${badge('Middleware', st.middleware)}${badge('Plane', st.plane === 'ok' ? 'ok' : st.plane)}${badge('Flowable', st.flowable === 'ok' ? 'ok' : st.flowable)}${st.workItems != null ? `<div class="badge"><span class="dot" style="background:#888"></span>OCR dossiers: ${st.workItems}</div>` : ''}</div>
<div class="grid">
  <div class="card"><span class="eyebrow">Step 1 — The story starts</span><h2>APPLI SGA — mobile simulator</h2><p>Submit a credit application the way a bank customer would, from a phone. The dossier is created in Plane in real time — zero human input on the tool side.</p><a class="btn" href="/mobile">Open the app simulator</a></div>
  <div class="card"><span class="eyebrow">Step 2 — Follow the journey</span><h2>Plane — work tracking</h2><p>The OCR board carries the dossier through the real workflow states; the RFC project shows the same engine carrying IT change requests.</p><a class="btn" href="${CFG.planePublicUrl}">Open Plane</a><span class="meta">Sign-in: d.gibert@andersenlab.com / DemoAdmin123! (change after first login)</span></div>
  <div class="card"><span class="eyebrow">Under the hood</span><h2>Integration layer &amp; mocks</h2><p>This site is the middleware itself: ingestion API, signed webhooks, Flowable client, and mocked externals — AXA, Active Directory, customer DB, SMS, doc generator.</p><a class="btn ghost" href="/healthz">healthz</a>&nbsp;<a class="btn ghost" href="/mock/db/client/CLT-10042">mock DB example</a></div>
  <div class="card"><span class="eyebrow">Standards, not scripts</span><h2>Process models (GitHub)</h2><p>The CMMN case, DMN scoring table and RFC BPMN process that execute the demo — readable by business, versioned by Git.</p><a class="btn ghost" href="https://github.com/prototype-dg/sga/blob/main/models/ocp/OCP_case.cmmn">OCP_case.cmmn</a>&nbsp;<a class="btn ghost" href="https://github.com/prototype-dg/sga/blob/main/models/ocp/scoring.dmn">scoring.dmn</a>&nbsp;<a class="btn ghost" href="https://github.com/prototype-dg/sga/blob/main/models/rfc/RFC_process.bpmn">RFC_process.bpmn</a></div>
  <div class="card"><span class="eyebrow">Reference</span><h2>Architecture dossier (PDF)</h2><p>The 19-page walkthrough delivered ahead of this demo: architecture, scenario mapping, migration economics.</p><a class="btn ghost" href="https://www.genspark.ai/api/files/s/DxrWQRCd">Open the dossier</a></div>
  <div class="card danger"><span class="eyebrow">Operator only</span><h2>Reset demo data</h2><p>Removes every work item and comment from both Plane projects and cascade-deletes all Flowable cases and processes. Projects, states, models and mocks are kept — the stand returns to its initial state.</p><button class="btn" onclick="askReset()">Reset demo data</button><div id="resetOut"></div></div>
</div></div>
<div class="modal" id="modal"><div class="box"><h3>Reset all demo data?</h3><p>This deletes <b>every work item</b> in <i>Octroi de Credit</i> and <i>RFC</i>, and all Flowable cases/processes. There is no undo — but everything can be replayed by re-running the demo.</p><div class="row"><button class="btn ghost" style="background:#fff;color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:10px 18px;font-family:Montserrat;font-weight:700" onclick="closeModal()">Cancel</button><button class="btn" onclick="doReset()">Yes, reset everything</button></div></div></div>
<footer>Société Générale Algérie — internal demonstration environment. Every record, client and document shown here is fictional (mock).</footer>
<script>
function askReset(){document.getElementById('modal').classList.add('on')}
function closeModal(){document.getElementById('modal').classList.remove('on')}
async function doReset(){const b=document.getElementById('resetOut');b.style.display='block';b.textContent='Resetting…';
 try{const r=await fetch('/admin/reset',{method:'POST'});const j=await r.json();b.textContent='Done. '+JSON.stringify(j,null,1);setTimeout(()=>location.reload(),2500)}
 catch(e){b.textContent='Reset failed: '+e}}
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
      const out = await resetDemoData();
      return json(res, 200, out);
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
