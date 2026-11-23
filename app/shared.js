// app/shared.js — 시민 화면(main.js)·공단 화면(station.js)이 같이 쓰는 지도·날짜·데이터
// 로딩 코드예요. "공단 화면: 시민 화면과 같은 엔진"(CLAUDE.md 4번)이라서, 지도를 그리고
// 날씨를 엔진 입력으로 바꾸는 부분까지 똑같이 맞추려고 여기로 뽑았어요(원래 main.js에만
// 있었어요, 11/24 공단 화면 작업 때 뽑음 — 로직은 안 바꿨어요).

import { mapDisplayFor } from "../engine/common.js";
import { skyCodeToName, stabilityFromForecast } from "../engine/plume.js";
import { applyVolumePreset, CONCAWE_BANDS_HZ } from "../engine/noise.js";

export const PARK_CENTER = { lat: 37.5203, lon: 127.1268 };

// 데모 음원(공연마다 실제 음량·스펙트럼을 아직 못 받아서 쓰는 가정값, decisions.md 11/21).
// 시민 화면(main.js)·공단 화면(station.js)이 "같은 엔진"(CLAUDE.md 4번)을 쓰도록 여기로
// 뽑았어요 — 두 화면이 같은 함수를 불러서 로직이 갈라질 일이 없게 해요.
export const DEMO_BASE_LW_DB = 100; // ⚠️ 가정값 — 음원 세기(LW) 공단 답 대기
export const DEMO_GROUND = { groundType: "soft", dSoftM: 300, hs: 1.5 };
// "0dB씩 7밴드"는 "균등 배분"이 아니라서(각 밴드가 전체 LW를 독립으로 받음), 화면 데모는
// 에너지를 7밴드에 고르게 나누는 상대비율(−10·log10(7))을 써요.
const EQUAL_SPLIT_OFFSET_DB = -10 * Math.log10(CONCAWE_BANDS_HZ.length);
export const DEMO_SPECTRUM = Object.fromEntries(CONCAWE_BANDS_HZ.map((f) => [f, EQUAL_SPLIT_OFFSET_DB]));
const ALWAYS_ON_TIME = { start: "2026-01-01T00:00:00+09:00", end: "2026-12-31T23:00:00+09:00", 출처: "데모" };

/** 고른 장소들을 데모 음원(가정 음량·스펙트럼)으로 바꿔요. */
export function buildDemoStageSources(selectedVenues, siteByName, volumePreset) {
  const sources = [];
  for (const name of selectedVenues) {
    const feature = siteByName.get(name);
    if (!feature) continue;
    const [lon, lat] = feature.geometry.coordinates;
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
    this._canvas = L.DomUtil.create("canvas", "olpak-cell-canvas");
    this._canvas.style.position = "absolute";
    this._canvas.style.pointerEvents = "none";
    map.getPanes().overlayPane.appendChild(this._canvas);
    map.on("moveend zoomend resize", this._reset, this);
    this._reset();
  },
  onRemove(map) {
    map.getPanes().overlayPane.removeChild(this._canvas);
    map.off("moveend zoomend resize", this._reset, this);
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
    L.DomUtil.setPosition(this._canvas, topLeft);
    const size = this._map.getSize();
    this._canvas.width = size.x;
    this._canvas.height = size.y;
    this._redraw();
  },
  _redraw() {
    if (!this._map || !this._canvas) return;
    const ctx = this._canvas.getContext("2d");
    ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
    for (const cell of this._cells) {
      const style = this._styleFor(cell);
      if (!style) continue;
      const nw = this._map.latLngToContainerPoint([cell.y + this._halfLatDeg, cell.x - this._halfLonDeg]);
      const se = this._map.latLngToContainerPoint([cell.y - this._halfLatDeg, cell.x + this._halfLonDeg]);
      const w = Math.max(1, se.x - nw.x);
      const h = Math.max(1, se.y - nw.y);
      ctx.fillStyle = style.fill;
      ctx.fillRect(nw.x, nw.y, w, h);
      if (style.hatch) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(nw.x, nw.y, w, h);
        ctx.clip();
        ctx.strokeStyle = style.hatchColor ?? "rgba(60,60,60,0.55)";
        ctx.lineWidth = 1;
        for (let off = -Math.max(w, h); off < Math.max(w, h); off += 5) {
          ctx.beginPath();
          ctx.moveTo(nw.x + off, nw.y);
          ctx.lineTo(nw.x + off + h, nw.y + h);
          ctx.stroke();
        }
        ctx.restore();
      }
      if (style.dotted) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(nw.x, nw.y, w, h);
        ctx.clip();
        ctx.fillStyle = "rgba(60,60,60,0.6)";
        for (let yy = nw.y + 3; yy < se.y; yy += 6) {
          for (let xx = nw.x + 3; xx < se.x; xx += 6) {
            ctx.beginPath();
            ctx.arc(xx, yy, 1, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        ctx.restore();
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

/** 한 계산용 Web Worker 핸들을 만들어요(시민 화면·공단 화면이 각자 하나씩 가져요). */
export function createGridWorker() {
  const worker = new Worker(new URL("./grid-worker.js", import.meta.url), { type: "module" });
  let requestSeq = 0;
  const pending = new Map();
  worker.onmessage = (ev) => {
    const { requestId, ok, cells, error } = ev.data;
    const resolve = pending.get(requestId);
    pending.delete(requestId);
    if (resolve) resolve(ok ? { cells } : { error });
  };
  return function computeHourInWorker(payload) {
    const requestId = ++requestSeq;
    return new Promise((resolve) => {
      pending.set(requestId, resolve);
      worker.postMessage({ requestId, ...payload });
    });
  };
}
