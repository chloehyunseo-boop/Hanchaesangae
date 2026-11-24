// app/agency.js — 공단 화면(agency.html). 로드맵 M3 11/24 "친구" 담당:
// "공단 화면(영향 강습, 예보 기록 CSV)", 완료기준 "공단 화면 동작".
// CLAUDE.md 4번: 공단 화면 = 시민 화면과 같은 엔진 + 영향 강습 목록 + 공연 일정(자동) + 예보 기록 CSV.
//
// 시민 화면(main.js)과 다른 점: 발전차를 "대수"로 뭉뚱그리지 않고, 공단이 공연마다 실제로
// 아는 발전차 정보(위치·발전기 수·인증 등급·엔진 출력)를 한 대씩 입력해요(하린 11/24 지시
// 3번). 모르는 값은 비워두면 v2 대표모델 가정값이 쓰이고 '가정' 꼬리표가 붙어요.
//
// 공연 일정(data/events.json)·강좌 시간표(data/lessons.json)는 아직 빈 자리예요(11/23·11/24
// 작업이 GitHub Actions 자동 갱신을 켜기 전이라 — CLAUDE.md 10번). 그래서 "영향 강습 목록"은
// 자료가 들어오면 바로 동작하도록 만들어 뒀지만, 지금은 "자료 없음"으로 보여요.
//
// 입력(발전차 목록)은 서버에 안 보내고 이 브라우저에만 저장돼요(localStorage) — 로드맵
// 문서의 "공단 화면 입력은 그 브라우저에만 저장되는 시연 기능" 설명 그대로예요.

import { skyCodeToName, stabilityFromForecast } from "../engine/plume.js";
import { placeCellsForHour, DEFAULT_PLACE_NAMES } from "../engine/forecast_text.js";
import { placeCellState, nearestPlace } from "../engine/place_view.js";
import {
  PARK_CENTER, NOISE_PALETTE, EXHAUST_PALETTE, CanvasCellLayer, createGridWorker,
  hourSlotIso, weatherKey, toEngineWeather, hourSlotDate, formatSlotLabel, loadCommonData,
  buildDemoStageSources, kstParts, allCellsUnknown, uniformUnknownMessage,
} from "./shared.js";

const NUM_HOURS = 72;
const STORAGE_KEY = "olpak_agency_trucks_v1";
const ALWAYS_ON_TIME = { start: "2026-01-01T00:00:00+09:00", end: "2026-12-31T23:00:00+09:00", 출처: "데모" };
const GRADE_LABEL = { 모름: "모름", 인증: "인증", 비인증: "비인증" };

const state = {
  weatherByHour: null, siteByName: null, assumptions: null, concaweData: null, lessons: null,
  selectedVenues: new Set(),
  volumePreset: "기본",
  trucks: loadTrucks(), // [{id, site, 발전기수:number|null, 인증등급:"모름"|"인증"|"비인증", 엔진출력_kW:number|null}]
  배출시나리오_기본값: "인증", // 트럭의 인증등급이 "모름"일 때 쓰는 값(하린 11/24 지시: 비인증 비교 보기)
  windOverride: null,
  cellCache: new Map(),
};

function loadTrucks() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) return parsed;
  } catch { /* 저장된 값이 깨졌으면 빈 목록으로 시작 */ }
  return [];
}
function saveTrucks() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.trucks)); } catch { /* 저장 안 돼도 화면은 그대로 동작 */ }
}

