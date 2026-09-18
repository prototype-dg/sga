'use strict';
/* Plane seed: creates workspace/projects/work item types/states/users/webhook.
 * Idempotent-ish: checks existence before create. Admin token + base URL from env. */
const BASE = process.env.PLANE_API_URL || 'http://localhost:8080';
const TOKEN = process.env.PLANE_ADMIN_TOKEN || '';
const WS = process.env.PLANE_WORKSPACE || 'sga';
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, 'X-API-Key': TOKEN };
async function api(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok && r.status !== 400) throw new Error(`PLANE ${method} ${path}: ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json().catch(() => null);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function main() {
  if (!TOKEN) throw new Error('PLANE_ADMIN_TOKEN required (set after first plane boot)');
  await sleep(3000);
  let ws = await api('GET', `/api/v1/workspaces/${WS}/`).catch(() => null);
  if (!ws) ws = await api('POST', '/api/v1/workspaces/', { name: 'SGA Workflow', slug: WS });
  console.log('workspace:', ws && (ws.id || ws.slug));

  const credit = await api('POST', `/api/v1/workspaces/${WS}/projects/`, { name: 'Octroi de Crédit', identifier: 'OCR', description: 'Dossiers de crédit (démo)' });
  const rfc = await api('POST', `/api/v1/workspaces/${WS}/projects/`, { name: 'RFC', identifier: 'RFC', description: 'Changement (démo)' });
  const creditId = credit.id || credit.project_id; const rfcId = rfc.id || rfc.project_id;
  console.log('projects:', creditId, rfcId);

  const OCP_STATES = ['Reçu en agence','Demande en étude','Attente AXA','Questionnaire médical AXA','Retour AXA','Décision','Comité d\'engagement','Validé','Éxécution','EXÉCUTÉ AVEC SUCCÈS','Rejeté'];
  for (const name of OCP_STATES) await api('POST', `/api/v1/workspaces/${WS}/projects/${creditId}/states/`, { name }).catch(() => null);
  for (const name of ['Initié','En cours d\'instruction','Validation sécurité','VALIDÉ','EXÉCUTÉ AVEC SUCCÈS','Rejeté']) await api('POST', `/api/v1/workspaces/${WS}/projects/${rfcId}/states/`, { name }).catch(() => null);
  console.log('states seeded');

  for (const [pid, types] of [[creditId, ['Dossier de crédit']], [rfcId, ['RFC', 'Tâche']]]) {
    for (const t of types) await api('POST', `/api/v1/workspaces/${WS}/projects/${pid}/work-item-types/`, { name: t }).catch(() => null);
  }
  console.log('work item types seeded');

  for (const m of ['k.amrani@demo.andersenlab.com','l.benali@demo.andersenlab.com','n.cherif@demo.andersenlab.com','d.rahmani@demo.andersenlab.com','m.haddad@demo.andersenlab.com']) {
    await api('POST', `/api/v1/workspaces/${WS}/members/invite/`, { emails: [m], role: 15 }).catch(() => null);
  }
  console.log('members invited');

  await api('POST', `/api/v1/workspaces/${WS}/webhooks/`, {
    url: process.env.PLANE_WEBHOOK_URL || 'http://middleware:3000/webhook/plane',
    event_types: ['workitem.created', 'workitem.updated'],
    is_active: true,
  }).catch(e => console.warn('webhook create (may need admin key):', e.message));
  console.log('webhook registered (check output)');
}
main().then(() => console.log('SEED DONE')).catch(e => { console.error('SEED FAIL:', e.message); process.exit(1); });
