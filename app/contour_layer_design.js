// app/contour_layer_design.js — 디자인 사본 전용(하린 11/27). 제출 화면(citizen.html)은 안 씀.
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
//  4. 빗금·점무늬(등급 보류·계산 불가)는 원래 레이어가 그린 그대로 또렷하게 둬요.

import { CanvasCellLayer } from "./shared.js";

const RANK = { 약: 1, 중: 2, 강: 3 };

function parseRgba(str) {
  const m = String(str).match(/rgba?\(([^)]+)\)/);
  if (!m) return [128, 128, 128, 255];
  const p = m[1].split(",").map((x) => Number(x.trim()));
  return [p[0], p[1], p[2], Math.round((p[3] ?? 1) * 255)];
}

export const ContourCellLayer = CanvasCellLayer.extend({
  _redraw() {
    // 원래 레이어가 칸 칠 + 빗금·점무늬를 그리게 한 다음, 칠한 부분만 지우고 다시 그려요.
    CanvasCellLayer.prototype._redraw.call(this);
    if (!this._map || !this._fillCanvas) return;
    const fc = this._fillCanvas;
    fc.style.filter = "none";
    const W = fc.width, H = fc.height;
    if (!W || !H) return;
    const fctx = fc.getContext("2d");
    fctx.clearRect(0, 0, W, H);

    // 1) 칸 → 격자 번호
    const items = [];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const cell of this._cells) {
      const st = this._styleFor(cell);
      if (!st) continue;
      const cls = st.hatch || st.dotted ? "uncertain" : cell.level;
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

    const masks = { uncertain: new Float32Array(gw * gh), 약: new Float32Array(gw * gh), 중: new Float32Array(gw * gh), 강: new Float32Array(gw * gh) };
    for (const it of items) {
      const i = Math.round((it.x - minX) / dx) + PAD;
      const j = Math.round((maxY - it.y) / dy) + PAD;
      const k = j * gw + i;
      if (it.cls === "uncertain") { masks.uncertain[k] = 1; continue; }
      const r = RANK[it.cls] ?? 0;
      if (r >= 1) masks.약[k] = 1;
      if (r >= 2) masks.중[k] = 1;
      if (r >= 3) masks.강[k] = 1;
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

    const palette = this.options.palette;
    const order = [["uncertain", palette.uncertain], ["약", palette.약], ["중", palette.중], ["강", palette.강]];
    const out = fctx.getImageData(0, 0, W, H);
    const od = out.data;
    for (const [key, color] of order) {
      const m = masks[key];
      let any = false;
      for (let q = 0; q < m.length; q++) if (m[q]) { any = true; break; }
      if (!any) continue;
      // 2) 3×3 평균으로 계단 모서리 둥글게
      const sm = new Float32Array(gw * gh);
      for (let y = 1; y < gh - 1; y++) for (let x = 1; x < gw - 1; x++) {
        let s = 0;
        for (let yy = -1; yy <= 1; yy++) for (let xx = -1; xx <= 1; xx++) s += m[(y + yy) * gw + x + xx];
        // 원래 칸은 절반 이상으로 남게(외딴 칸 하나도 사라지지 않게), 바깥 칸은 이웃이 많을 때만 살짝 채움
        sm[y * gw + x] = m[y * gw + x] ? Math.max(0.6, (s + 4) / 13) : (s / 13) * 0.9;
      }
      const img = sctx.createImageData(gw, gh);
      for (let q = 0; q < sm.length; q++) { img.data[q * 4 + 3] = Math.round(sm[q] * 255); }
      sctx.putImageData(img, 0, 0);
      // 3) 부드럽게 늘린 뒤 절반 기준으로 자르기
      bctx.clearRect(0, 0, W, H);
      bctx.drawImage(small, left, top, sw, sh);
      const bd = bctx.getImageData(0, 0, W, H).data;
      const [r, g, b, a] = parseRgba(color);
      for (let q = 3; q < bd.length; q += 4) {
        if (bd[q] >= 128) { od[q - 3] = r; od[q - 2] = g; od[q - 1] = b; od[q] = a; }
      }
    }
    fctx.putImageData(out, 0, 0);
  },
});
