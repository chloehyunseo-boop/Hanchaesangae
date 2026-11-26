// app/shared.js — 시민 화면(main.js)·공단 화면(station.js)이 같이 쓰는 지도·날짜·데이터
// 로딩 코드예요. "공단 화면: 시민 화면과 같은 엔진"(CLAUDE.md 4번)이라서, 지도를 그리고
// 날씨를 엔진 입력으로 바꾸는 부분까지 똑같이 맞추려고 여기로 뽑았어요(원래 main.js에만
// 있었어요, 11/24 공단 화면 작업 때 뽑음 — 로직은 안 바꿨어요).

import { mapDisplayFor } from "../engine/common.js";
import { skyCodeToName, stabilityFromForecast } from "../engine/plume.js";
import { applyVolumePreset, CONCAWE_BANDS_HZ } from "../engine/noise.js";
import { generateGridPoints } from "../engine/combine.js";

export const PARK_CENTER = { lat: 37.5203, lon: 127.1268 };

// 데모 음원(공연마다 실제 음량·스펙트럼을 아직 못 받아서 쓰는 가정값, decisions.md 11/21).
// 시민 화면(main.js)·공단 화면(station.js)이 "같은 엔진"(CLAUDE.md 4번)을 쓰도록 여기로
// 뽑았어요 — 두 화면이 같은 함수를 불러서 로직이 갈라질 일이 없게 해요.
// ⚠️ 여전히 가정값이에요(공단이 실제 발전차·음향 장비 사양을 못 준다고 11/26 공식 답변) —
// 다만 11/22 사용자 결정의 데드라인(11/26)이 지나 "문헌 기반 가정값"으로 넘어가요. 65dB은
// 실측값이 아니라 **공단 기준**(옥외 행사 소음 65dB(A) 상한)이에요 — 완전 임의의 숫자가
// 아니라, 이 기준을 "편익동 쪽으로 정확히 부는 순풍(풍속 3m/s, 안정도 D=중립 대기, 소프트
// 지면)" 조건에서 거꾸로 풀어 "이 조건에서 기준(65dB)을 넘지 않는 음량"을 구한 값이에요
// (무대(88잔디마당 무대)·편익동(할리스커피점 추정 좌표, decisions.md 11/26) 실제 좌표로
// 거리 493.4m 계산, `lwFromTargetDbConcawe()` 역산 → 134.97dB, 반올림 135). 이 조건은
// "최악"이 아니라 "소리가 평소보다 잘 퍼지는 쪽" 조건 중 하나예요(하린 11/26 지적) — 더
// 극단적인 조건(더 강한 바람·다른 안정도)에선 기준을 지키려면 더 작은 음량이어야 할 수도
// 있어요. 편익동 좌표 자체도 추정치라 이 숫자 자체가 가정 사슬의 끝이 아니에요.
// 큰공연 preset: 역산값(135)을 "기본"으로 직접 써요 — 이전엔 "큰공연=역산값, 기본=−3dB"로
// 거꾸로 둬서 그 3dB에 근거가 없었는데(하린 11/26 지적), 지금은 역산값 자체가 기본이고
// "조용한(−3)·큰공연(+3)"은 공연 크기별 실제 차이를 측정한 게 아니라 화면에서 음량을
// 비교해볼 수 있게 만든 **데모 비교용** 상대 눈금일 뿐이에요(화면 안내 문구 참고).
export const DEMO_BASE_LW_DB = 135;
export const DEMO_GROUND = { groundType: "soft", dSoftM: 300, hs: 1.5 };
// "0dB씩 7밴드"는 "균등 배분"이 아니라서(각 밴드가 전체 LW를 독립으로 받음), 화면 데모는
// 에너지를 7밴드에 고르게 나누는 상대비율(−10·log10(7))을 써요.
const EQUAL_SPLIT_OFFSET_DB = -10 * Math.log10(CONCAWE_BANDS_HZ.length);
export const DEMO_SPECTRUM = Object.fromEntries(CONCAWE_BANDS_HZ.map((f) => [f, EQUAL_SPLIT_OFFSET_DB]));
const ALWAYS_ON_TIME = { start: "2026-01-01T00:00:00+09:00", end: "2026-12-31T23:00:00+09:00", 출처: "데모" };

