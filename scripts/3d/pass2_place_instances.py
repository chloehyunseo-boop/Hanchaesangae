# 2단계: visual_scene·library_nodes의 배치 행렬을 적용해 실제 위치 점들로 모아요(단위 변환 포함)
# 실행: python3 pass2_place_instances.py "<파일>.dae" geo.pkl <unit_meter(예: 0.0254)> points.npy
import sys, numpy as np, pickle
from lxml import etree
NS = "{http://www.collada.org/2005/11/COLLADASchema}"
geo = pickle.load(open(sys.argv[2], "rb")); unit = float(sys.argv[3])
tree = etree.parse(sys.argv[1], etree.XMLParser(huge_tree=True))
libnodes = {n.get("id"): n for n in tree.iter(NS + "node") if n.getparent().tag == NS + "library_nodes"}
pts = []
def walk(node, M):
    m = node.find(NS + "matrix")
    if m is not None: M = M @ np.array(m.text.split(), dtype=float).reshape(4, 4)
    for ig in node.findall(NS + "instance_geometry"):
        A = geo.get(ig.get("url")[1:])
        if A is not None: pts.append((np.c_[A, np.ones(len(A))] @ M.T)[:, :3])
    for inn in node.findall(NS + "instance_node"):
        ln = libnodes.get(inn.get("url")[1:])
        if ln is not None: walk(ln, M)
    for ch in node.findall(NS + "node"): walk(ch, M)
for n in tree.find(f".//{NS}visual_scene").findall(NS + "node"): walk(n, np.eye(4))
P = np.vstack(pts) * unit
P = P[np.isfinite(P).all(1)]
np.save(sys.argv[4], P.astype(np.float32))
print("pts", len(P), "bbox size m", np.round(P.max(0) - P.min(0), 1))
