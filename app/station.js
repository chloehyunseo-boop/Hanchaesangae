// app/station.js — 공단 화면 "최종판"(station.html). 11/26 친구 요청: 체크박스로 "가정"하던
// app/agency.js(데모 성격이 있던 부분)는 그대로 두고, 공연 일정이 자동(또는 정확한 수동
// 입력)으로 돌아가는 화면을 새로 만들었어요. 지도·격자 계산은 app/shared.js를 그대로 빌려
// 써서(citizen.js·main.js와 같은 엔진, CLAUDE.md 4번) 로직이 갈라지지 않아요.
//
// agency.js와 다른 점:
//  - "공연 중이라고 가정할 장소" 체크박스·음량 프리셋 없음 — 실제 공연 일정(자동 수집 +
//    이 화면의 수동 입력)이 음원을 자동으로 결정해요(buildRealEventStageSources +
//    buildManualEventStageSources, citizen.js와 같은 함수 재사용).
//  - "공연 일정 — 수동 입력" 표가 이제 실제 지도 계산에 들어가요(agency.js에선 "보기+입력"만
//    했었음, CLAUDE.md §5의 남은 숙제를 여기서 마무리).
//  - 풍향·풍속 직접 설정 없음(사용자 11/26 결정 — 공단 화면도 실제 예보만 써요).
//  - 발전차 입력·CSV·영향 강습 목록은 agency.js와 똑같아요(이건 데모가 아니라 진짜 운영 도구예요).

import { placeCellsForHour, DEFAULT_PLACE_NAMES } from "../engine/forecast_text.js";
import { placeCellState, nearestPlace } from "../engine/place_view.js";
import {
  PARK_CENTER, NOISE_PALETTE, EXHAUST_PALETTE, CanvasCellLayer, createGridWorker,
  hourSlotIso, weatherKey, toEngineWeather, hourSlotDate, formatSlotLabel, loadCommonData,
  buildRealEventStageSources, buildManualEventStageSources, buildCitizenGeneratorSources,
  listTodaysRealEvents, kstParts, allCellsUnknown, uniformUnknownMessage,
  buildGeneratorSourcesFromTruckRecords, localInputToIso,
} from "./shared.js";

const NUM_HOURS = 72;
const STORAGE_KEY = "olpak_station_trucks_v1";
const EVENTS_STORAGE_KEY = "olpak_station_manual_events_v1";
const NOGEN_STORAGE_KEY = "olpak_station_no_generator_v1";
const GRADE_LABEL = { 모름: "모름", 인증: "인증", 비인증: "비인증" };
const NO_EXCLUDE = new Set(); // 체크박스가 없어서 "데모로 켠 장소" 자체가 없음

const state = {
  weatherByHour: null, siteByName: null, assumptions: null, concaweData: null, lessons: null, events: null,
  trucks: loadTrucks(),
  noGeneratorDays: loadList(NOGEN_STORAGE_KEY), // [{id, site, 날짜}] — '발전차 사용 안 함'(하린 11/27, agency.js와 같은 기능)
  manualEvents: loadManualEvents(),
  배출시나리오_기본값: "인증",
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
function loadList(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "null");
    if (Array.isArray(parsed)) return parsed;
  } catch { /* 깨졌으면 빈 목록 */ }
  return [];
}
function saveList(key, list) {
  try { localStorage.setItem(key, JSON.stringify(list)); } catch { /* 저장 안 돼도 화면은 동작 */ }
}
function loadManualEvents() {
  try {
    const raw = localStorage.getItem(EVENTS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) return parsed;
  } catch { /* 저장된 값이 깨졌으면 빈 목록으로 시작 */ }
  return [];
}
function saveManualEvents() {
  try { localStorage.setItem(EVENTS_STORAGE_KEY, JSON.stringify(state.manualEvents)); } catch { /* 저장 안 돼도 화면은 그대로 동작 */ }
}

function buildGeneratorSourcesFromTrucks() {
  return buildGeneratorSourcesFromTruckRecords(state.trucks, state.siteByName, state.assumptions);
}

