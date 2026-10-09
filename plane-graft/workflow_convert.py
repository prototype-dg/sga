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

# ---------------- FR -> EN (names) + system-call classification ----------------
EN_STEP = {
 'Attente AXA': 'Awaiting AXA (insurance)',
 'Demande en étude': 'Application under review',
 'Demande refusée': 'Application refused',
 'Attente décision': 'Awaiting decision',
 'Demande initiée': 'Application initiated',
 'Demande rejetée': 'Application rejected',
 'Attente infos Supp Décisionnaire': 'Awaiting additional info - Decision Maker',
 'Etude en cours': 'Review in progress',
 'Montage à refaire': 'Restructuring required',
 'Attente infos supp BO': 'Awaiting additional info - Back Office',
 'Garanties à recueillir': 'Collaterals to be collected',
 'Garanties reçues': 'Collaterals received',
 'Attente complément': 'Awaiting additional documents',
 'Dossier Constitué': 'Case file assembled',
 'garantie pré-validée': 'Collateral pre-validated',
 'Attente info supp garantie': 'Awaiting additional collateral info',
 'Dossier décaissé': 'Case disbursed',
 'Garantie validée': 'Collateral validated',
 'Demande Reçue': 'Application received',
 'Dérogation demandée': 'Waiver requested',
 'Attente Info Supp DR': 'Awaiting additional info - Regional Directorate',
 'Attente Info Supp RUC': 'Awaiting additional info - RUC',
 'Annulé': 'Cancelled',
 'Dossier à décaisser': 'Case to be disbursed',
 "En cours d'annulation": 'Cancellation in progress',
 'Attente info sup POS/APPLI': 'Awaiting info from POS/APPLI',
 'Demande incomplète': 'Application incomplete',
 'Dossier à contrôler': 'Case to be controlled',
 'Contrôle en cours': 'Control in progress',
 'Contrôle validé': 'Control validated',
 'Dossier à compléter': 'Case to be completed',
 'Dossier soldé': 'Case settled',
 'Dossier décaissé partiellement': 'Case partially disbursed',
 'En attente de signature': 'Awaiting signature',
}
EN_APPLI = {
 '[APPLI] - Attente décision': '[APPLI] - Awaiting decision',
 '[APPLI] - Auto Fournir infos supp APPLI/POS': '[APPLI] - Auto-provide additional APPLI/POS info',
 '[APPLI] - Compléter la demande': '[APPLI] - Complete the application',
 '[APPLI] - Constituer dossier - Demander garanties': '[APPLI] - Assemble case - request collaterals',
 '[APPLI] - Demande refusée': '[APPLI] - Application refused',
 '[APPLI] - Décaisser dossier': '[APPLI] - Disburse case',
 '[APPLI] - Décision': '[APPLI] - Decision',
 '[APPLI] - Défavorable': '[APPLI] - Unfavourable outcome',
 '[APPLI] - Garanties reçues': '[APPLI] - Collaterals received',
 '[APPLI] - Garanties à recueillir': '[APPLI] - Collaterals to be collected',
 '[APPLI] - Soumettre pour décision': '[APPLI] - Submit for decision',
 '[APPLI] - Test TNR APPLI': '[APPLI] - APPLI non-regression test',
}
EXT_APPLI = {'[APPLI] - Constituer dossier - Demander garanties', '[APPLI] - Décaisser dossier', '[APPLI] - Soumettre pour décision'}

# ---------------- BPMN elements ----------------
O = []
O.append('<?xml version="1.0" encoding="UTF-8"?>')
O.append('<definitions xmlns:bioc="http://bpmn.io/schema/bpmn/bioc" xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:flowable="http://flowable.org/bpmn" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" targetNamespace="http://flowable.org/sga">')
O.append('  <process id="OCP_case" name="Octroi de Credit (migr\u00e9 depuis Jira)">')
O.append('    <startEvent id="start" name="Cr\u00e9ation dossier (APPLI)"/>')
for nm in names:
    docu = "FR: " + nm + " - etape manuelle (agent), groupe SGA-" + nm.split()[0] + ", traitement dans Jira. EN: " + EN_STEP.get(nm, nm) + " - manual step (agent), handled in Jira."
    O.append('    <userTask id="%s" name="%s" flowable:candidateGroups="SGA-%s"><documentation>%s</documentation></userTask>' % (sid(nm), esc(nm), esc(nm.split()[0]), esc(docu)))
