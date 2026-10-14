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
function createTools({flowableApi, planeApi, CFG, log}) {
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
      if (String(project) !== CFG.planeCreditProject) return {skipped:'other project'};
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
      if (!source || !sourceState || source.name !== sourceState.name) return {skipped:'active task does not match source state'};
      const choices = transitions(g, task.taskDefinitionKey, target.name);
      if (choices.length !== 1) return {skipped:'transition absent or ambiguous; explicit Jira action required', choices:choices.map(f => f.name)};
      const eventKey = cryptoHash([wi.id,oldId,newId,task.id].join(':'));
      await flowableApi('POST', '/service/runtime/tasks/' + encodeURIComponent(task.id), {action:'complete', variables:[{name:'selectedFlowId',value:choices[0].id},{name:'stateId',value:String(newId)},{name:'lastPlaneEvent',value:eventKey},{name:'lastPlaneTransition',value:choices[0].name || choices[0].id}]});
      log('dossier synchronized', wi.id, 'instance', inst.id, 'task', task.id, 'flow', choices[0].id);
      return {ok:true, instanceId:inst.id, completedTaskId:task.id, selectedFlowId:choices[0].id};
    });
  }
  return {matches, model, inspect, update, serial};
}
function cryptoHash(s) {return require('crypto').createHash('sha256').update(s).digest('hex');}
module.exports = {variables,pages,graph,transitions,createTools};
