# 3단계: 지면(zcut m 이하)을 뺀 점들의 볼록 껍질 = 건물 외피 근사. 지붕(법선 z>0.5)·벽·바닥 면적.
# 실행: python3 pass3_envelope.py points.npy
import sys, numpy as np
from scipy.spatial import ConvexHull
P = np.load(sys.argv[1]).astype(float)
for zcut in [0.5, 2, 4, 6]:
    Q = P[P[:, 2] > zcut]
    h = ConvexHull(Q); tris = Q[h.simplices]
    nrm = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0]); a = 0.5 * np.linalg.norm(nrm, axis=1)
    c = Q[h.vertices].mean(0); s = np.sign(((tris.mean(1) - c) * nrm).sum(1))
    nz = nrm[:, 2] * s / np.maximum(np.linalg.norm(nrm, axis=1), 1e-9)
    print(f"z>{zcut}: size={np.round(Q.max(0)-Q.min(0),1)} roof={a[nz>0.5].sum():.0f} wall={a[np.abs(nz)<=0.5].sum():.0f} bottom={a[nz<-0.5].sum():.0f}")