// 11/26: 하린이 `data/assumptions.json`의 `실내공연장_외피`를 처음엔 engine 식 재료(Lp·R·S
// 따로)로 줬다가, 저녁(18:59)에 공연장별 최종 확정값(`공연장.[name].엔진입력_lwDb`)으로
// 구조를 바꿨어요 — C_d(−6→−5)·핸드볼 지붕/벽 분리 합산·A가중 변환까지 전부 끝난 값이라,
// engine/noise.js의 `indoorFacadeSourcePowerLevel(Lp,R,S)`로 우리가 다시 계산하면 그 변환이
// 중복/누락돼 값이 달라져요 — 그래서 이제 그 식은 안 쓰고, 확정값을 그대로 `lwDb`에 넣어요
// (다른 야외 음원과 입력 모양이 같아져서 combine.js를 더 안 바꿔도 돼요). S가 없는 곳
// (올림픽홀·K아트홀, 3D 미확보)·아직 하린이 확정값을 안 넣은 곳은 lwDb가 undefined가 되고
// combine.js가 그대로 "음원세기미확인"으로 빼요(지어내지 않음, CLAUDE.md 2번).
// ⚠️ 이 `엔진입력_lwDb`(예: 103.0)는 엔진 내부 규약값이에요 — 화면·기획서에 숫자로 보여줄
// 땐 반드시 하린이 같이 준 L_WA(A가중, re 1pW) 값을 써야 해요(docs/실내공연장_외피.md).
const INDOOR_VENUE_NAMES = new Set([
  "KSPO DOME", "티켓링크 라이브 아레나(SK올림픽핸드볼경기장)", "올림픽홀", "우리금융아트홀", "올림픽공원 K아트홀",
]);

/** 고른 장소들을 데모 음원(가정 음량·스펙트럼)으로 바꿔요. assumptions가 있으면 실내
 * 공연장은 preset 대신 하린이 확정한 엔진입력_lwDb를 그대로 써요. */
export function buildDemoStageSources(selectedVenues, siteByName, volumePreset, assumptions) {
  const indoorEnvelope = assumptions?.실내공연장_외피;
  const sources = [];
  for (const name of selectedVenues) {
    const feature = siteByName.get(name);
    if (!feature) continue;
    const [lon, lat] = feature.geometry.coordinates;
    if (INDOOR_VENUE_NAMES.has(name)) {
      const confirmed = indoorEnvelope?.공연장?.[name];
      const lwDb = Number.isFinite(confirmed?.엔진입력_lwDb) ? confirmed.엔진입력_lwDb : undefined;
      sources.push({ lat, lon, lwDb, ...DEMO_GROUND, spectrumRatiosDb: DEMO_SPECTRUM, time: ALWAYS_ON_TIME });
      continue;
    }
    const lwDb = applyVolumePreset(DEMO_BASE_LW_DB, volumePreset);
    sources.push({ lat, lon, lwDb, ...DEMO_GROUND, spectrumRatiosDb: DEMO_SPECTRUM, time: ALWAYS_ON_TIME });
  }
  return sources;
}

export const NOISE_PALETTE = { 강: "rgba(198,40,40,0.72)", 중: "rgba(251,140,0,0.62)", 약: "rgba(253,216,53,0.5)", uncertain: "rgba(120,120,120,0.45)" };
export const EXHAUST_PALETTE = { 강: "rgba(106,27,154,0.72)", 중: "rgba(171,71,188,0.6)", 약: "rgba(206,147,216,0.48)", uncertain: "rgba(120,120,120,0.45)" };

export function kstParts(date) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return { y: parts.year, m: parts.month, d: parts.day, h: hour };
}

export function hourSlotIso(date) {
  const { y, m, d, h } = kstParts(date);
  return `${y}-${m}-${d}T${h}:00:00+09:00`;
}

export function weatherKey(date) {
  const { y, m, d, h } = kstParts(date);
  return `${y}${m}${d}${h}`;
}

export function buildWeatherByHour(forecastItems) {
  const byHour = new Map();
  for (const it of forecastItems) {
    const key = it.fcstDate + it.fcstTime.slice(0, 2);
    const rec = byHour.get(key) || {};
    rec[it.category] = it.value;
    byHour.set(key, rec);
  }
  return byHour;
}

