'use strict';
const assert=require('node:assert/strict');
const fs=require('fs');
const {variables,pages,graph,transitions,createTools}=require('./process-sync');
const xml=fs.readFileSync(process.argv[2],'utf8');
async function main(){
 assert.deepEqual(variables([{name:'dossierId',value:'a'}]),{dossierId:'a'});
 assert.deepEqual(variables([{variable:{name:'dossierId',value:'historic'}}]),{dossierId:'historic'});
 let calls=0;const rows=await pages(async(_,url)=>{calls++;const start=Number(new URL('http://x'+url).searchParams.get('start'));return {total:205,data:Array.from({length:Math.min(100,205-start)},(_,i)=>({id:start+i}))}},'/history?x=1');assert.equal(rows.length,205);assert.equal(calls,3);
 const g=graph(xml);assert.equal(g.tasks.length,34);assert.ok(g.safe);assert.ok(!graph(xml.replaceAll('selectedFlowId','unsafe')).safe);
 const unique=g.tasks.flatMap(source=>g.tasks.map(target=>({source,target,choices:transitions(g,source.id,target.name)}))).find(x=>x.source.id!==x.target.id&&x.choices.length===1);assert.ok(unique);
 let writeCount=0,taskActive=true;let stateId='old';const wi={id:'dossier',project:'project',name:'test'};
 const other={id:'other-instance',processDefinitionId:'OCP_case:6:x',variables:[{name:'dossierId',value:'someone-else'}]};
 const inst={id:'exact-instance',processDefinitionId:'OCP_case:6:x',variables:[{name:'dossierId',value:'dossier'},{name:'stateId',value:'old'}]};
 const api=async(method,url,body)=>{
   if(method==='POST'){assert.ok(url.includes('exact-task'));assert.equal(taskActive,true);assert.equal(body.variables.find(v=>v.name==='selectedFlowId').value,unique.choices[0].id);taskActive=false;inst.variables.find(v=>v.name==='stateId').value='new';writeCount++;return {};}
   if(url.includes('/resourcedata'))return xml;
   if(url.includes('/process-instances?'))return {data:[other,inst],total:2};
   if(url.includes('/tasks?'))return {data:taskActive?[{id:'exact-task',taskDefinitionKey:unique.source.id}]:[],total:taskActive?1:0};
   throw Error('unexpected '+url);
 };
 const plane=async(_,url)=>url.includes('/states/')?{results:[{id:'old',name:unique.source.name},{id:'new',name:unique.target.name}]}:{...wi,state:stateId};
 const tools=createTools({flowableApi:api,planeApi:plane,CFG:{planeCreditProject:'project',planeWorkspace:'sga'},log:()=>{}});
 assert.equal((await tools.update({activity:{field:'description_html'}},wi)).skipped,'not a state change');assert.equal(writeCount,0);
 stateId='new';const event={activity:{field:'state',old_identifier:'old',new_identifier:'new'}};
 const result=await Promise.all([tools.update(event,wi),tools.update(event,wi),tools.update(event,wi)]);
 assert.equal(result.filter(r=>r.ok).length,1);assert.equal(writeCount,1);assert.ok(result.slice(1).every(r=>r.skipped==='already synchronized'));
 assert.equal((await tools.update({activity:{field:'state',old_identifier:'new',new_identifier:'old'}},wi)).skipped,'stale event: Plane has a different current state');
 console.log(JSON.stringify({passed:true,tests:['variable array normalization','205-row pagination','34-task guarded graph','legacy graph refused','description update no-op','exact dossier/task selection','three concurrent duplicate events -> one completion','stale event refused'],transition:{from:unique.source.name,to:unique.target.name,flow:unique.choices[0].id}}));
}
main().catch(e=>{console.error(e);process.exit(1)});
