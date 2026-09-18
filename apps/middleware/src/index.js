'use strict';
/* ============================================================
 * SGA Demo Stand — Middleware
 * Thin glue (no business rules):
 *  - Plane webhook receiver (HMAC verify, loop-guard)
 *  - Flowable REST client (start case / complete task)
 *  - Plane REST write-back (state, comment, property)
 *  - "Mobile app" REST ingestion simulator
 *  - Mock external systems (AXA, SMS, AD, Core DB, Doc Generator)
 * All data fictional. Config via env (see .env.example).
 * ============================================================ */
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

const ENV = process.env;
const PORT = Number(ENV.MIDDLEWARE_PORT || 3000);
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
function json(res, code, obj) { const b = JSON.stringify(obj); res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) }); res.end(b); }
function send(res, code, text, ct = 'text/plain') { const b = Buffer.from(text); res.writeHead(code, { 'content-type': ct, 'content-length': b.length }); res.end(b); }

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
async function planeComment(workItemId, projectId, html) {
  return planeApi('POST', `/api/v1/workspaces/${CFG.planeWorkspace}/projects/${projectId}/work-items/${workItemId}/comments/`, { comment_html: `<p>${html}</p>` });
}
async function planeAddAttachment(workItemId, projectId, fileName, content) {
  // store mock attachment as a comment-level link (demo-grade; Plane file upload needs multipart)
  await planeComment(workItemId, projectId, `📎 <b>${fileName}</b> generé par le moteur (document mock)`);
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
async function flowableStartProcess(defKey, vars) {
  return flowableApi('POST', '/service/runtime/process-instances', {
    processDefinitionKey: defKey, variables: Object.entries(vars).map(([name, value]) => ({ name, value })),
  });
}
async function flowableStartCase(defKey, vars) {
  return flowableApi('POST', '/service/cmmn-runtime/case-instances', {
    caseDefinitionKey: defKey, variables: Object.entries(vars).map(([name, value]) => ({ name, value })),
  });
}
async function flowableCompleteTask(taskId, vars = {}) {
  return flowableApi('POST', `/service/runtime/tasks/${taskId}`, {
    action: 'complete',
    variables: Object.entries(vars).map(([name, value]) => ({ name, value })),
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
    'GET /users': (_, u) => ({ users: ['BOUKHAROUBA Y.', 'HEMRI M.', 'NEMRI S.', 'OUALID A.'].filter(n => !u.get('q') || n.toLowerCase().includes(u.get('q').toLowerCase())) }),
    'GET /groups': () => ({ groups: ['CAD', 'ETUDE-CREDIT', 'AGENCE', 'BACK-OFFICE', 'SECURITE', 'DIRECTION'] }),
  },
  db: { 'GET /client/:id': (p) => ({ id: p.id, nom: 'AMINE H.', situation: 'OK', encours: 1250000, plafond: 3500000, risque: 'FAIBLE' }) },
  docgen: {
    'POST /render': (b) => ({ file: `DECISION_${(b.dossier || 'OCR').toUpperCase()}.txt`, content: 'Décision de crédit (MOCK)\n=======================\n' + JSON.stringify(b, null, 2) }),
  },
};
function routeMocks(path, method, body, u, res) {
  const parts = path.replace('/mock/', '').split('/'); // e.g. axa/questionnaire
  const svc = parts[0]; const op = '/' + method + '/' + parts.slice(1).join('/');
  for (const key of Object.keys(mocks[svc] || {})) {
    const pat = new RegExp('^' + key.replace(/:[a-z]+/g, '([^/]+)') + '$', 'i');
    const m = op.match(pat);
    if (m) { const params = {}; [...key.matchAll(/:([a-z]+)/g)].forEach((k, i) => params[k[1]] = m[i + 1]); return json(res, 200, mocks[svc][key](body, u, params)); }
  }
  return json(res, 404, { error: 'mock not found', path });
}

/* ---------------- Plane webhook handling ---------------- */
const seen = new Map(); // idempotency
async function handleWebhook(bodyBuf, signature) {
  const expected = crypto.createHmac('sha256', CFG.webhookSecret).update(bodyBuf).digest('hex');
  if (signature !== expected) throw new Error('bad signature');
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
      const ci = await flowableStartCase('OCP_case', { dossier: title, montant: flat.montant_demande || 0, workItemId: wi.id, projectId: project, actor });
      const firstState = await flowableApi('GET', '/service/cmmn-runtime/case-instances?includeCaseVariables=false&size=1').catch(() => null);
      await planeSetState(wi.id, 'state-demandes-en-etude', project).catch(e => log('write-back state warn', e.message));
      await planeComment(wi.id, project, `Dossier ouvert par le moteur (réf. Flowable <i>${ci.id}</i>) — comportement « post-fonction » natif.`);
      return { ok: true, caseId: ci.id };
    }
    return { ok: true, note: 'not a credit dossier' };
  }
  if (event === 'workitem.updated') {
    const wi = payload.work_item || {};
    // Demo: any user-driven update just logs; state enforcement happens via Flowable task completion from ingest API.
    log('workitem updated', wi.id, wi.state);
    return { ok: true };
  }
  return { ok: true, note: 'event not handled' };
}

/* ---------------- REST ingestion sim ("mobile app") ---------------- */
async function ingestDossier(body) {
  const projectId = CFG.planeCreditProject;
  const wi = await planeCreateWorkItem(projectId, {
    name: body.client ? `Dossier ${body.client.nom || body.client}` : 'Nouveau dossier (app mobile)',
    work_item_type: 'dossier-credit',
    properties: { montant: body.montant, type: body.type || 'CONSO' },
  });
  log('ingest created work item', wi.id);
  return wi;
}

/* ---------------- routes ---------------- */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = u.pathname; const method = req.method;
  try {
    if (method === 'GET' && path === '/healthz') return json(res, 200, { ok: true, ts: Date.now() });
    if (method === 'POST' && path === '/webhook/plane') {
      const body = await readBody(req);
      const sig = (req.headers['x-plane-signature'] || '').trim();
      const out = await handleWebhook(body, sig);
      return json(res, 200, out);
    }
    if (method === 'POST' && path === '/ingest/dossier') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const wi = await ingestDossier(body);
      return json(res, 201, { ok: true, workItem: wi.id });
    }
    if (path.startsWith('/mock/')) return routeMocks(path, method, req.method === 'POST' ? safeJson((await readBody(req)).toString('utf8')) : null, u, res);
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    log('ERROR', path, e.message);
    json(res, 500, { error: e.message });
  }
});
function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
server.listen(PORT, () => log(`middleware listening on :${PORT}`));