// 트럭 입력 → combine.js가 받는 generatorSources(발전차 목록). 공란은 undefined로 보내서
// plume_v2.js가 대표모델 가정값을 쓰고 '가정' 꼬리표를 붙이게 해요(engine/plume_v2.js 참고).
function buildGeneratorSourcesFromTrucks() {
  const out = [];
  for (const t of state.trucks) {
    const feature = state.siteByName.get(t.site);
    if (!feature) continue; // 위치를 아직 안 고른 트럭은 계산에서 빼요
    const [lon, lat] = feature.geometry.coordinates;
    out.push({
      lat, lon,
      ...(Number.isFinite(t.발전기수) ? { 발전기수: t.발전기수 } : {}),
      ...(t.인증등급 && t.인증등급 !== "모름" ? { 인증등급: t.인증등급 } : {}),
      ...(Number.isFinite(t.엔진출력_kW) ? { 엔진출력_kW: t.엔진출력_kW } : {}),
      time: ALWAYS_ON_TIME,
    });
  }
  return out;
}

/** 그 시각 엔진 입력 날씨. 시민 화면(main.js)의 resolveWeather와 같은 구조예요. */
function resolveWeather(date) {
  const hourIso = hourSlotIso(date);
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
    return { tempC: 10, rhPercent: 60, ...state.windOverride, stability, tmp: 10 };
  }
  return toEngineWeather(state.weatherByHour.get(weatherKey(date)), hourIso);
}

async function getCellsForHour(date, computeHourInWorker) {
  const hourIso = hourSlotIso(date);
  const cacheKey = `${hourIso}|${state.배출시나리오_기본값}`;
  if (state.cellCache.has(cacheKey)) return state.cellCache.get(cacheKey);

  const weather = resolveWeather(date);
  if (!weather) {
    const result = { cells: [], warning: "이 시각은 기상 자료가 없어 계산하지 않았어요(자료 부족)." };
    state.cellCache.set(cacheKey, result);
    return result;
  }

  const stageSources = buildDemoStageSources(state.selectedVenues, state.siteByName, state.volumePreset);
  const generatorSources = buildGeneratorSourcesFromTrucks();
  const { cells, error } = await computeHourInWorker({
    stageSources, generatorSources, weather, hour: hourIso, noiseScenario: "concawe", concaweData: state.concaweData,
    배출시나리오: state.배출시나리오_기본값,
  });
  const result = error ? { cells: [], warning: `계산 오류: ${error}` } : { cells, warning: null };
  state.cellCache.set(cacheKey, result);
  return result;
}

