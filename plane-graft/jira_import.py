# -*- coding: utf-8 -*-
"""Non-destructive Jira migration: exact workflow statuses, board ordering and dossier links.
Plane has five fixed state groups, not arbitrary Jira board columns. The source
column is retained as metadata; it is never substituted for the manual status.
"""
import json
import html
import re
import urllib.request
import urllib.parse
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from plane.db.models import Project, State, Issue

CATEGORY = {'new': 'unstarted', 'indeterminate': 'started', 'done': 'completed', 'undefined': 'backlog'}
COLORS = {'backlog':'#A3A3A3','unstarted':'#3A3A3A','started':'#F59E0B','completed':'#16A34A'}

class Command(BaseCommand):
    help = 'Non-destructive Jira migration and exact workflow/board alignment'
    def add_arguments(self, parser):
        parser.add_argument('--jira-url', required=True)
        parser.add_argument('--pat', required=True)
        parser.add_argument('--jira-project', required=True)
        parser.add_argument('--plane-project', required=True)
        parser.add_argument('--jql')
        parser.add_argument('--dry-run', action='store_true')
        parser.add_argument('--wipe-all', action='store_true')
        parser.add_argument('--sync-statuses', action='store_true')
        parser.add_argument('--plane-url', default='https://sga-plane.andersenlab.com')
        parser.add_argument('--inspector-url', default='https://sga.andersenlab.com/inspector')
        parser.add_argument('--mark', action='store_true')
        parser.add_argument('--skip-marked', action='store_true')
        parser.add_argument('--phase-board', type=int)
        parser.add_argument('--board', type=int, default=2)
        parser.add_argument('--align-only', action='store_true')
        parser.add_argument('--protected-dossier', default='f16f4f46-5afa-44cf-8dfc-bb9c9c97083f', help='Never modify the existing user AMINE dossier')
    def jira(self, path, method='GET', body=None):
        req=urllib.request.Request(self.base+path, method=method, data=None if body is None else json.dumps(body).encode(), headers={'Authorization':'Bearer '+self.pat,'Content-Type':'application/json'})
        with urllib.request.urlopen(req,timeout=60) as r:
            raw=r.read()
            return json.loads(raw) if raw else None
    def handle(self,*args,**opts):
        if opts['wipe_all']:
            raise CommandError('Destructive wipe disabled: migration preserves existing dossiers')
        if False and opts['phase_board']:
            raise CommandError('Lossy phase-board mode disabled: retain exact manual statuses, use --board')
        self.base=opts['jira_url'].rstrip('/'); self.pat=opts['pat']
        proj=Project.objects.get(id=opts['plane_project']); ws=proj.workspace
        workflow=self.jira('/rest/api/2/project/'+urllib.parse.quote(opts['jira_project'])+'/statuses')
        statuses={str(s['id']):s for typ in workflow for s in typ['statuses']}
        board=self.jira('/rest/agile/1.0/board/%d/configuration'%opts['board'])
        columns=board['columnConfig']['columns']; mapping={}; ordered=[]
        for column in columns:
            for status in column.get('statuses',[]):
                sid=str(status['id'])
                if sid not in statuses: raise CommandError('Board status absent from project workflow: '+sid)
                if sid in mapping: raise CommandError('Status appears in multiple columns: '+sid)
                mapping[sid]=column['name']; ordered.append(sid)
        ordered += [sid for sid in statuses if sid not in mapping]
        if len({s['name'] for s in statuses.values()}) != len(statuses):
            raise CommandError('Duplicate Jira status names cannot be mapped safely')
        issues=[]; start=0
        jql='project = '+opts['jira_project']
        if opts['jql']: jql+=' AND ('+opts['jql']+')'
        while not opts['align_only']:
            page=self.jira('/rest/api/2/search?'+urllib.parse.urlencode({'jql':jql+' ORDER BY created ASC','maxResults':100,'startAt':start,'fields':'summary,status,description,labels'}))
            batch=page.get('issues',[]); issues.extend(batch); start+=len(batch)
            if start>=page['total']: break
            if not batch: raise CommandError('Jira pagination ended before total')
        plan={'workflowStatuses':len(statuses),'jiraColumns':[c['name'] for c in columns],'sourceIssues':len(issues),'existingDossiers':Issue.objects.filter(project=proj).count(),'planeLimitation':'Five fixed state groups; exact Jira columns retained as state metadata and ordering. No keyword classification.'}
        self.stdout.write(json.dumps(plan,ensure_ascii=False))
        if opts['dry_run']: return
        count=0; linked=0; created=0; skipped=0; state_map={}
        with transaction.atomic():
            # Fail closed before writing if existing names are ambiguous.
            for sid in ordered:
                matches=list(State.objects.filter(project=proj,name=statuses[sid]['name']))
                if len(matches)>1: raise CommandError('Duplicate Plane state: '+statuses[sid]['name'])
            for index,sid in enumerate(ordered):
                source=statuses[sid]; group=CATEGORY.get(source['statusCategory']['key'])
                if not group: raise CommandError('Unknown Jira category: '+source['statusCategory']['key'])
                state=State.objects.filter(project=proj,name=source['name']).first()
                if not state: state=State(workspace=ws,project=proj,name=source['name'])
                state.external_source='jira'; state.external_id=sid; state.group=group; state.sequence=(index+1)*15000
                state.color=COLORS[group]
                state.description=json.dumps({'jiraStatusId':sid,'jiraBoardId':opts['board'],'jiraColumn':mapping.get(sid),'jiraStatusCategory':source['statusCategory']['key']},ensure_ascii=False)
                state.save(); state_map[sid]=state; count+=1
            # Existing dossiers are not moved, rewritten or deleted. Only append the link.
            for item in Issue.objects.filter(project=proj).exclude(id=opts['protected_dossier']):
                url=opts['inspector_url']+'?dossier='+str(item.id)
                if url not in (item.description_html or ''):
                    Issue.objects.filter(id=item.id).update(description_html=(item.description_html or '')+'<p><a href="'+html.escape(url,quote=True)+'" target="_blank" rel="noopener">Process Inspector — étape courante de ce dossier</a></p>')
                    linked+=1
            for source in issues:
                sid=str(source['fields']['status']['id'])
                if sid not in state_map: raise CommandError('Issue status not in validated workflow: '+source['key'])
                existing=list(Issue.objects.filter(project=proj,external_source='jira',external_id=source['key']))
                if not existing:
                    existing=[i for i in Issue.objects.filter(project=proj,description_html__contains=source['key']) if re.search(r'Migr[ée]+ depuis Jira '+re.escape(source['key'])+r'(?:\s|<|—)',i.description_html or '')]
                if len(existing)>1: raise CommandError('Ambiguous existing Jira dossier: '+source['key'])
                if existing:
                    # Preserve the current Plane status even when Jira changed afterwards.
                    Issue.objects.filter(id=existing[0].id).update(external_source='jira',external_id=source['key'])
                    skipped+=1; continue
                text=source['fields'].get('description') or ''
                item=Issue.objects.create(workspace=ws,project=proj,name=source['fields']['summary'],state=state_map[sid],external_source='jira',external_id=source['key'],description_html='<p>'+html.escape(text).replace('\n','<br/>')+'</p><p><i>Migré depuis Jira '+html.escape(source['key'])+' — statut source : '+html.escape(source['fields']['status']['name'])+'</i></p>')
                url=opts['inspector_url']+'?dossier='+str(item.id)
                Issue.objects.filter(id=item.id).update(description_html=item.description_html+'<p><a href="'+html.escape(url,quote=True)+'" target="_blank" rel="noopener">Process Inspector — étape courante de ce dossier</a></p>')
                created+=1; linked+=1
        self.stdout.write(json.dumps({'alignedStatuses':count,'appendedLinks':linked,'createdIssues':created,'preservedIssues':skipped,'extraStatesPreserved':State.objects.filter(project=proj).exclude(id__in=[s.id for s in state_map.values()]).count()},ensure_ascii=False))
