# GLB(glTF 바이너리) 외피 면적: 파일을 통째로 안 올리고 JSON + POSITION 버퍼만 memmap으로 읽어요(메모리 3GB 한계 대응)
# 실행: python3 glb_envelope_lite.py <파일>.glb   (필요: numpy scipy). glTF는 Y축 위·단위 m → Z축 위로 바꿔 계산
import sys, json, struct, numpy as np
from scipy.spatial import ConvexHull
f = open(sys.argv[1], "rb"); magic, ver, total = struct.unpack("<III", f.read(12))
jl, jt = struct.unpack("<II", f.read(8)); J = json.loads(f.read(jl))
binoff = 12 + 8 + jl + 8
mm = np.memmap(sys.argv[1], dtype=np.uint8, mode="r")
def pos(acc_i):
    a = J["accessors"][acc_i]; bv = J["bufferViews"][a["bufferView"]]
    off = binoff + bv.get("byteOffset", 0) + a.get("byteOffset", 0); n = a["count"]; stride = bv.get("byteStride", 12)
    v = np.array(np.ndarray((n, 3), dtype=np.float32, buffer=mm, offset=off, strides=(stride, 4)), dtype=np.float64)
    if len(v) > 8:
        try: v = v[ConvexHull(v).vertices]
        except Exception: pass
    return v
def mat(n):
    if "matrix" in n: return np.array(n["matrix"], dtype=float).reshape(4, 4).T
    T = np.eye(4); t = n.get("translation", [0, 0, 0]); x, y, z, w = n.get("rotation", [0, 0, 0, 1]); s = n.get("scale", [1, 1, 1])
    R = np.array([[1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)], [2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)], [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)]])
    T[:3, :3] = R * np.array(s); T[:3, 3] = t; return T
cache = {}; pts = []
def walk(i, M):
    n = J["nodes"][i]; M = M @ mat(n)
    if "mesh" in n:
        mi = n["mesh"]
        if mi not in cache:
            vs = [pos(p["attributes"]["POSITION"]) for p in J["meshes"][mi]["primitives"] if "POSITION" in p["attributes"]]
            cache[mi] = np.vstack(vs) if vs else np.zeros((0, 3))
        if len(cache[mi]): pts.append((np.c_[cache[mi], np.ones(len(cache[mi]))] @ M.T)[:, :3])
    for c in n.get("children", []): walk(c, M)
for r in J["scenes"][J.get("scene", 0)]["nodes"]: walk(r, np.eye(4))
P = np.vstack(pts); P = P[:, [0, 2, 1]]; P[:, 1] *= -1; P[:, 2] -= np.percentile(P[:, 2], 1)
print("pts", len(P), "size", np.round(P.max(0) - P.min(0), 1))
for zcut in [0.5, 2, 4]:
    Q = P[P[:, 2] > zcut]; h = ConvexHull(Q); tris = Q[h.simplices]
    nrm = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0]); a = 0.5 * np.linalg.norm(nrm, axis=1)
    c = Q[h.vertices].mean(0); s = np.sign(((tris.mean(1) - c) * nrm).sum(1)); nz = nrm[:, 2] * s / np.maximum(np.linalg.norm(nrm, axis=1), 1e-9)
    print(f"z>{zcut}: size={np.round(Q.max(0)-Q.min(0),1)} roof={a[nz>0.5].sum():.0f} wall={a[np.abs(nz)<=0.5].sum():.0f}")