function buildStageSources(hourIso) {
  const auto = buildRealEventStageSources(state.events, state.siteByName, "기본", state.assumptions, hourIso, NO_EXCLUDE);
  const manual = buildManualEventStageSources(state.manualEvents, state.siteByName, "기본", state.assumptions, hourIso);
  return [...auto, ...manual];
}
// 11/27: 하린이 shared.js의 buildCitizenGeneratorSources를 "모름 표시" 대신 공연 일정 →
// 발전차 기본 대수 자동 생성(engine/event_generators.js)으로 바꿨어요 — 공단이 직접 입력한
// 트럭(state.trucks)이 그 공연장·날짜엔 우선하고, 없는 곳만 기본 대수(KSPO DOME 5대, 나머지
// 1대)로 자동 채워져요. 공단 화면(station.js)에서 직접 추가한 "수동 입력" 공연은 아직 이
// 자동 생성 대상이 아니에요(발전차는 위 트럭 표에 직접 입력해 주세요) — events.공연(자동
// 수집)만 대상이에요.
function buildGeneratorSources(hourIso) {
  return buildCitizenGeneratorSources({
    events: state.events, truckRecords: state.trucks, noGeneratorDays: state.noGeneratorDays,
    siteByName: state.siteByName, assumptions: state.assumptions, hourIso,
  });
}

// '발전차 사용 안 함' 표 (agency.js와 같은 기능, 11/27 하린). 이 화면의 지도에도 반영돼요
// (agency.js는 트럭 표 그대로만 계산해서 영향 없지만, station.js는 citizen.js와 같은 자동
// 대수 가정을 쓰기 때문에 여기 적은 날은 이 화면 지도에서도 기본 대수가 안 들어가요).
function renderNoGenTable(onChange) {
  const tbody = document.getElementById("nogen-rows");
  tbody.innerHTML = "";
  const venues = (state.assumptions?.기본안_계산대상?.venues ?? []).filter((v) => v.매연_포함).map((v) => v.site);
  for (const r of state.noGeneratorDays) {
    const tr = document.createElement("tr");
    const sel = document.createElement("select");
    sel.innerHTML = `<option value="">공연장 고르기</option>` + venues.map((n) => `<option value="${n}">${n}</option>`).join("");
    sel.value = r.site ?? "";
    sel.addEventListener("change", () => { r.site = sel.value || null; onChange(); });
    const date = document.createElement("input");
    date.type = "date";
    date.value = r.날짜 ?? "";
    date.addEventListener("change", () => { r.날짜 = date.value || null; onChange(); });
    const del = document.createElement("button");
    del.type = "button"; del.textContent = "삭제";
    del.addEventListener("click", () => {
      state.noGeneratorDays = state.noGeneratorDays.filter((x) => x.id !== r.id);
      renderNoGenTable(onChange);
      onChange();
    });
    for (const el of [sel, date, del]) { const td = document.createElement("td"); td.appendChild(el); tr.appendChild(td); }
    tbody.appendChild(tr);
  }
}

function resolveWeather(date) {
  const hourIso = hourSlotIso(date);
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

  const stageSources = buildStageSources(hourIso);
  const generatorSources = buildGeneratorSources(hourIso);
  const { cells, error } = await computeHourInWorker({
    stageSources, generatorSources, weather, hour: hourIso, noiseScenario: "concawe", concaweData: state.concaweData,
    배출시나리오: state.배출시나리오_기본값,
  });
  const result = error ? { cells: [], warning: `계산 오류: ${error}` } : { cells, warning: null };
  state.cellCache.set(cacheKey, result);
  return result;
}