for k, (f, n, t) in enumerate(appli):
    if n in EXT_APPLI:
        doca = "FR: " + n + " - AUTOMATISATION : appel systeme EXTERNE via bridge appliBridge (middleware, WSO2/REST vers le SI partenaire). EN: " + EN_APPLI.get(n, n) + " - EXTERNAL system call (WSO2/REST to partner SI)."
    else:
        doca = "FR: " + n + " - AUTOMATISATION : operation systeme INTERNE via bridge appliBridge (middleware, SI SGA). EN: " + EN_APPLI.get(n, n) + " - INTERNAL system operation."
    O.append('    <serviceTask id="appli_%d" name="%s" flowable:delegateExpression="${appliBridge}"><documentation>%s</documentation></serviceTask>' % (k, esc(n), esc(doca)))
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
    nattr = (' name="%s"' % esc(name)) if name else ''
    O.append('    <sequenceFlow id="%s" sourceRef="%s" targetRef="%s"%s/>' % (fid, a, b, nattr))
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

# ---------------- Embedded Graphviz layout (computed for the client XML) ----------------
EMBED = {"start": [142, 627], "task_5": [2401, 851], "task_8": [847, 808], "task_9": [1365, 807], "task_10": [1365, 1149], "task_11": [1883, 1502], "task_12": [2401, 1439], "task_13": [1624, 1294], "task_14": [2142, 1584], "task_15": [2401, 1805], "task_16": [2401, 1319], "task_17": [2660, 2379], "task_18": [3178, 2543], "task_19": [3437, 2644], "task_20": [2401, 2278], "task_21": [3696, 2683], "task_22": [3955, 2804], "task_23": [4214, 2480], "task_25": [3955, 2562], "task_26": [329, 605], "task_27": [1624, 1786], "task_28": [1883, 1937], "task_29": [1883, 1786], "task_30": [2142, 2480], "task_31": [4473, 2581], "task_33": [70, 1969], "task_34": [329, 1477], "task_35": [1106, 402], "task_36": [70, 200], "task_37": [329, 200], "task_38": [588, 80], "task_39": [588, 200], "task_40": [70, 30], "task_41": [4732, 2531], "task_42": [1106, 686], "appli_0": [1106, 1048], "appli_1": [1106, 928], "appli_2": [1624, 1092], "appli_3": [2142, 1155], "appli_4": [2660, 829], "appli_5": [2401, 1685], "appli_6": [2919, 2480], "appli_7": [3696, 2461], "appli_8": [588, 808], "appli_9": [588, 402], "appli_10": [2401, 2480], "appli_11": [588, 1111], "end": [401, 52]}
SPLINE = {}

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
for n in allnodes:
    if n.startswith('appli_'):
        size[n] = (220, 100)
if set(EMBED) >= set(allnodes):
    for n in allnodes:
        if n.startswith('appli_'):
            EMBED[n][0] -= 20
            EMBED[n][1] -= 10
if set(EMBED) >= set(allnodes):
    coords = {n: tuple(EMBED[n]) for n in allnodes}

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
BIOCNODE = {}
for k, (f, n, t) in enumerate(appli):
    if n in EXT_APPLI:
        BIOCNODE['appli_%d' % k] = ('#E9041E', '#ff8a96')
    else:
        BIOCNODE['appli_%d' % k] = ('#E9741E', '#ffb266')
