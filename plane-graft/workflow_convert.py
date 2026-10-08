# -*- coding: utf-8 -*-
"""Jira OSWorkflow -> BPMN converter (real transformer for the SGA demo).
Usage: python3 workflow_convert.py [in_xml] [out_bpmn]
Emits BPMN 2.0 with a DI section computed by a layered SERPENTINE graph
layout (longest-path layering, boustrophedon row packing, border-clipped
edge waypoints, arc self-loops) - minimal crossings, no box overlap."""
import html
import sys
import xml.etree.ElementTree as ET
from collections import deque

src = sys.argv[1] if len(sys.argv) > 1 else '/opt/sga-agent/OCP_workflow.xml'
out = sys.argv[2] if len(sys.argv) > 2 else '/opt/sga-agent/converted_model.bpmn'
tree = ET.parse(src)
root = tree.getroot()
steps = {s.get('id'): s.get('name') for s in root.iter('step')}
edges = []
for s in root.iter('step'):
    sn = s.get('name')
    for a in s.iter('action'):
        if a.get('name') is None:
            continue
        for res in a.iter('unconditional-result'):
            to = res.get('step')
            if to:
                edges.append((sn, a.get('name'), steps.get(to, to)))
commons = root.find('commons')
if commons is not None:
    common_actions = {a.get('name'): a for a in commons.iter('action')}
    for s in root.iter('step'):
        sn = s.get('name')
        for ref in s.iter('common-action'):
            ca = common_actions.get(ref.get('name'))
            if ca is None:
                continue
            for res in ca.iter('unconditional-result'):
                to = res.get('step')
                if to:
                    edges.append((sn, '[common] ' + ca.get('name'), steps.get(to, to)))
uniq = []
seen = set()
for f, n, t in edges:
    k = (f, n, t)
    if k not in seen:
        seen.add(k)
        uniq.append(k)


def sid(name):
    for k, v in steps.items():
        if v == name:
            return 'task_' + str(k)
    return 'task_x'


def esc(x):
    return html.escape(x or '', quote=True)


names = list(steps.values())
START = 'Demande Re\u00e7ue'
appli = [(f, n, t) for (f, n, t) in uniq if '[APPLI]' in n]
plain = [(f, n, t) for (f, n, t) in uniq if '[APPLI]' not in n]

# ---------------- BPMN elements ----------------
O = []
O.append('<?xml version="1.0" encoding="UTF-8"?>')
O.append('<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:flowable="http://flowable.org/bpmn" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" targetNamespace="http://flowable.org/sga">')
O.append('  <process id="OCP_case" name="Octroi de Credit (migr\u00e9 depuis Jira)">')
O.append('    <startEvent id="start" name="Cr\u00e9ation dossier (APPLI)"/>')
for nm in names:
    O.append('    <userTask id="%s" name="%s" flowable:candidateGroups="SGA-%s"/>' % (sid(nm), esc(nm), esc(nm.split()[0])))
for k, (f, n, t) in enumerate(appli):
    O.append('    <serviceTask id="appli_%d" name="%s" flowable:delegateExpression="${appliBridge}"/>' % (k, esc(n)))
O.append('    <endEvent id="end" name="Fin de parcours"/>')

flows = []          # (fid, a, b) over node ids
seen_pair = set()   # dedupe parallel (a,b) pairs for a clean visual


def flow(a, b, name=None):
    if a == b:
        name = name or None
    key = (a, b)
    if key in seen_pair:
        return
    seen_pair.add(key)
    fid = 'flow_%d' % (len(flows) + 1)
    nm = (' name="%s"' % esc(name)) if name else ''
    O.append('    <sequenceFlow id="%s" sourceRef="%s" targetRef="%s"%s/>' % (fid, a, b, nm))
    flows.append((fid, a, b))


flow('start', sid(START))
for k, (f, n, t) in enumerate(appli):
    flow(sid(f), 'appli_%d' % k, n)
    flow('appli_%d' % k, sid(t))
for (f, n, t) in plain:
    flow(sid(f), sid(t), n if n != 'Create' else None)
outgo = set(f for (f, n, t) in uniq)
for nm in names:
    if nm not in outgo:
        flow(sid(nm), 'end')
O.append('  </process>')

# ---------------- Graph layout (serpentine layered, banded stacking) ----------------
W, H = 180, 80          # task shape size
SW, SH = 36, 36         # event shape size
PER_ROW = 6             # layers per band
SLOT_W, SLOT_H = 250, 112
allnodes = ['start'] + [sid(nm) for nm in names] + ['appli_%d' % k for k in range(len(appli))] + ['end']
adj = {}
for _f, a, b in flows:
    if a != b:
        adj.setdefault(a, []).append(b)