/** weather.json의 한 시각 기록(TMP·REH·VEC·WSD·SKY) → combine.js가 받는 weather 모양. */
export function toEngineWeather(rec, hourIso) {
  if (!rec || rec.TMP === undefined || rec.REH === undefined || rec.VEC === undefined || rec.WSD === undefined || rec.SKY === undefined) {
    return null; // 자료 부족 — 지어내지 않음(CLAUDE.md 2번)
  }
  const tempC = Number(rec.TMP);
  const rhPercent = Number(rec.REH);
  const windVecFromDeg = Number(rec.VEC);
  const wsd10m = Number(rec.WSD);
  if (![tempC, rhPercent, windVecFromDeg, wsd10m].every(Number.isFinite)) return null;
  let stability;
  try {
    const sky = skyCodeToName(rec.SKY);
    const r = stabilityFromForecast({ sky, wsd10m, lat: PARK_CENTER.lat, lon: PARK_CENTER.lon, dateUtc: new Date(hourIso) });
    stability = r.stability;
  } catch {
    return null;
  }
  return { tempC, rhPercent, windVecFromDeg, wsd10m, stability, tmp: tempC };
}

// 11/25 하린 결정: 그 시각 한 레이어의 칸이 "전부" 모름(unknown, 예: 약풍이라 발전차
// 확산을 계산 못 함)이면 지도 전체가 회색 점무늬로 덮여 고장처럼 보여요 — 칸을 칠하지
// 말고 띠(배너)로 "왜 못 그렸는지"를 말로 알려줘요. 일부만 모름인 경우(시간미확인 등)는
// 지금처럼 칸으로 보여줘요(이건 전체가 모름일 때만 — 5차 외부 검토의 "모름≠빈칸" 원칙은
// 띠 문구로 그대로 지켜져요).
export function allCellsUnknown(cells) {
  return Array.isArray(cells) && cells.length > 0 && cells.every((c) => mapDisplayFor(c).mode === "unknown");
}

const UNIFORM_UNKNOWN_LAYER_LABEL = { exhaust: "배출가스가", noise: "소음이" };

/** 전체-모름 띠에 넣을 문구. 원인이 약풍이면 그 시각 실제 풍속을 넣어서 말해요. */
export function uniformUnknownMessage(layerKey, cells, weather) {
  const label = UNIFORM_UNKNOWN_LAYER_LABEL[layerKey] ?? `${layerKey}가`;
  const flags = cells[0]?.flags ?? [];
  if (flags.includes("약풍미표시")) {
    const wsd = typeof weather?.wsd10m === "number" ? `${weather.wsd10m}m/s` : "거의 없음";
    return `이 시간은 바람이 거의 없어(풍속 ${wsd}) ${label} 어디로 퍼질지 계산할 수 없어요. 이런 때는 발전차 주변에 고일 수 있어요. 안전하다는 뜻은 아니에요.`;
  }
  return `이 시간은 ${label} 계산할 수 없어요. 안전하다는 뜻은 아니에요.`;
}

export function hourSlotDate(offsetHours) {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + offsetHours);
  return d;
}

export function formatSlotLabel(date) {
  const { m, d, h } = kstParts(date);
  return `${m}/${d} ${h}시`;
}

export async function loadCommonData() {
  const [weather, site, assumptions, concaweData, lessons, events] = await Promise.all([
    fetch("./data/weather.json").then((r) => r.json()),
    fetch("./data/site.geojson").then((r) => r.json()),
    fetch("./data/assumptions.json").then((r) => r.json()),
    fetch("./data/concawe_4_81.json").then((r) => r.json()),
    fetch("./data/lessons.json").then((r) => r.json()),
    fetch("./data/events.json").then((r) => r.json()),
  ]);
  const siteByName = new Map();
  for (const f of site.features) siteByName.set(f.properties.name, f);
  return {
    weatherByHour: buildWeatherByHour(weather.예보 ?? []),
    site, siteByName, assumptions, concaweData, lessons, events,
  };
}

