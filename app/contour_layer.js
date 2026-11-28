// app/contour_layer.js — 강·중·약 등치선 면 레이어(하린 11/27, 시민·공단·사례 화면 공용).
// shared.js의 CanvasCellLayer(친구 라인)는 25m 칸을 칠한 뒤 통째로 흐려서(blur) 경계가 뿌옇게
// 보여요. 이 레이어는 같은 칸 자료로 강·중·약 단계마다 "경계선이 또렷하고 모양은 부드러운"
// 면(등치선 면)을 그려요. 기상 지도의 구간 표시와 같은 방식이에요.
//
// 방법(새 계산 없음, 그리기만 바꿈):
//  1. 칸을 격자 번호(i, j)로 바꿔 "칸 1개 = 픽셀 1개"짜리 작은 그림(마스크)을 만들어요.
//     단계는 겹쳐 쌓아요: '약' 마스크 = 약 이상인 칸, '중' = 중 이상, '강' = 강.
//  2. 마스크를 한 번 살짝 고르게(3×3 평균) 만들어 계단 모서리를 둥글게 해요.
//  3. 화면 크기로 늘릴 때 브라우저의 부드러운 확대(쌍선형 보간)를 쓰고, 값이 절반 이상인 곳만
//     칠해요 → 칸 경계 중간을 지나는 매끈한 경계선이 생겨요.
//  4. (11/28 회의) 빗금(등급 보류)·점무늬(계산 불가)도 칸 사각형이 아니라 같은 방법으로 만든
//     회색 면 모양 안에만 그려요. 빗금은 연하게, 점무늬와는 구분되게(빗금 = 옅은 바탕 + 가는 사선,
//     점무늬 = 회색 바탕 + 진한 점).

import { CanvasCellLayer } from "./shared.js?v=20261129-5";

const RANK = { 약: 1, 중: 2, 강: 3 };
const HATCH_FILL = "rgba(120,120,120,0.16)"; // 빗금 구역 바탕(연하게)
const HATCH_LINE = "rgba(70,78,90,0.42)";    // 하한 단계가 없을 때 빗금 선
const DOT_COLOR = "rgba(55,60,70,0.62)";

function parseRgba(str) {
  const m = String(str).match(/rgba?\(([^)]+)\)/);
  if (!m) return [128, 128, 128, 255];
  const p = m[1].split(",").map((x) => Number(x.trim()));
  return [p[0], p[1], p[2], Math.round((p[3] ?? 1) * 255)];
}

