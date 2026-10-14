#!/usr/bin/env python3
"""Attach migration snapshots only; never replay Jira history or touch existing instances."""
import json,urllib.request,base64,subprocess,xml.etree.ElementTree as ET
BASE='http://localhost:8081/flowable-rest/service'
AUTH='Basic '+base64.b64encode(b'rest-admin:test').decode()
def call(method,path,body=None):
    req=urllib.request.Request(BASE+path,method=method,headers={'Authorization':AUTH,'Content-Type':'application/json'},data=None if body is None else json.dumps(body).encode())
    with urllib.request.urlopen(req,timeout=60) as r:
        data=r.read().decode()
        return json.loads(data) if data and not data.lstrip().startswith('<') else data

def pages(path):
    rows=[]
    for n in range(1000):
        d=call('GET',path+('&' if '?' in path else '?')+'size=100&start='+str(len(rows)))
        rows+=d['data']
        if len(rows)>=d['total']:return rows
        if not d['data']:raise RuntimeError('Incomplete pagination')
    raise RuntimeError('Pagination limit')

def main():
    defs=pages('/repository/process-definitions?key=OCP_case&latest=true')
    if len(defs)!=1:raise RuntimeError('Definition ambiguity')
    definition=defs[0]; xml=call('GET','/repository/process-definitions/'+urllib.parse.quote(definition['id'],safe='')+'/resourcedata')
    if 'initialTask ==' not in xml or 'selectedFlowId ==' not in xml:raise RuntimeError('Unsafe legacy definition')
    root=ET.fromstring(xml);ns={'b':'http://www.omg.org/spec/BPMN/20100524/MODEL'}
    tasks={t.get('name'):t.get('id') for t in root.findall('.//b:userTask',ns)}
    code="from plane.db.models import Issue; import json; p='78437061-9397-42f4-9224-5e3f6b46a7c5'; print('SNAPSHOT_ROWS:'+json.dumps([{'id':str(i.id),'name':i.name,'stateId':str(i.state_id),'state':i.state.name if i.state else None} for i in Issue.objects.filter(project_id=p).exclude(id='f16f4f46-5afa-44cf-8dfc-bb9c9c97083f').select_related('state')]))"
    out=subprocess.run(['sudo','docker','exec','sga-api-1','python','manage.py','shell','-c',code],capture_output=True,text=True,check=True).stdout
    items=json.loads(next(l.split(':',1)[1] for l in out.splitlines() if l.startswith('SNAPSHOT_ROWS:')))
    historical=pages('/history/historic-process-instances?includeProcessVariables=true')
    known={str(v.get('value')) for p in historical for v in p.get('variables',[]) if v.get('name')=='dossierId'}
    created=0; existing=0; unmatched=[]
    for item in items:
        if item['id'] in known:existing+=1;continue
        if item['state'] not in tasks:unmatched.append({'id':item['id'],'state':item['state']});continue
        variables={'dossierId':item['id'],'dossierName':item['name'],'stateId':item['stateId'],'initialTask':tasks[item['state']],'selectedFlowId':'','migrationSnapshot':True,'snapshotSource':'Observed Plane status at migration; no Jira past actions replayed'}
        call('POST','/runtime/process-instances',{'processDefinitionId':definition['id'],'businessKey':item['id'],'variables':[{'name':k,'value':v} for k,v in variables.items()]})
        known.add(item['id']);created+=1
    print(json.dumps({'snapshotsCreated':created,'existingHistoriesPreserved':existing,'unmatched':unmatched,'protectedDossierUntouched':True}))
if __name__=='__main__':main()