/** 격자 전체를 Leaflet 도형 대신 캔버스 하나에 그려요(24,178개 셀, 11/22 성능 결정). */
export const CanvasCellLayer = L.Layer.extend({
  initialize(options) {
    L.setOptions(this, options);
    this._cells = [];
    this._halfLatDeg = 0;
    this._halfLonDeg = 0;
  },
  onAdd(map) {
    this._map = map;
    // 11/26: Safari(하린 화면)에서 확인됨 — 칸 색을 흐리는 걸 Canvas 2D의 `ctx.filter =
    // blur(...)`로 했더니 Safari는 이걸 조용히 무시해서(에러 없이) 블러 없이 색 경계가
    // 칼같이 또렷한 "원형 과녁판"처럼 보였어요(크롬만 잘 보임). Canvas 2D context.filter
    // 대신 "표준 CSS filter"(모든 브라우저가 훨씬 오래 안정적으로 지원)를 캔버스 엘리먼트
    // 자체에 걸어서 흐리고, 빗금·점무늬(모름 표시, 흐려지면 안 됨)는 그 위에 CSS filter가
    // 안 걸린 투명한 캔버스를 따로 겹쳐 또렷하게 그려요 — 두 캔버스를 따로 둬서 "칠(흐림)"과
    // "무늬(또렷)"가 서로 영향을 안 주게 했어요.
    // "leaflet-zoom-animated"를 줘야 지도 자체 줌 애니메이션 CSS 전환(0.25s)을 같이 타요
    // (11/26 친구 요청: 확대/축소할 때 반경이 줌 속도를 못 따라오고 끝나고서야 다시 그려지는
    // 문제 — Leaflet의 다른 레이어는 전부 zoomanim을 따라가는데 이 캔버스만 안 그랬어요).
    this._fillCanvas = L.DomUtil.create("canvas", "olpak-cell-canvas-fill leaflet-zoom-animated");
    this._overlayCanvas = L.DomUtil.create("canvas", "olpak-cell-canvas-overlay leaflet-zoom-animated");
    for (const c of [this._fillCanvas, this._overlayCanvas]) {
      c.style.position = "absolute";
      c.style.pointerEvents = "none";
      c.style.transformOrigin = "0 0";
    }
    map.getPanes().overlayPane.appendChild(this._fillCanvas);
    map.getPanes().overlayPane.appendChild(this._overlayCanvas); // 무늬가 칠 위에 오게 나중에 붙여요
    map.on("moveend zoomend resize", this._reset, this);
    map.on("zoomanim", this._animateZoom, this);
    this._reset();
  },
  onRemove(map) {
    map.getPanes().overlayPane.removeChild(this._fillCanvas);
    map.getPanes().overlayPane.removeChild(this._overlayCanvas);
    map.off("moveend zoomend resize", this._reset, this);
    map.off("zoomanim", this._animateZoom, this);
  },
  // 줌 애니메이션 도중(끝나기 전) 호출돼요 — 이미 그려둔 래스터(캔버스 둘 다)를 목표 줌·중심에
  // 맞는 자리로 옮기고 배율만 CSS transform으로 미리 맞춰서, 다른 Leaflet 레이어(타일 등)와
  // 같은 속도로 "주르륵" 커지거나 작아지게 해요. 다 끝나면 zoomend에서 _reset()이 실제 셀
  // 좌표로 다시 그려서 흐려 보이던 배율 확대/축소를 또렷하게 바꿔요.
  _animateZoom(e) {
    if (!this._map || !this._topLeftLatLng) return;
    const scale = this._map.getZoomScale(e.zoom, this._map.getZoom());
    const newTopLeft = this._map._latLngToNewLayerPoint(this._topLeftLatLng, e.zoom, e.center);
    L.DomUtil.setTransform(this._fillCanvas, newTopLeft, scale);
    L.DomUtil.setTransform(this._overlayCanvas, newTopLeft, scale);
  },
  setCells(cells, cellSizeM) {
    this._cells = cells;
    const midLatRad = (this._map ? this._map.getCenter().lat : PARK_CENTER.lat) * (Math.PI / 180);
    this._halfLatDeg = cellSizeM / 2 / 111320;
    this._halfLonDeg = this._halfLatDeg / Math.cos(midLatRad);
    this._redraw();
  },
  _reset() {
    if (!this._map) return;
    const topLeft = this._map.containerPointToLayerPoint([0, 0]);
    // 전에 걸린 줌 애니메이션 배율을 1로 되돌려요
    L.DomUtil.setTransform(this._fillCanvas, topLeft, 1);
    L.DomUtil.setTransform(this._overlayCanvas, topLeft, 1);
    this._topLeftLatLng = this._map.containerPointToLatLng([0, 0]); // 다음 줌 애니메이션이 따라갈 기준점
    const size = this._map.getSize();
    this._fillCanvas.width = size.x;
    this._fillCanvas.height = size.y;
    this._overlayCanvas.width = size.x;
    this._overlayCanvas.height = size.y;
    this._redraw();
  },
  // 칸(fill) 색은 흐리게 섞어서 "자연스럽게 퍼지는" 느낌을 주되, 빗금·점무늬(불확실·모름
  // 표시)는 흐리면 신호 자체가 흐려져 버려서(이 프로젝트에서 가장 중요한 "모름과 빈칸을
  // 구분" 규칙과 충돌) 또렷하게 따로 그려요 — 색은 분위기, 무늬는 사실이라고 생각하면 돼요.
  _redraw() {
    if (!this._map || !this._fillCanvas || !this._overlayCanvas) return;
    const w = this._fillCanvas.width, h = this._fillCanvas.height;
    if (w === 0 || h === 0) return; // 지도가 아직 자리를 못 잡았을 때(폭·높이 0, 11/25 발견)
    const fctx = this._fillCanvas.getContext("2d");
    const octx = this._overlayCanvas.getContext("2d");
    fctx.clearRect(0, 0, w, h);
    octx.clearRect(0, 0, w, h);

    const overlays = [];
    let cellPx = 25;
    for (const cell of this._cells) {
      const style = this._styleFor(cell);
      if (!style) continue;
      const nw = this._map.latLngToContainerPoint([cell.y + this._halfLatDeg, cell.x - this._halfLonDeg]);
      const se = this._map.latLngToContainerPoint([cell.y - this._halfLatDeg, cell.x + this._halfLonDeg]);
      const cw = Math.max(1, se.x - nw.x);
      const ch = Math.max(1, se.y - nw.y);
      cellPx = cw;
      fctx.fillStyle = style.fill;
      fctx.fillRect(nw.x, nw.y, cw, ch);
      if (style.hatch || style.dotted) overlays.push({ nw, se, w: cw, h: ch, style });
    }

    // 흐림 반경은 칸 크기(줌 배율)에 맞춰요 — 너무 흐리면 등급 경계가 안 보이고,
    // 너무 또렷하면 예전처럼 네모가 그대로 보여요. Canvas 2D의 ctx.filter 대신 표준 CSS
    // filter를 캔버스 엘리먼트에 거는 이유는 위 onAdd 주석(Safari에서 ctx.filter가 조용히
    // 무시되던 문제) 참고.
    const blurPx = Math.max(2, Math.min(14, cellPx * 0.6));
    this._fillCanvas.style.filter = `blur(${blurPx}px)`;

    for (const { nw, se, w: cw, h: ch, style } of overlays) {
      if (style.hatch) {
        octx.save();
        octx.beginPath();
        octx.rect(nw.x, nw.y, cw, ch);
        octx.clip();
        octx.strokeStyle = style.hatchColor ?? "rgba(60,60,60,0.55)";
        octx.lineWidth = 1;
        for (let off = -Math.max(cw, ch); off < Math.max(cw, ch); off += 5) {
          octx.beginPath();
          octx.moveTo(nw.x + off, nw.y);
          octx.lineTo(nw.x + off + ch, nw.y + ch);
          octx.stroke();
        }
        octx.restore();
      }
      if (style.dotted) {
        octx.save();
        octx.beginPath();
        octx.rect(nw.x, nw.y, cw, ch);
        octx.clip();
        octx.fillStyle = "rgba(60,60,60,0.6)";
        for (let yy = nw.y + 3; yy < se.y; yy += 6) {
          for (let xx = nw.x + 3; xx < se.x; xx += 6) {
            octx.beginPath();
            octx.arc(xx, yy, 1, 0, Math.PI * 2);
            octx.fill();
          }
        }
        octx.restore();
      }
    }
  },
  _styleFor(cell) {
    const disp = mapDisplayFor(cell);
    if (disp.mode === "blank") return null;
    const palette = this.options.palette;
    if (disp.mode === "unknown") return { fill: palette.uncertain, dotted: true };
    if (disp.mode === "hatch") {
      const hatchColor = cell.하한등급 ? (palette[cell.하한등급] ?? palette.uncertain) : "rgba(60,60,60,0.55)";
      return { fill: palette.uncertain, hatch: true, hatchColor };
    }
    if (disp.hideLevel) return { fill: palette.uncertain, hatch: true };
    if (!cell.level) return null;
    return { fill: palette[cell.level], hatch: false };
  },
});