export const ContourCellLayer = CanvasCellLayer.extend({
  _redraw() {
    // 원래 레이어가 칸 칠 + 빗금·점무늬를 그리게 한 다음, 둘 다 지우고 면 모양으로 다시 그려요.
    CanvasCellLayer.prototype._redraw.call(this);
    if (!this._map || !this._fillCanvas) return;
    const fc = this._fillCanvas, oc = this._overlayCanvas;
    fc.style.filter = "none";
    const W = fc.width, H = fc.height;
    if (!W || !H) return;
    const fctx = fc.getContext("2d");
    fctx.clearRect(0, 0, W, H);
    const octx = oc?.getContext("2d");
    if (octx) { oc.style.filter = "none"; octx.clearRect(0, 0, W, H); }

    // 1) 칸 → 격자 번호
    const items = [];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const cell of this._cells) {
      const st = this._styleFor(cell);
      if (!st) continue;
      let cls;
      if (st.hatch) cls = `hatch|${st.hatchColor ?? HATCH_LINE}`;
      else if (st.dotted) cls = "dots";
      else cls = cell.level;
      if (!cls) continue;
      items.push({ x: cell.x, y: cell.y, cls });
      if (cell.x < minX) minX = cell.x; if (cell.x > maxX) maxX = cell.x;
      if (cell.y < minY) minY = cell.y; if (cell.y > maxY) maxY = cell.y;
    }
    if (!items.length) return;
    const dx = this._halfLonDeg * 2, dy = this._halfLatDeg * 2;
    const PAD = 2;
    const gw = Math.round((maxX - minX) / dx) + 1 + PAD * 2;
    const gh = Math.round((maxY - minY) / dy) + 1 + PAD * 2;
    if (gw * gh > 4e6) return; // 비정상적으로 큰 격자 방어

    const masks = new Map(); // key → Float32Array
    const maskFor = (key) => { if (!masks.has(key)) masks.set(key, new Float32Array(gw * gh)); return masks.get(key); };
    for (const it of items) {
      const k = (Math.round((maxY - it.y) / dy) + PAD) * gw + Math.round((it.x - minX) / dx) + PAD;
      if (it.cls === "dots" || it.cls.startsWith("hatch|")) { maskFor(it.cls)[k] = 1; continue; }
      const r = RANK[it.cls] ?? 0;
      if (r >= 1) maskFor("약")[k] = 1;
      if (r >= 2) maskFor("중")[k] = 1;
      if (r >= 3) maskFor("강")[k] = 1;
    }

    // 화면에서 격자가 놓일 자리(첫 칸 중심 ~ 마지막 칸 중심을 픽셀 중심에 맞춤)
    const p0 = this._map.latLngToContainerPoint([maxY + dy * PAD, minX - dx * PAD]);
    const p1 = this._map.latLngToContainerPoint([maxY - dy * (gh - 1 - PAD), minX + dx * (gw - 1 - PAD)]);
    const pxW = (p1.x - p0.x) / (gw - 1), pxH = (p1.y - p0.y) / (gh - 1);
    const left = p0.x - pxW / 2, top = p0.y - pxH / 2, sw = pxW * gw, sh = pxH * gh;

    const small = document.createElement("canvas");
    small.width = gw; small.height = gh;
    const sctx = small.getContext("2d");
    const big = document.createElement("canvas");
    big.width = W; big.height = H;
    const bctx = big.getContext("2d");
    bctx.imageSmoothingEnabled = true;
    bctx.imageSmoothingQuality = "high";

    // 마스크 → 화면 크기 알파(0~255). 2) 3×3 평균 → 3) 부드럽게 늘리기
    const upscale = (m) => {
      const sm = new Float32Array(gw * gh);
      for (let y = 1; y < gh - 1; y++) for (let x = 1; x < gw - 1; x++) {
        let s = 0;
        for (let yy = -1; yy <= 1; yy++) for (let xx = -1; xx <= 1; xx++) s += m[(y + yy) * gw + x + xx];
        // 원래 칸은 절반 이상으로 남게(외딴 칸 하나도 사라지지 않게), 바깥 칸은 이웃이 많을 때만 살짝 채움
        sm[y * gw + x] = m[y * gw + x] ? Math.max(0.6, (s + 4) / 13) : (s / 13) * 0.9;
      }
      const img = sctx.createImageData(gw, gh);
      for (let q = 0; q < sm.length; q++) img.data[q * 4 + 3] = Math.round(sm[q] * 255);
      sctx.putImageData(img, 0, 0);
      bctx.clearRect(0, 0, W, H);
      bctx.drawImage(small, left, top, sw, sh);
      return bctx.getImageData(0, 0, W, H).data;
    };
    const hasAny = (m) => { for (let q = 0; q < m.length; q++) if (m[q]) return true; return false; };

    const palette = this.options.palette;
    const out = fctx.getImageData(0, 0, W, H);
    const od = out.data;
    const owner = new Int16Array(W * H).fill(-1); // 픽셀마다 마지막으로 칠한 구역(무늬는 자기 구역 안에만 그리려고)
    const paint = (bd, color, cut = 128, id = -2) => {
      const [r, g, b, a] = parseRgba(color);
      for (let q = 3; q < bd.length; q += 4) if (bd[q] >= cut) { od[q - 3] = r; od[q - 2] = g; od[q - 1] = b; od[q] = a; owner[(q - 3) >> 2] = id; }
    };
    // 무늬 구역은 기준을 조금 낮춰(조금 넓게) 칠해요 — 색 구역과 각각 부드럽게 줄어들면서 사이에 생기던
    // 흰 틈을 메우려고요(11/28 화면 확인).
    const PATTERN_CUT = 72;

    // 무늬 구역: 바탕(면) + 무늬(면 안에만)
    const patternJobs = [];
    for (const [key, m] of masks) {
      if (key !== "dots" && !key.startsWith("hatch|")) continue;
      if (!hasAny(m)) continue;
      const bd = upscale(m);
      paint(bd, key === "dots" ? palette.uncertain : HATCH_FILL, PATTERN_CUT, patternJobs.length);
      patternJobs.push({ key });
    }
    for (const key of ["약", "중", "강"]) {
      const m = masks.get(key);
      if (!m || !hasAny(m)) continue;
      paint(upscale(m), palette[key]);
    }
    fctx.putImageData(out, 0, 0);

    if (!octx || !patternJobs.length) return;
    const pat = document.createElement("canvas");
    pat.width = W; pat.height = H;
    const pctx = pat.getContext("2d");
    const oimg = octx.createImageData(W, H);
    const odd = oimg.data;
    patternJobs.forEach((job, jobId) => {
      pctx.clearRect(0, 0, W, H);
      if (job.key === "dots") {
        // 11/28 하린: 6px 바둑판 점은 '격자'처럼 보여서, 간격을 넓히고 줄마다 반 칸 어긋나게(엇갈린 점) 찍어요.
        pctx.fillStyle = DOT_COLOR;
        for (let y = 4, row = 0; y < H; y += 7, row++) {
          for (let x = (row % 2 ? 9 : 4); x < W; x += 10) { pctx.beginPath(); pctx.arc(x, y, 1.3, 0, Math.PI * 2); pctx.fill(); }
        }
      } else {
        const color = job.key.slice(6);
        const [r, g, b, a] = parseRgba(color);
        // 하한 단계 색 빗금도 바탕보다 너무 진하지 않게 알파를 줄여요
        pctx.strokeStyle = `rgba(${r},${g},${b},${Math.min(a / 255, 0.55)})`;
        pctx.lineWidth = 1;
        for (let off = -H; off < W; off += 10) { pctx.beginPath(); pctx.moveTo(off, 0); pctx.lineTo(off + H, H); pctx.stroke(); }
      }
      const pd = pctx.getImageData(0, 0, W, H).data;
      for (let i = 0; i < owner.length; i++) {
        if (owner[i] !== jobId || !pd[i * 4 + 3]) continue;
        const q = i * 4;
        odd[q] = pd[q]; odd[q + 1] = pd[q + 1]; odd[q + 2] = pd[q + 2]; odd[q + 3] = pd[q + 3];
      }
    });
    octx.putImageData(oimg, 0, 0);
  },
});