for n in allnodes:
    x, y = coords[n]
    w, h = size[n]
    bx = ''
    if n in BIOCNODE:
        bx = ' bioc:fill="%s" bioc:stroke="%s"' % BIOCNODE[n]
    O.append('      <bpmndi:BPMNShape id="%s_di" bpmnElement="%s"%s><dc:Bounds x="%d" y="%d" width="%d" height="%d"/></bpmndi:BPMNShape>' % (n, n, bx, x, y, w, h))
band_ys = {}
for n in allnodes:
    bb = layer[n] // PER_ROW
    x, y = coords[n]
    band_ys.setdefault(bb, [y, y])
    band_ys[bb][0] = min(band_ys[bb][0], y)
    band_ys[bb][1] = max(band_ys[bb][1], y)
chan_top = {bb: band_ys[bb][0] - 30 for bb in band_ys}
chan_bot = {bb: band_ys[bb][1] + 40 for bb in band_ys}
chan_use = {}


def route(a, b):
    ax, ay = coords[a]
    aw, ah = size[a]
    bx, by = coords[b]
    bw, bh = size[b]
    acy = ay + ah // 2
    bcy = by + bh // 2
    if a == b:
        return [(ax + int(aw * 0.72), ay), (ax + int(aw * 0.72), ay - 22), (ax + int(aw * 0.28), ay - 22), (ax + int(aw * 0.28), ay)]
    aband = layer[a] // PER_ROW
    bband = layer[b] // PER_ROW
    ka = order.get(layer[a], []).index(a) if a in order.get(layer[a], []) else 0
    kb = order.get(layer[b], []).index(b) if b in order.get(layer[b], []) else 0
    cid = ('top', aband) if layer[b] >= layer[a] and not (aband == bband and layer[b] < layer[a]) else ('bot', aband)
    i = chan_use.get(cid, 0)
    chan_use[cid] = i + 1
    off = (i % 5) * 8 - 16
    if aband == bband and bx - ax == SLOT_W and bx > ax:
        return [(ax + aw, acy), (bx, bcy)]
    if aband == bband and ax == bx and abs(ka - kb) == 1:
        if by > ay:
            return [(ax + aw // 2, ay + ah), (bx + bw // 2, by)]
        return [(ax + aw // 2, ay), (bx + bw // 2, by + bh)]
    if layer[b] >= layer[a]:
        if aband == bband and bx - ax <= 2 * SLOT_W:
            gx = bx - 34
            return [(ax + aw, acy), (gx, acy), (gx, bcy), (bx, bcy)]
        gut = (chan_top[aband] if aband == bband else chan_bot[min(aband, bband)]) + off
        fx = ax + aw + 34
        gx = bx - 34
        return [(ax + aw, acy), (fx, acy), (fx, gut), (gx, gut), (gx, bcy), (bx, bcy)]
    cb = chan_bot[aband] + off
    lx = ax - 34
    rx = bx + bw + 34
    return [(ax, acy), (lx, acy), (lx, cb), (rx, cb), (rx, bcy), (bx + bw, bcy)]


n_self = 0
for fid, a, b in flows:
    pts = SPLINE.get(fid) or route(a, b)
    if a == b:
        n_self += 1
    wp = ''.join('<di:waypoint x="%d" y="%d"/>' % p2 for p2 in pts)
    O.append('      <bpmndi:BPMNEdge id="%s_di" bpmnElement="%s">%s</bpmndi:BPMNEdge>' % (fid, fid, wp))
O.append('    </bpmndi:BPMNPlane>')
O.append('  </bpmndi:BPMNDiagram>')
O.append('</definitions>')
open(out, 'w', encoding='utf-8').write('\n'.join(O))
maxL = max(layer.values()) + 1
print('converted: %d steps, %d transitions (%d [APPLI]), %d flows (self-loops: %d, layers: %d, rows: %d), serpentine DI ok' % (
    len(names), len(uniq), len(appli), len(flows), n_self, maxL, (maxL + PER_ROW - 1) // PER_ROW))