// 11/26 친구 요청: 계산이 느려서(부채꼴 성능 개선 뒤에도 시간당 수 초) 슬라이더를 드래그하면
// 뚝뚝 끊겨 보여요. 격자 24,178칸은 칸끼리 서로 안 건드리는 독립 계산이라(combine.js의
// computeHourOutputCells가 grid를 한 칸씩 순서대로 돌 뿐), 기기 코어 수만큼 Worker를 여러 개
// 띄우고 격자를 나눠 동시에 돌리면 수식은 그대로인데 걸리는 시간만 코어 수에 가깝게 줄어요.
const GRID_WORKER_POOL_SIZE = Math.max(1, Math.min(8, (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4));

/** 격자를 Worker 개수만큼 나눠요(칸 순서는 안 가려요 — 어차피 지도에 흩뿌려 그릴 뿐이에요). */
function sliceGrid(points, n) {
  const size = Math.ceil(points.length / n);
  const slices = [];
  for (let i = 0; i < n; i++) {
    const slice = points.slice(i * size, (i + 1) * size);
    if (slice.length > 0) slices.push(slice);
  }
  return slices.length > 0 ? slices : [points];
}

/** 계산용 Web Worker '풀'을 만들어요(시민 화면·공단 화면이 각자 하나씩 가져요). 한 시각
 * 계산 요청을 받으면 격자를 풀 크기만큼 나눠 모든 Worker에 동시에 보내고, 전부 끝나면
 * 합쳐서 돌려줘요 — 호출하는 쪽(main.js 등)에서 보기엔 Worker 한 개짜리였을 때와 똑같은
 * 모양(Promise<{cells}|{error}>)이라 바꿀 일이 없어요. */
export function createGridWorker() {
  const workers = Array.from({ length: GRID_WORKER_POOL_SIZE },
    () => new Worker(new URL("./grid-worker.js", import.meta.url), { type: "module" }));
  const pendingByWorker = workers.map(() => new Map());
  workers.forEach((worker, idx) => {
    worker.onmessage = (ev) => {
      const { requestId, ok, cells, error } = ev.data;
      const resolve = pendingByWorker[idx].get(requestId);
      pendingByWorker[idx].delete(requestId);
      if (resolve) resolve(ok ? { cells } : { error });
    };
  });

  let gridSliceCache = null; // cellSizeM(없으면 "default") -> 나눈 격자 조각들
  function getGridSlices(cellSizeM) {
    const key = cellSizeM ?? "default";
    if (!gridSliceCache) gridSliceCache = new Map();
    if (!gridSliceCache.has(key)) {
      const points = cellSizeM ? generateGridPoints(cellSizeM) : generateGridPoints();
      gridSliceCache.set(key, sliceGrid(points, workers.length));
    }
    return gridSliceCache.get(key);
  }

  let requestSeq = 0;
  return function computeHourInWorker(payload) {
    const requestId = ++requestSeq;
    const slices = getGridSlices(payload.cellSizeM);
    const promises = slices.map((grid, i) => new Promise((resolve) => {
      pendingByWorker[i].set(requestId, resolve);
      workers[i].postMessage({ requestId, ...payload, grid });
    }));
    return Promise.all(promises).then((results) => {
      const failed = results.find((r) => r.error);
      if (failed) return { error: failed.error };
      return { cells: results.flatMap((r) => r.cells) };
    });
  };
}
