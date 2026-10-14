'use strict';
// Safe Flowable read/synchronization helpers. No writes occur in inspector GETs.
function variables(raw) {
  if (Array.isArray(raw)) return Object.fromEntries(raw.map(entry => { const v = entry.variable || entry; return [v.name, v.value]; }));
  return Object.fromEntries(Object.entries(raw || {}).map(([k,v]) => [k, v && typeof v === 'object' && 'value' in v ? v.value : v]));
}
async function pages(api, url) {
  const all = []; let start = 0;
  for (let page = 0; page < 1000; page++) {
    const r = await api('GET', url + (url.includes('?') ? '&' : '?') + 'size=100&start=' + start);
    const rows = r.data || []; all.push(...rows); start += rows.length;
    if (!rows.length || (r.total != null && start >= r.total) || (r.total == null && rows.length < 100)) return all;
  }
  throw new Error('Flowable pagination safety limit exceeded');
}
function graph(xml) {
  const attrs = s => Object.fromEntries([...s.matchAll(/([\w:]+)="([^"]*)"/g)].map(m => [m[1], m[2].replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&')]));
  const tasks = [...xml.matchAll(/<(?:\w+:)?userTask\b([^>]*)>/g)].map(m => attrs(m[1]));
  const flows = [...xml.matchAll(/<(?:\w+:)?sequenceFlow\b([^>]*)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?sequenceFlow>)/g)].map(m => ({...attrs(m[1]), controlled: (m[2] || '').includes("selectedFlowId == '")}));
  return { tasks, flows, safe: xml.includes('initialTask ==') && flows.filter(f => f.sourceRef.startsWith('task_')).every(f => f.controlled) };
}
function transitions(g, source, targetName) {
  const target = g.tasks.filter(t => t.name === targetName);
  if (target.length !== 1) return [];
  return g.flows.filter(f => f.sourceRef === source).filter(f => f.targetRef === target[0].id || (f.targetRef.startsWith('appli_') && g.flows.some(a => a.sourceRef === f.targetRef && a.targetRef === target[0].id)));
}
function createTools({flowableApi, planeApi, CFG, log, ocrProjectId, stateAlias}) {
  const alias = stateAlias || (n => n);
  const queues = new Map();
  async function serial(key, fn) {
    const prior = queues.get(key) || Promise.resolve();
    const next = prior.catch(() => {}).then(fn); queues.set(key, next);
    try { return await next; } finally { if (queues.get(key) === next) queues.delete(key); }
  }
  async function matches(dossierId, historic=false) {
    const url = historic ? '/service/history/historic-process-instances' : '/service/runtime/process-instances';
    const rows = await pages(flowableApi, url + '?includeProcessVariables=true');
    return rows.filter(p => (p.processDefinitionKey === 'OCP_case' || String(p.processDefinitionId).startsWith('OCP_case:')) && String(variables(p.variables).dossierId || '') === String(dossierId));
  }
  async function model(definitionId) {
    return flowableApi('GET', '/service/repository/process-definitions/' + encodeURIComponent(definitionId) + '/resourcedata');
  }
  async function inspect(pid) {
    const detail = await flowableApi('GET', '/service/history/historic-process-instances/' + encodeURIComponent(pid));
    const [hist, vars, tasks, taskHistory] = await Promise.all([
      pages(flowableApi, '/service/history/historic-activity-instances?processInstanceId=' + encodeURIComponent(pid)),
      pages(flowableApi, '/service/history/historic-variable-instances?processInstanceId=' + encodeURIComponent(pid)),
      detail.endTime ? [] : pages(flowableApi, '/service/runtime/tasks?processInstanceId=' + encodeURIComponent(pid)),
      pages(flowableApi, '/service/history/historic-task-instances?processInstanceId=' + encodeURIComponent(pid)),
    ]);
    const activities = hist.filter(a => a.activityType !== 'sequenceFlow').sort((a,b) => String(a.startTime).localeCompare(String(b.startTime)) || String(a.id).localeCompare(String(b.id))).map(a => {
      const t = taskHistory.find(t => t.id === a.taskId);
      return {id:a.id, activityId:a.activityId, name:a.activityName, type:a.activityType, start:a.startTime, end:a.endTime, durationInMillis:a.durationInMillis, executionId:a.executionId, taskId:a.taskId, assignee:a.assignee || (t && t.assignee), deleteReason:(t && t.deleteReason) || a.deleteReason || null, evidence:a.activityType === 'serviceTask' ? 'Flowable serviceTask completed; demo variable expression only. No external call evidence.' : 'Flowable historic activity'};
    });
    return {id:pid, processDefinitionId:detail.processDefinitionId, completed:!!detail.endTime, deleteReason:detail.deleteReason || null, start:detail.startTime, end:detail.endTime, activities, variables:variables(vars), tasks};
  }
  async function update(body, wi) {
    return serial(String(wi.id), async () => {
      const a = body.activity || {};
      if (!['state','state_id'].includes(a.field)) return {skipped:'not a state change'};
      // The installed Plane model_activity webhook sends UUID values with null identifiers.
      const uuid = x => typeof x === 'string' && /^[a-f0-9-]{36}$/i.test(x);
      const oldId = a.old_identifier || (uuid(a.old_value) ? a.old_value : null);
      const newId = a.new_identifier || (uuid(a.new_value) ? a.new_value : null);
      if (!oldId || !newId || String(oldId) === String(newId)) return {skipped:'state change identifiers missing or unchanged'};
      const project = typeof wi.project === 'object' ? wi.project.id : wi.project_id || wi.project;
      const expectedProject = ocrProjectId ? await ocrProjectId() : CFG.planeCreditProject;
      if (String(project) !== String(expectedProject)) return {skipped:'other project'};
      const item = await planeApi('GET', `/api/v1/workspaces/${CFG.planeWorkspace}/projects/${project}/work-items/${wi.id}/`);
      const current = typeof item.state === 'object' ? item.state.id : item.state_id || item.state;
      if (String(current) !== String(newId)) return {skipped:'stale event: Plane has a different current state'};
      const instances = await matches(wi.id);
      if (instances.length !== 1) return {skipped:'no unique dossier instance', count:instances.length};
      const inst = instances[0]; const v = variables(inst.variables);
      if (String(v.stateId) === String(newId)) return {skipped:'already synchronized'};
      if (String(v.stateId) !== String(oldId)) return {skipped:'source state mismatch; no history fabricated'};
      const states = await planeApi('GET', `/api/v1/workspaces/${CFG.planeWorkspace}/projects/${project}/states/`);
      const target = (Array.isArray(states) ? states : states.results || []).find(s => String(s.id) === String(newId));
      if (!target) return {skipped:'target state unknown'};
      const g = graph(await model(inst.processDefinitionId));
      if (!g.safe) return {skipped:'legacy unguarded workflow; refusing arbitrary advancement'};
      const tasks = await pages(flowableApi, '/service/runtime/tasks?processInstanceId=' + encodeURIComponent(inst.id));
      if (tasks.length !== 1) return {skipped:'ambiguous active tasks', count:tasks.length};
      const task = tasks[0]; const source = g.tasks.find(t => t.id === task.taskDefinitionKey);
      const sourceState = (Array.isArray(states) ? states : states.results || []).find(s => String(s.id) === String(oldId));
      if (!source || !sourceState || (source.name !== sourceState.name && source.name !== alias(sourceState.name))) return {skipped:'active task does not match source state'};
      const targetName = alias(target.name);
      const eventKey = cryptoHash([wi.id,oldId,newId,task.id].join(':'));
      let cur = task; const hops = [];
      while (true) {
        const curInfo = g.tasks.find(t => t.id === cur.taskDefinitionKey);
        if (curInfo && curInfo.name === targetName) {
          if (String(v.stateId) !== String(newId)) { try { await flowableApi('PUT', '/service/runtime/process-instances/' + encodeURIComponent(inst.id) + '/variables/stateId', {value:String(newId)}); } catch (e) {} }
          log('dossier synchronized', wi.id, 'instance', inst.id, 'hops', hops.length);
          return {ok:true, instanceId:inst.id, completedTasks:hops};
        }
        let choices = transitions(g, cur.taskDefinitionKey, targetName);
        if (choices.length !== 1) {
          const fl = bfsFlowPath(g, cur.taskDefinitionKey, targetName);
          if (!fl || !fl.length) return {skipped:'transition absent or ambiguous; explicit Jira action required', from:curInfo && curInfo.name, to:targetName};
          choices = [{id: fl[0], name: fl[0]}];
        }
        const flow = choices[0];
        await flowableApi('POST', '/service/runtime/tasks/' + encodeURIComponent(cur.id), {action:'complete', variables:[{name:'selectedFlowId',value:flow.id},{name:'stateId',value:String(newId)},{name:'lastPlaneEvent',value:eventKey},{name:'lastPlaneTransition',value:flow.name || flow.id}]});
        hops.push(flow.name || flow.id);
        if (hops.length > 8) return {skipped:'advance exceeded 8 hops; stopped to avoid runaway'};
        const nextTasks = await pages(flowableApi, '/service/runtime/tasks?processInstanceId=' + encodeURIComponent(inst.id));
        if (nextTasks.length !== 1) break;
        cur = nextTasks[0];
      }
      log('dossier synchronized (engine parked or ended)', wi.id, 'instance', inst.id, 'hops', hops.length);
      return {ok:true, instanceId:inst.id, completedTasks:hops};
    });
  }
  return {matches, model, inspect, update, serial};
}
function cryptoHash(s) {return require('crypto').createHash('sha256').update(s).digest('hex');}
function bfsFlowPath(g, sourceId, targetName) {
  const target = g.tasks.filter(t => t.name === targetName);
  if (target.length !== 1) return null;
  const tid = target[0].id;
  const isTask = id => g.tasks.some(t => t.id === id);
  const bySource = {};
  for (const f of g.flows) (bySource[f.sourceRef] = bySource[f.sourceRef] || []).push(f);
  const q = [[sourceId, []]]; const seen = new Set([sourceId]); let pop = 0;
  while (q.length && pop++ < 500) {
    const pair = q.shift(); const node = pair[0]; const flows = pair[1];
    for (const f of (bySource[node] || [])) {
      const fl = flows.concat([f.id]);
      let cur = f.targetRef; let guard = 0;
      while (cur && cur !== tid && !isTask(cur) && String(cur).startsWith('appli_') && guard++ < 6) {
        const inner = bySource[cur] || [];
        cur = inner.length === 1 ? inner[0].targetRef : null;
      }
      if (!cur) continue;
      if (cur === tid) return fl;
      if (!seen.has(cur)) { seen.add(cur); q.push([cur, fl]); }
    }
  }
  return null;
}
module.exports = {variables,pages,graph,transitions,bfsFlowPath,createTools};