// ---------------------------------------------------------------------------
// 발전차 입력 표
// ---------------------------------------------------------------------------
function renderTruckTable(onChange) {
  const tbody = document.getElementById("truck-rows");
  tbody.innerHTML = "";
  const venueNames = [...state.siteByName.keys()];
  for (const t of state.trucks) {
    const tr = document.createElement("tr");

    const siteSel = document.createElement("select");
    siteSel.innerHTML = `<option value="">위치 고르기</option>` + venueNames.map((n) => `<option value="${n}">${n}</option>`).join("");
    siteSel.value = t.site ?? "";
    siteSel.addEventListener("change", () => { t.site = siteSel.value || null; onChange(); });

    const countInput = document.createElement("input");
    countInput.type = "number"; countInput.min = "1"; countInput.max = "4"; countInput.style.width = "3.5em";
    countInput.placeholder = "모름=2";
    countInput.value = t.발전기수 ?? "";
    countInput.addEventListener("change", () => { const v = Number(countInput.value); t.발전기수 = countInput.value === "" ? null : (Number.isFinite(v) ? v : null); onChange(); });

    const gradeSel = document.createElement("select");
    gradeSel.innerHTML = Object.entries(GRADE_LABEL).map(([v, label]) => `<option value="${v}">${label}</option>`).join("");
    gradeSel.value = t.인증등급 ?? "모름";
    gradeSel.addEventListener("change", () => { t.인증등급 = gradeSel.value; onChange(); });

    const powerInput = document.createElement("input");
    powerInput.type = "number"; powerInput.min = "1"; powerInput.max = "2000"; powerInput.style.width = "5em";
    powerInput.placeholder = "모름=239kW";
    powerInput.value = t.엔진출력_kW ?? "";
    powerInput.addEventListener("change", () => { const v = Number(powerInput.value); t.엔진출력_kW = powerInput.value === "" ? null : (Number.isFinite(v) ? v : null); onChange(); });

    const delBtn = document.createElement("button");
    delBtn.type = "button"; delBtn.textContent = "삭제";
    delBtn.addEventListener("click", () => {
      state.trucks = state.trucks.filter((x) => x.id !== t.id);
      renderTruckTable(onChange);
      onChange();
    });

    for (const el of [siteSel, countInput, gradeSel, powerInput, delBtn]) {
      const td = document.createElement("td");
      td.appendChild(el);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

// ---------------------------------------------------------------------------
// 영향 강습 목록 — data/lessons.json의 강좌 배열을 읽어요. 하린이 11/24에 실제 자료(수영장
// 281개+테니스 89개, scripts/build_lessons.py로 생성)를 채워 넣었어요. 강좌 1건의 실제 모양:
// { name, 종목, site(site.geojson 이름), 요일:[0~6, 0=일요일], 시작:"HH:MM", 끝:"HH:MM",
//   기간시작:"YYYY-MM-DD", 기간끝:"YYYY-MM-DD"(상시면 "9999-12-31"), 출처, 슬롯수 } — 처음 짐작한
// 모양(요일·시작·끝)과 거의 같았고, 기간시작·기간끝만 추가로 봐야 했어요.
// ---------------------------------------------------------------------------
// 11/25 수정: 하린이 넣은 실제 강좌 자료(data/lessons.json)에 날짜 범위(기간시작·기간끝)가
// 있는데 처음엔 안 봤어요 — 끝난 강좌도 "진행 중"으로 잘못 떴을 거예요. 요일·시각 판정도
// date.getDay()/getHours()(브라우저 로컬 시간대)가 아니라 이 프로젝트가 늘 쓰는 KST
// 명시 변환(kstParts)으로 고쳤어요 — GitHub Pages는 어느 시간대 브라우저에서나 열리니까요.
function lessonsAtHour(lessons, date) {
  const { y, m, d, h } = kstParts(date);
  const dateStr = `${y}-${m}-${d}`;
  const dow = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d))).getUTCDay();
  const hh = `${h}:00`;
  return (lessons ?? []).filter((l) => {
    if (!Array.isArray(l.요일) || !l.요일.includes(dow)) return false;
    if (typeof l.시작 !== "string" || typeof l.끝 !== "string") return false;
    if (typeof l.기간시작 === "string" && dateStr < l.기간시작) return false;
    if (typeof l.기간끝 === "string" && dateStr > l.기간끝) return false;
    return hh >= l.시작 && hh < l.끝;
  });
}

function renderImpactedLessons(lessons, date, cells) {
  const el = document.getElementById("impacted-lessons");
  const list = lessons?.강좌 ?? [];
  if (list.length === 0) {
    el.textContent = "아직 강좌 자료가 없어요(수영장·테니스장 강좌정보 수집 전, data/lessons.json이 빈 자리예요).";
    return;
  }
  const running = lessonsAtHour(list, date);
  if (running.length === 0) {
    el.textContent = "이 시각엔 진행 중인 강좌가 없어요.";
    return;
  }
  const lines = running.map((l) => {
    const feature = state.siteByName.get(l.site);
    if (!feature) return `${l.name}(${l.site}) — 위치 자료 없음`;
    const [lon, lat] = feature.geometry.coordinates;
    const near = nearestPlace(DEFAULT_PLACE_NAMES.map((n) => ({ name: n, ...pt(n) })).filter((p) => p.lat), lat, lon, 9999);
    const key = near?.name ?? null;
    const c = key ? cells?.[key] : null;
    const noise = placeCellState(c?.noise);
    const exhaust = placeCellState(c?.exhaust);
    return `${l.name}(${l.site}) — 소음: ${noise.text} / 배출가스: ${exhaust.text}`;
  });
  el.innerHTML = lines.map((s) => `<div>${s}</div>`).join("");
}

