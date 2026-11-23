// app/main.js — 시민 화면(index.html)의 지도·격자 색 표시·시간 슬라이더.
// 로드맵 M3(11/22~25) "친구" 담당: 지도, 격자 색 표시, 시간 슬라이더.
//
// ⚠️ 지금은 데모/시연 단계예요. 실제 공연 일정(data/events.json)·강좌 시간표는
// 아직 빈 자리라서(11/23·11/24 작업), 이 화면은 "공연 있다고 가정하고 버튼으로
// 켜고 끄는" 데모 음원을 써요. 음원 세기(LW)도 공단 측정 기준 답이 아직 없어서
// 가정값이에요 — 로드맵 §2 11/22 결론대로 "엔진 만져 보기(풍향·음량 바꿔 보기)"
// 용도로 만든 화면이라, 숫자 자체보다 지도·슬라이더가 엔진과 잘 연결되는지를
// 보는 게 목적이에요.

import { mapDisplayFor } from "../engine/common.js";
import { VOLUME_PRESETS, applyVolumePreset, CONCAWE_BANDS_HZ } from "../engine/noise.js";
import { skyCodeToName, stabilityFromForecast } from "../engine/plume.js";

const PARK_CENTER = { lat: 37.5203, lon: 127.1268 };
const NUM_HOURS = 72; // 로드맵: 지금부터 6시간(초단기)+3일(단기), 1시간 단위
const DEMO_BASE_LW_DB = 100; // ⚠️ 가정값 — 음원 세기(LW) 공단 답 대기(decisions.md 11/21)
const DEMO_GROUND = { groundType: "soft", dSoftM: 300, hs: 1.5 };

// "0dB씩 7밴드"는 저희 내부 테스트 관행일 뿐 "균등 배분"이 아니에요(각 밴드가 전체
// LW를 독립으로 받음 — validation/external_review_fixes.mjs 주석 참고). 화면 데모는
// 실제 숫자처럼 보여야 하니, 에너지를 7밴드에 고르게 나누는 상대비율(−10·log10(7))을 써요.
const EQUAL_SPLIT_OFFSET_DB = -10 * Math.log10(CONCAWE_BANDS_HZ.length);
const DEMO_SPECTRUM = Object.fromEntries(CONCAWE_BANDS_HZ.map((f) => [f, EQUAL_SPLIT_OFFSET_DB]));

const NOISE_PALETTE = { 강: "rgba(198,40,40,0.72)", 중: "rgba(251,140,0,0.62)", 약: "rgba(253,216,53,0.5)", uncertain: "rgba(120,120,120,0.45)" };
const EXHAUST_PALETTE = { 강: "rgba(106,27,154,0.72)", 중: "rgba(171,71,188,0.6)", 약: "rgba(206,147,216,0.48)", uncertain: "rgba(120,120,120,0.45)" };

function kstParts(date) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return { y: parts.year, m: parts.month, d: parts.day, h: hour };
}

function hourSlotIso(date) {
  const { y, m, d, h } = kstParts(date);
  return `${y}-${m}-${d}T${h}:00:00+09:00`;
}

function weatherKey(date) {
  const { y, m, d, h } = kstParts(date);
  return `${y}${m}${d}${h}`;
}