// ---------------------------------------------------------------------------
// 발전차 입력 표 (agency.js와 동일)
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

    const startInput = document.createElement("input");
    startInput.type = "datetime-local"; startInput.title = "비우면 1년 내내 가동으로 가정";
    startInput.value = t.시작시각 ?? "";
    startInput.addEventListener("change", () => { t.시작시각 = startInput.value || null; onChange(); });

    const setupInput = document.createElement("input");
    setupInput.type = "datetime-local"; setupInput.title = "공연 시작 시각을 먼저 넣어야 의미가 있어요";
    setupInput.value = t.셋업시작 ?? "";
    setupInput.addEventListener("change", () => { t.셋업시작 = setupInput.value || null; onChange(); });

    const delBtn = document.createElement("button");
    delBtn.type = "button"; delBtn.textContent = "삭제";
    delBtn.addEventListener("click", () => {
      state.trucks = state.trucks.filter((x) => x.id !== t.id);
      renderTruckTable(onChange);
      onChange();
    });

    for (const el of [siteSel, countInput, gradeSel, powerInput, startInput, setupInput, delBtn]) {
      const td = document.createElement("td");
      td.appendChild(el);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

function renderAutoEvents(hourIso) {
  const el = document.getElementById("auto-events");
  const items = listTodaysRealEvents(state.events, hourIso);
  el.innerHTML = items.length
    ? items.map((e) => `<div>${e.site} — ${e.title} (${e.startTimeStr ? e.startTimeStr + " 시작" : "그날 시작 시각 모름"})</div>`).join("")
    : "<div>지금 자동으로 찾은 실제 공연 일정이 없어요.</div>";
}

function renderManualEventsTable(onChange) {
  const tbody = document.getElementById("event-rows");
  tbody.innerHTML = "";
  const venueNames = [...state.siteByName.keys()];
  for (const ev of state.manualEvents) {
    const tr = document.createElement("tr");

    const titleInput = document.createElement("input");
    titleInput.type = "text"; titleInput.style.width = "8em"; titleInput.placeholder = "공연명";
    titleInput.value = ev.title ?? "";
    titleInput.addEventListener("change", () => { ev.title = titleInput.value || null; onChange(); });

    const siteSel = document.createElement("select");
    siteSel.innerHTML = `<option value="">위치 고르기</option>` + venueNames.map((n) => `<option value="${n}">${n}</option>`).join("");
    siteSel.value = ev.site ?? "";
    siteSel.addEventListener("change", () => { ev.site = siteSel.value || null; onChange(); });

    const dateInput = document.createElement("input");
    dateInput.type = "date"; dateInput.value = ev.날짜 ?? "";
    dateInput.addEventListener("change", () => { ev.날짜 = dateInput.value || null; onChange(); });

    const startInput = document.createElement("input");
    startInput.type = "time"; startInput.value = ev.시작 ?? "";
    startInput.addEventListener("change", () => { ev.시작 = startInput.value || null; onChange(); });

    const durInput = document.createElement("input");
    durInput.type = "number"; durInput.min = "1"; durInput.style.width = "4.5em"; durInput.placeholder = "분";
    durInput.value = ev.소요분 ?? "";
    durInput.addEventListener("change", () => { const v = Number(durInput.value); ev.소요분 = durInput.value === "" ? null : (Number.isFinite(v) ? v : null); onChange(); });

    const delBtn = document.createElement("button");
    delBtn.type = "button"; delBtn.textContent = "삭제";
    delBtn.addEventListener("click", () => {
      state.manualEvents = state.manualEvents.filter((x) => x.id !== ev.id);
      renderManualEventsTable(onChange);
      onChange();
    });

    for (const el of [titleInput, siteSel, dateInput, startInput, durInput, delBtn]) {
      const td = document.createElement("td");
      td.appendChild(el);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

export function lessonsAtHour(lessons, date) {
  const { y, m, d, h } = kstParts(date);
  const dateStr = `${y}-${m}-${d}`;
  const dow = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d))).getUTCDay();
  const hourStart = `${h}:00`;
  const hourEnd = `${String(Number(h) + 1).padStart(2, "0")}:00`;
  return (lessons ?? []).filter((l) => {
    if (!Array.isArray(l.요일) || !l.요일.includes(dow)) return false;
    if (typeof l.시작 !== "string" || typeof l.끝 !== "string") return false;
    if (typeof l.기간시작 === "string" && dateStr < l.기간시작) return false;
    if (typeof l.기간끝 === "string" && dateStr > l.기간끝) return false;
    return l.시작 < hourEnd && l.끝 > hourStart;
  });
}

function pt(name) {
  const f = state.siteByName.get(name);
  if (!f) return {};
  const [lon, lat] = f.geometry.coordinates;
  return { lat, lon };
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

async function buildForecastCsv() {
  const places = DEFAULT_PLACE_NAMES.map((name) => ({ name, ...pt(name) })).filter((p) => p.lat !== undefined);
  const rows = [["생성시각", "대상시각", "장소", "소음", "배출가스"]];
  const now = new Date().toISOString();
  for (let offset = 0; offset < NUM_HOURS; offset++) {
    const date = hourSlotDate(offset);
    const hourIso = hourSlotIso(date);
    const weather = resolveWeather(date);
    if (!weather) continue;
    const cellsByPlace = placeCellsForHour({
      places, stageSources: buildStageSources(hourIso), generatorSources: buildGeneratorSources(hourIso),
      weather, hour: hourIso, concaweData: state.concaweData, 배출시나리오: state.배출시나리오_기본값,
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
  const { weatherByHour, siteByName, assumptions, concaweData, lessons, events } = await loadCommonData();
  state.weatherByHour = weatherByHour;
  state.siteByName = siteByName;
  state.assumptions = assumptions;
  state.concaweData = concaweData;
  state.lessons = lessons;
  state.events = events;

  const genNote = document.getElementById("generator-count-note");
  const genNoteText = state.assumptions?.발전차_기본대수?.화면_문구;
  if (genNote && genNoteText) genNote.textContent = genNoteText;

  const computeHourInWorker = createGridWorker();

  const map = L.map("map", { center: [PARK_CENTER.lat, PARK_CENTER.lon], zoom: 15 });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  const noiseLayer = new CanvasCellLayer({ palette: NOISE_PALETTE }).addTo(map);
  const exhaustLayer = new CanvasCellLayer({ palette: EXHAUST_PALETTE }).addTo(map);

  L.control.scale({ metric: true, imperial: false, position: "bottomleft" }).addTo(map);
  const MapLegend = L.Control.extend({
    options: { position: "topright" },
    onAdd() {
      const box = L.DomUtil.create("div", "olpak-map-legend");
      box.style.cssText = "background:#fff;padding:8px 10px;border-radius:4px;box-shadow:0 1px 4px rgba(0,0,0,0.4);font-size:0.78rem;line-height:1.5;max-width:180px;";
      const row = (color, label) => `<div><span style="display:inline-block;width:12px;height:12px;margin-right:6px;vertical-align:middle;background:${color}"></span>${label}</div>`;
      box.innerHTML = `
        <div style="font-weight:bold;margin-bottom:2px;">소음</div>
        ${row(NOISE_PALETTE.강, "강(65dB↑)")}
        ${row(NOISE_PALETTE.중, "중(55~65)")}
        ${row(NOISE_PALETTE.약, "약(45~55)")}
        <div style="font-weight:bold;margin:6px 0 2px;">배출가스</div>
        ${row(EXHAUST_PALETTE.강, "강")}
        ${row(EXHAUST_PALETTE.중, "중")}
        ${row(EXHAUST_PALETTE.약, "약")}
        ${row(NOISE_PALETTE.uncertain, "모름/불확실")}
      `;
      L.DomEvent.disableClickPropagation(box);
      return box;
    },
  });
  new MapLegend().addTo(map);

  document.getElementById("add-truck").addEventListener("click", () => {
    state.trucks.push({ id: `t${Date.now()}${Math.random().toString(36).slice(2, 6)}`, site: null, 발전기수: null, 인증등급: "모름", 엔진출력_kW: null, 시작시각: null, 셋업시작: null });
    saveTrucks();
    renderTruckTable(onTruckChange);
  });
  document.getElementById("add-nogen").addEventListener("click", () => {
    state.noGeneratorDays.push({ id: `n${Date.now()}${Math.random().toString(36).slice(2, 6)}`, site: null, 날짜: null });
    saveList(NOGEN_STORAGE_KEY, state.noGeneratorDays);
    renderNoGenTable(onNoGenChange);
  });
  function onNoGenChange() {
    saveList(NOGEN_STORAGE_KEY, state.noGeneratorDays);
    state.cellCache.clear();
    refresh();
  }
  renderNoGenTable(onNoGenChange);

  document.getElementById("export-trucks").addEventListener("click", () => {
    const payload = {
      _설명: "station.html에서 내보낸 발전차 입력값 — data/generator_inputs.json 자리에 덮어써서 커밋하면 시민 화면에 반영돼요.",
      내보낸시각: new Date().toISOString(), trucks: state.trucks,
      미사용: state.noGeneratorDays.filter((r) => r.site && r.날짜).map(({ site, 날짜 }) => ({ site, 날짜 })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "generator_inputs.json";
    a.click();
    URL.revokeObjectURL(url);
  });
  function onTruckChange() {
    saveTrucks();
    state.cellCache.clear();
    refreshSliderBand();
    refresh();
  }
  renderTruckTable(onTruckChange);

  document.getElementById("add-event").addEventListener("click", () => {
    state.manualEvents.push({ id: `e${Date.now()}${Math.random().toString(36).slice(2, 6)}`, title: null, site: null, 날짜: null, 시작: null, 소요분: null });
    saveManualEvents();
    renderManualEventsTable(onEventChange);
  });
  function onEventChange() {
    saveManualEvents();
    state.cellCache.clear(); // 11/26: 이제 계산에 들어가니 agency.js와 달리 캐시도 비워요
    refresh();
  }
  renderManualEventsTable(onEventChange);

  document.getElementById("scenario-default").addEventListener("change", (e) => {
    state.배출시나리오_기본값 = e.target.value;
    state.cellCache.clear();
    refresh();
  });

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

  const layerWarningEl = document.getElementById("layer-warning");
  function renderLayerWarnings(cells, weather) {
    const lines = [];
    for (const key of ["exhaust", "noise"]) {
      const layerCells = cells.filter((c) => c.layer === key);
      if (allCellsUnknown(layerCells)) lines.push(uniformUnknownMessage(key, layerCells, weather));
    }
    layerWarningEl.innerHTML = lines.map((l) => `<div>${l}</div>`).join("");
  }

  const sliderBandEl = document.getElementById("slider-band");
  function refreshSliderBand() {
    const segs = [];
    for (let offset = 0; offset < NUM_HOURS; offset++) {
      const weather = resolveWeather(hourSlotDate(offset));
      const hourIso = hourSlotIso(hourSlotDate(offset));
      const hasGenerators = buildGeneratorSources(hourIso).length > 0;
      const impossible = hasGenerators && weather && weather.wsd10m < 1.0;
      segs.push(`<div class="slider-seg${impossible ? " impossible" : ""}" title="${impossible ? "이 시간은 매연을 계산 못 해요(약풍)" : ""}"></div>`);
    }
    sliderBandEl.innerHTML = segs.join("");
  }

  let refreshSeq = 0;
  async function refresh() {
    const mySeq = ++refreshSeq;
    const offset = Number(slider.value);
    const date = hourSlotDate(offset);
    const hourIso = hourSlotIso(date);
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
    renderAutoEvents(hourIso);

    const places = DEFAULT_PLACE_NAMES.map((name) => ({ name, ...pt(name) })).filter((p) => p.lat !== undefined);
    let placeCells = {};
    if (!warning) {
      const weather = resolveWeather(date);
      if (weather) {
        placeCells = placeCellsForHour({
          places, stageSources: buildStageSources(hourIso), generatorSources: buildGeneratorSources(hourIso),
          weather, hour: hourIso, concaweData: state.concaweData, 배출시나리오: state.배출시나리오_기본값,
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