function pt(name) {
  const f = state.siteByName.get(name);
  if (!f) return {};
  const [lon, lat] = f.geometry.coordinates;
  return { lat, lon };
}

// ---------------------------------------------------------------------------
// 예보 기록 CSV — 주요 장소 8곳 × 72시간 × 2레이어를 표로 만들어 내려받아요(로드맵
// "공단 화면: 예보 기록 CSV").
// ---------------------------------------------------------------------------
async function buildForecastCsv() {
  const places = DEFAULT_PLACE_NAMES.map((name) => ({ name, ...pt(name) })).filter((p) => p.lat !== undefined);
  const stageSources = buildDemoStageSources(state.selectedVenues, state.siteByName, state.volumePreset);
  const generatorSources = buildGeneratorSourcesFromTrucks();
  const rows = [["생성시각", "대상시각", "장소", "소음", "배출가스"]];
  const now = new Date().toISOString();
  for (let offset = 0; offset < NUM_HOURS; offset++) {
    const date = hourSlotDate(offset);
    const hourIso = hourSlotIso(date);
    const weather = resolveWeather(date);
    if (!weather) continue;
    const cellsByPlace = placeCellsForHour({
      places, stageSources, generatorSources, weather, hour: hourIso, concaweData: state.concaweData,
      배출시나리오: state.배출시나리오_기본값,
    });
    for (const p of places) {
      const c = cellsByPlace[p.name];
      rows.push([now, hourIso, p.name, placeCellState(c?.noise).text, placeCellState(c?.exhaust).text]);
    }
  }
  return rows.map((r) => r.map((v) => `"${String(v).replaceAll('"', '""')}"`).join(",")).join("\n");
}