function buildWeatherByHour(forecastItems) {
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
function toEngineWeather(rec, hourIso) {
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

// ---------------------------------------------------------------------------
// 격자 캔버스 레이어 — 24,178개 셀을 Leaflet 도형 객체 대신 캔버스 하나에 직접 그려서
// 빠르게 표시해요(roadmap 권고표의 "먼저 놓았을 때만 계산" + Web Worker 병행).
// ---------------------------------------------------------------------------
const CanvasCellLayer = L.Layer.extend({
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
    // 5차 외부 검토 지적(11/22, 하린): "확실히 조용함"(blank, 안 그림)과 "몰라서 못
    // 계산함"(unknown, 가장 위험할 수 있는 약풍 밤 등)을 다르게 그려야 해요 — unknown은
    // 점 패턴(빗금과 또 다르게)으로 "모름"을 표시해요.
    if (disp.mode === "unknown") return { fill: palette.uncertain, dotted: true };
    if (disp.mode === "hatch") {
      // 11/22 결정(사용자+하린, B안): 근거리불확실이어도 하한등급이 있으면 "최소 이
      // 등급 이상"을 빗금 색으로 바로 보여줘요(칸이 작아 글자는 안 보이니 색으로 — 범례에
      // "빗금 색 = 하한 등급" 설명 추가).
      const hatchColor = cell.하한등급 ? (palette[cell.하한등급] ?? palette.uncertain) : "rgba(60,60,60,0.55)";
      return { fill: palette.uncertain, hatch: true, hatchColor };
    }
    if (disp.hideLevel) return { fill: palette.uncertain, hatch: true }; // 일부음원제외 — 등급 보류
    // 실제 브라우저 확인(11/22) 중 발견: 값은 있지만 기준 미만(강·중·약 어디에도 안
    // 들어감, level:null — 예: 음원에서 아주 먼 칸)인 경우까지 palette.uncertain(회색)으로
    // 칠해서, 격자 전체가 "근거리불확실/모름"인 것처럼 회색으로 덮여 보이는 버그가 있었어요.
    // 기준 미만은 "문제없음"이지 "모름"이 아니라서 칠하지 않아요(blank와 같은 처리).
    if (!cell.level) return null;
    return { fill: palette[cell.level], hatch: false };
  },
});

// ---------------------------------------------------------------------------
// 앱 상태
// ---------------------------------------------------------------------------
const state = {
  weatherByHour: null,
  concaweData: null,
  siteByName: new Map(),
  selectedVenues: new Set(),
  generatorCount: 0,
  volumePreset: "기본",
  windOverride: null, // {windVecFromDeg, wsd10m} 또는 null(실제 예보 사용)
  cellCache: new Map(), // hourIso -> {cells, warnings}
};

const worker = new Worker(new URL("./grid-worker.js", import.meta.url), { type: "module" });
let requestSeq = 0;
const pendingRequests = new Map();
worker.onmessage = (ev) => {
  const { requestId, ok, cells, error } = ev.data;
  const resolve = pendingRequests.get(requestId);
  pendingRequests.delete(requestId);
  if (!resolve) return;
  resolve(ok ? { cells } : { error });
};
function computeHourInWorker(payload) {
  const requestId = ++requestSeq;
  return new Promise((resolve) => {
    pendingRequests.set(requestId, resolve);
    worker.postMessage({ requestId, ...payload });
  });
}

async function loadData() {
  const [weather, site, assumptions, concaweData] = await Promise.all([
    fetch("./data/weather.json").then((r) => r.json()),
    fetch("./data/site.geojson").then((r) => r.json()),
    fetch("./data/assumptions.json").then((r) => r.json()),
    fetch("./data/concawe_4_81.json").then((r) => r.json()),
  ]);
  state.weatherByHour = buildWeatherByHour(weather.예보 ?? []);
  for (const f of site.features) state.siteByName.set(f.properties.name, f);
  state.assumptions = assumptions;
  state.concaweData = concaweData;
  return { weather, site, assumptions };
}

function buildStageSources(hourIso) {
  const sources = [];
  for (const name of state.selectedVenues) {
    const feature = state.siteByName.get(name);
    if (!feature) continue;
    const [lon, lat] = feature.geometry.coordinates;
    const lwDb = applyVolumePreset(DEMO_BASE_LW_DB, state.volumePreset);
    sources.push({
      lat, lon, lwDb,
      ...DEMO_GROUND,
      spectrumRatiosDb: DEMO_SPECTRUM,
      time: { start: "2026-01-01T00:00:00+09:00", end: "2026-12-31T23:00:00+09:00", 출처: "데모" },
    });
  }
  return sources;
}

function buildGeneratorSources() {
  if (state.generatorCount <= 0) return [];
  const feature = state.siteByName.get("KSPO DOME");
  const [lon, lat] = feature.geometry.coordinates;
  return Array.from({ length: state.generatorCount }, () => ({
    lat, lon,
    엔진출력_kW: 500,
    출력종류: "엔진",
    정보출처: "시연용가정",
    // 6차 외부 검토 지적(11/23, 하린): DEFAULT_EXHAUST를 여기서 펼쳐 넣으면 plume.js가
    // "배기 사양을 안다"고 착각해서 '배기사양가정' 꼬리표를 안 붙여요 — 가정값인데 가정값
    // 표시가 안 되는 규칙 위반이었어요. 안 넣어도 plume.js가 같은 기본값을 알아서 쓰고
    // 꼬리표도 제대로 붙여줘요.
    time: { start: "2026-01-01T00:00:00+09:00", end: "2026-12-31T23:00:00+09:00", 출처: "데모" },
  }));
}

// 알려진 한계(6차 외부 검토, 하린 — "동결 후 미해결로 남겨도 됨" 합의): 이 함수가 계산을
// 끝낸 뒤 state.cellCache에 쓰는 시점 자체는 refresh()의 요청 순번 검사를 안 거쳐요 —
// 화면에 "그리는 것"은 refresh()의 refreshSeq로 막아뒀지만(최신 요청이 아니면 안 그림),
// 아주 드물게 늦게 끝난 옛 요청이 캐시"값"을 새 값 뒤에 다시 덮어쓸 수 있어요(그 시각으로
// 나중에 다시 돌아오면 잠깐 옛 값이 보일 수 있음). 동결 전 급한 문제는 아니라고 봐서 보류.
async function getCellsForHour(date) {
  const hourIso = hourSlotIso(date);
  if (state.cellCache.has(hourIso)) return state.cellCache.get(hourIso);

  let weather;
  if (state.windOverride) {
    const base = state.weatherByHour.get(weatherKey(date));
    const sky = base?.SKY ?? "1";
    let stability = "D";
    try {
      stability = stabilityFromForecast({
        sky: skyCodeToName(sky), wsd10m: state.windOverride.wsd10m,
        lat: PARK_CENTER.lat, lon: PARK_CENTER.lon, dateUtc: new Date(hourIso),
      }).stability;
    } catch { /* 기본값 D 유지 */ }
    weather = { tempC: 10, rhPercent: 60, ...state.windOverride, stability, tmp: 10 };
  } else {
    weather = toEngineWeather(state.weatherByHour.get(weatherKey(date)), hourIso);
  }

  if (!weather) {
    const result = { cells: [], warning: "이 시각은 기상 자료가 없어 계산하지 않았어요(자료 부족)." };
    state.cellCache.set(hourIso, result);
    return result;
  }

  const stageSources = buildStageSources(hourIso);
  const generatorSources = buildGeneratorSources();
  const { cells, error } = await computeHourInWorker({
    stageSources, generatorSources, weather, hour: hourIso, noiseScenario: "concawe", concaweData: state.concaweData,
  });
  const result = error ? { cells: [], warning: `계산 오류: ${error}` } : { cells, warning: null };
  state.cellCache.set(hourIso, result);
  return result;
}

// ---------------------------------------------------------------------------
// 지도 + UI
// ---------------------------------------------------------------------------
function hourSlotDate(offsetHours) {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + offsetHours);
  return d;
}

