# 1단계: DAE(COLLADA)의 library_geometries 각 형상 → 꼭짓점의 볼록껍질 점만 저장(475MB 파일도 메모리 적게)
# 실행: python3 pass1_geometry_hulls.py "<파일>.dae" geo.pkl   (필요: pip install lxml scipy numpy)
import sys, numpy as np, pickle
from lxml import etree
from scipy.spatial import ConvexHull
NS = "{http://www.collada.org/2005/11/COLLADASchema}"
path = sys.argv[1]; out = {}
for _, el in etree.iterparse(path, events=("end",), tag=NS + "geometry", huge_tree=True):
    gid = el.get("id"); arrs = []
    for mesh in el.iter(NS + "mesh"):
        vid = None
        v = mesh.find(NS + "vertices")
        if v is not None:
            for inp in v.findall(NS + "input"):
                if inp.get("semantic") == "POSITION": vid = inp.get("source")[1:]
        for src in mesh.findall(NS + "source"):
            if src.get("id") == vid:
                fa = src.find(NS + "float_array")
                arrs.append(np.array(fa.text.split(), dtype=np.float32).reshape(-1, 3))
    if arrs:
        A = np.vstack(arrs)
        if len(A) > 8:
            try: A = A[ConvexHull(A).vertices]
            except Exception: pass
        out[gid] = A
    el.clear()
    while el.getprevious() is not None: del el.getparent()[0]
pickle.dump(out, open(sys.argv[2], "wb"))
print("geoms", len(out), "pts", sum(len(v) for v in out.values()))