// ---------------------------------------------------------------------------
async function main() {
  const { weatherByHour, siteByName, assumptions, concaweData, lessons } = await loadCommonData();
  state.weatherByHour = weatherByHour;
  state.siteByName = siteByName;
  state.assumptions = assumptions;
  state.concaweData = concaweData;
  state.lessons = lessons;

  const computeHourInWorker = createGridWorker();

  const map = L.map("map", { center: [PARK_CENTER.lat, PARK_CENTER.lon], zoom: 15 });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  const noiseLayer = new CanvasCellLayer({ palette: NOISE_PALETTE }).addTo(map);
  const exhaustLayer = new CanvasCellLayer({ palette: EXHAUST_PALETTE }).addTo(map);

  const venueBox = document.getElementById("venue-checkboxes");
  for (const v of assumptions.기본안_계산대상.venues) {
    if (!v.소음_포함) continue;
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
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

  document.getElementById("add-truck").addEventListener("click", () => {
    state.trucks.push({ id: `t${Date.now()}${Math.random().toString(36).slice(2, 6)}`, site: null, 발전기수: null, 인증등급: "모름", 엔진출력_kW: null });
    saveTrucks();
    renderTruckTable(onTruckChange);
  });
  function onTruckChange() {
    saveTrucks();
    state.cellCache.clear();
    refreshSliderBand();
    refresh();
  }
  renderTruckTable(onTruckChange);

  document.getElementById("scenario-default").addEventListener("change", (e) => {
    state.배출시나리오_기본값 = e.target.value;
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
    refreshSliderBand();
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

  document.getElementById("download-csv").addEventListener("click", async (e) => {
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = "만드는 중…(72시간 계산)";
    try {
      const csv = await buildForecastCsv();
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `올팍_예보기록_${hourSlotIso(new Date()).slice(0, 13)}시.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      btn.disabled = false;
      btn.textContent = "지금 설정으로 72시간 CSV 받기";
    }
  });

  const slider = document.getElementById("time-slider");
  slider.min = "0";
  slider.max = String(NUM_HOURS - 1);
  slider.value = "0";
  const sliderLabel = document.getElementById("slider-label");
  const warningEl = document.getElementById("slider-warning");

  // 11/25 하린 결정: 그 시각 한 레이어가 "전부" 모름이면(약풍이라 발전차 확산을 계산 못
  // 하는 경우 등) 칸을 회색 점무늬로 칠하는 대신 지도 위 띠로 알려줘요(시민 화면 main.js와
  // 같은 방식, app/shared.js의 함수 재사용).
  const layerWarningEl = document.getElementById("layer-warning");
  function renderLayerWarnings(cells, weather) {
    const lines = [];
    for (const key of ["exhaust", "noise"]) {
      const layerCells = cells.filter((c) => c.layer === key);
      if (allCellsUnknown(layerCells)) lines.push(uniformUnknownMessage(key, layerCells, weather));
    }
    layerWarningEl.innerHTML = lines.map((l) => `<div>${l}</div>`).join("");
  }

  // 슬라이더 위 회색 구간 — 입력한 발전차가 하나라도 있는데 바람이 1m/s 미만인 시간을
  // 미리 보여줘요(시민 화면과 같은 방식).
  const sliderBandEl = document.getElementById("slider-band");
  function refreshSliderBand() {
    const hasTrucks = buildGeneratorSourcesFromTrucks().length > 0;
    const segs = [];
    for (let offset = 0; offset < NUM_HOURS; offset++) {
      const weather = resolveWeather(hourSlotDate(offset));
      const impossible = hasTrucks && weather && weather.wsd10m < 1.0;
      segs.push(`<div class="slider-seg${impossible ? " impossible" : ""}" title="${impossible ? "이 시간은 매연을 계산 못 해요(약풍)" : ""}"></div>`);
    }
    sliderBandEl.innerHTML = segs.join("");
  }

  let refreshSeq = 0;
  async function refresh() {
    const mySeq = ++refreshSeq;
    const offset = Number(slider.value);
    const date = hourSlotDate(offset);
    sliderLabel.textContent = formatSlotLabel(date);
    warningEl.textContent = "계산 중…";
    const { cells, warning } = await getCellsForHour(date, computeHourInWorker);
    if (mySeq !== refreshSeq) return;
    warningEl.textContent = warning ?? "";
    const weatherForWarning = resolveWeather(date);
    renderLayerWarnings(cells, weatherForWarning);
    const noiseCells = cells.filter((c) => c.layer === "noise");
    const exhaustCells = cells.filter((c) => c.layer === "exhaust");
    noiseLayer.setCells(allCellsUnknown(noiseCells) ? [] : noiseCells, 25);
    exhaustLayer.setCells(allCellsUnknown(exhaustCells) ? [] : exhaustCells, 25);

    // 영향 강습 목록은 8개 표준 장소 셀로 판단해요(지도 격자 전체가 아니라 장소별 보기와
    // 같은 수음점 — forecast_text.js의 placeCellsForHour, 11/24).
    const places = DEFAULT_PLACE_NAMES.map((name) => ({ name, ...pt(name) })).filter((p) => p.lat !== undefined);
    let placeCells = {};
    if (!warning) {
      const weather = resolveWeather(date);
      if (weather) {
        placeCells = placeCellsForHour({
          places,
          stageSources: buildDemoStageSources(state.selectedVenues, state.siteByName, state.volumePreset),
          generatorSources: buildGeneratorSourcesFromTrucks(),
          weather, hour: hourSlotIso(date), concaweData: state.concaweData, 배출시나리오: state.배출시나리오_기본값,
        });
      }
    }
    renderImpactedLessons(state.lessons, date, placeCells);
  }

  sliderLabel.textContent = formatSlotLabel(hourSlotDate(0));
  slider.addEventListener("change", refresh);
  slider.addEventListener("input", (e) => { sliderLabel.textContent = formatSlotLabel(hourSlotDate(Number(e.target.value))); });

  refreshSliderBand();
  refresh();
}

main().catch((err) => {
  document.body.insertAdjacentHTML("beforeend", `<p style="color:red">초기화 실패: ${err.message}</p>`);
  console.error(err);
});