function formatSlotLabel(date) {
  const { m, d, h } = kstParts(date);
  return `${m}/${d} ${h}시`;
}

async function main() {
  const { assumptions } = await loadData();

  const map = L.map("map", { center: [PARK_CENTER.lat, PARK_CENTER.lon], zoom: 15 });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  const noiseLayer = new CanvasCellLayer({ palette: NOISE_PALETTE }).addTo(map);
  const exhaustLayer = new CanvasCellLayer({ palette: EXHAUST_PALETTE }).addTo(map);

  // 음원 체크박스(데모) — 기본안_계산대상 중 소음_포함:true인 장소만
  const venueBox = document.getElementById("venue-checkboxes");
  for (const v of assumptions.기본안_계산대상.venues) {
    if (!v.소음_포함) continue;
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = v.site;
    input.addEventListener("change", () => {
      if (input.checked) state.selectedVenues.add(v.site);
      else state.selectedVenues.delete(v.site);
      state.cellCache.clear();
      refresh();
    });
    label.appendChild(input);
    label.append(` ${v.site}`);
    venueBox.appendChild(label);
    venueBox.appendChild(document.createElement("br"));
  }

  document.getElementById("volume-preset").addEventListener("change", (e) => {
    state.volumePreset = e.target.value;
    state.cellCache.clear();
    refresh();
  });
  document.getElementById("generator-count").addEventListener("change", (e) => {
    state.generatorCount = Number(e.target.value) || 0;
    state.cellCache.clear();
    refresh();
  });
  const windOverrideToggle = document.getElementById("wind-override-toggle");
  const windOverrideFields = document.getElementById("wind-override-fields");
  const windDirInput = document.getElementById("wind-dir");
  const windSpeedInput = document.getElementById("wind-speed");
  function syncWindOverride() {
    if (windOverrideToggle.checked) {
      state.windOverride = { windVecFromDeg: Number(windDirInput.value), wsd10m: Number(windSpeedInput.value) };
      windOverrideFields.style.display = "";
    } else {
      state.windOverride = null;
      windOverrideFields.style.display = "none";
    }
    state.cellCache.clear();
    refresh();
  }
  windOverrideToggle.addEventListener("change", syncWindOverride);
  windDirInput.addEventListener("input", syncWindOverride);
  windSpeedInput.addEventListener("input", syncWindOverride);
  windOverrideFields.style.display = "none";

  document.getElementById("toggle-noise").addEventListener("change", (e) => {
    if (e.target.checked) noiseLayer.addTo(map); else map.removeLayer(noiseLayer);
  });
  document.getElementById("toggle-exhaust").addEventListener("change", (e) => {
    if (e.target.checked) exhaustLayer.addTo(map); else map.removeLayer(exhaustLayer);
  });

  const slider = document.getElementById("time-slider");
  slider.min = "0";
  slider.max = String(NUM_HOURS - 1);
  slider.value = "0";
  const sliderLabel = document.getElementById("slider-label");
  const warningEl = document.getElementById("slider-warning");

  // 6차 외부 검토 지적(11/23, 하린): 계산 도중(worker 응답 대기 중) 설정을 또 바꾸면,
  // 먼저 시작한 낡은 요청이 나중에 끝나서 최신 결과 위에 옛날 캐시·화면을 덮어쓸 수
  // 있었어요 — 매번 자기 차례 번호를 받아서, 자기보다 새 요청이 이미 시작됐으면
  // 캐시에 쓰지도 화면에 그리지도 않아요.
  let refreshSeq = 0;
  async function refresh() {
    const mySeq = ++refreshSeq;
    const offset = Number(slider.value);
    const date = hourSlotDate(offset);
    sliderLabel.textContent = formatSlotLabel(date);
    warningEl.textContent = "계산 중…";
    const { cells, warning } = await getCellsForHour(date);
    if (mySeq !== refreshSeq) return; // 그 사이 더 새 요청이 시작됨 — 이 결과는 버림
    warningEl.textContent = warning ?? "";
    noiseLayer.setCells(cells.filter((c) => c.layer === "noise"), 25);
    exhaustLayer.setCells(cells.filter((c) => c.layer === "exhaust"), 25);
  }

  sliderLabel.textContent = formatSlotLabel(hourSlotDate(0));
  slider.addEventListener("change", refresh); // 로드맵 권고: 슬라이더를 "놓았을 때"만 계산
  slider.addEventListener("input", (e) => { sliderLabel.textContent = formatSlotLabel(hourSlotDate(Number(e.target.value))); });

  refresh();
}

main().catch((err) => {
  document.body.insertAdjacentHTML("beforeend", `<p style="color:red">초기화 실패: ${err.message}</p>`);
  console.error(err);
});