# DFS (iterative) -> drop back-edges for the layering DAG
BACK = set()
state = {n: 0 for n in allnodes}
for rootn in allnodes:
    if state[rootn] != 0:
        continue
    stack = [(rootn, iter(adj.get(rootn, [])))]
    state[rootn] = 1
    while stack:
        u, it = stack[-1]
        advanced = False
        for v in it:
            if state.get(v, 0) == 1:
                BACK.add((u, v))
            elif state.get(v, 0) == 0:
                state[v] = 1
                stack.append((v, iter(adj.get(v, []))))
                advanced = True
                break
        if not advanced:
            state[u] = 2
            stack.pop()
dag_out = {}
indeg = {n: 0 for n in allnodes}
for _f, a, b in flows:
    if a != b and (a, b) not in BACK:
        dag_out.setdefault(a, []).append(b)
        indeg[b] += 1
q = deque([n for n in allnodes if indeg[n] == 0])
layer = {n: 0 for n in allnodes}
while q:
    u = q.popleft()
    for v in dag_out.get(u, []):
        if layer[u] + 1 > layer[v]:
            layer[v] = layer[u] + 1
        indeg[v] -= 1
        if indeg[v] == 0:
            q.append(v)
maxL = max(layer.values())
layers = {}
for n in allnodes:
    layers.setdefault(layer[n], []).append(n)
# barycenter ordering within layers (two sweeps, ties by node id)
order = {L: sorted(v) for L, v in layers.items()}
for _sweep in range(2):
    for L in sorted(order):
        pred_pos = {}
        for pp in order.get(L - 1, []):
            pred_pos[pp] = order[L - 1].index(pp)
        def bary(n):
            ps = [pred_pos[u] for u in adj.get(n, []) if u in pred_pos]
            return (sum(ps) / len(ps), n) if ps else (order[L].index(n), n)
        order[L] = [n for _, n in sorted((bary(n) for n in order[L]), key=lambda t: (t[0], t[1]))]
# coordinates: layers packed in serpentine bands, same-layer nodes stacked vertically
coords = {}
band_y = 70
for band in range((maxL // PER_ROW) + 1):
    band_h = 0
    for L in range(band * PER_ROW, min((band + 1) * PER_ROW, maxL + 1)):
        c0 = L - band * PER_ROW
        c = (PER_ROW - 1 - c0) if band % 2 == 1 else c0
        x = 70 + c * SLOT_W
        for k, n in enumerate(order.get(L, [])):
            w, h = (SW, SH) if n in ('start', 'end') else (W, H)
            dy = (SH // 2 - H // 2) if n in ('start', 'end') else 0
            coords[n] = (x, band_y + k * SLOT_H)
            band_h = max(band_h, k * SLOT_H + (h if n in ('start', 'end') else H) + 30)
    band_y += band_h + 70
size = {n: (SW, SH) if n in ('start', 'end') else (W, H) for n in allnodes}

def clip(cx1, cy1, cx2, cy2, w, h):
    dx, dy = cx2 - cx1, cy2 - cy1
    tx = (w / 2.0) / abs(dx) if dx else 1e9
    ty = (h / 2.0) / abs(dy) if dy else 1e9
    t = min(tx, ty)
    return (int(cx1 + dx * t), int(cy1 + dy * t))


def center(n):
    x, y = coords[n]
    w, h = size[n]
    return (x + w // 2, y + h // 2)
O.append('  <bpmndi:BPMNDiagram id="Diagram_1">')
O.append('    <bpmndi:BPMNPlane id="Plane_1" bpmnElement="OCP_case">')
for n in allnodes:
    x, y = coords[n]
    w, h = size[n]
    O.append('      <bpmndi:BPMNShape id="%s_di" bpmnElement="%s"><dc:Bounds x="%d" y="%d" width="%d" height="%d"/></bpmndi:BPMNShape>' % (n, n, x, y, w, h))
n_self = 0
for fid, a, b in flows:
    if a == b:
        x, y = coords[a]
        w, h = size[a]
        pts = [(x + int(w * 0.72), y), (x + int(w * 0.72), y - 22), (x + int(w * 0.28), y - 22), (x + int(w * 0.28), y)]
        n_self += 1
    else:
        ca, cb = center(a), center(b)
        wa, ha = size[a]
        wb, hb = size[b]
        pts = [clip(ca[0], ca[1], cb[0], cb[1], wa, ha), clip(cb[0], cb[1], ca[0], ca[1], wb, hb)]
    wp = ''.join('<di:waypoint x="%d" y="%d"/>' % p for p in pts)
    O.append('      <bpmndi:BPMNEdge id="%s_di" bpmnElement="%s">%s</bpmndi:BPMNEdge>' % (fid, fid, wp))
O.append('    </bpmndi:BPMNPlane>')
O.append('  </bpmndi:BPMNDiagram>')
O.append('</definitions>')
open(out, 'w', encoding='utf-8').write('\n'.join(O))
maxL = max(layer.values()) + 1
print('converted: %d steps, %d transitions (%d [APPLI]), %d flows (self-loops: %d, layers: %d, rows: %d), serpentine DI ok' % (
    len(names), len(uniq), len(appli), len(flows), n_self, maxL, (maxL + PER_ROW - 1) // PER_ROW))
