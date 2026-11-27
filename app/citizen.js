// app/citizen.js — 시민 화면 "최종판"(citizen.html). 11/26 친구 요청: 체크박스로 "가정"하던
// app/main.js(데모, index.html)는 그대로 두고, 사람이 아무것도 안 눌러도 실제 데이터로만
// 돌아가는 화면을 새로 만들었어요. 지도·격자 계산·Web Worker는 app/shared.js를 그대로
// 빌려 써서(main.js·agency.js와 같은 엔진, CLAUDE.md 4번) 로직이 갈라지지 않아요.
//
// main.js와 다른 점(전부 "보기 전용"으로 만들려고 뺀 것):
//  - 공연 중이라고 가정할 장소 체크박스 없음 — data/events.json의 실제 공연 일정이 자동으로
//    음원을 결정해요(buildRealEventStageSources, 오늘 main.js에 먼저 만든 걸 그대로 재사용).
//  - 음량 프리셋·발전차 대수 입력 없음 — 실내는 하린 확정값, 야외는 공단 기준 역산값("기본")
//    고정. 발전차는 공단 화면(agency.html)이 "내보내기"한 data/generator_inputs.json을 읽어요.
//  - 풍향·풍속 직접 설정 없음 — 기상청 예보만 써요.
//  - 장소별 보기(파란 점) 없음 — 사용자 요청으로 뺌(포크 세션 결정, decisions.md 참고).

import { placeCellsForHour, buildForecastSentences, DEFAULT_PLACE_NAMES } from "../engine/forecast_text.js";
import {
  PARK_CENTER, NOISE_PALETTE, EXHAUST_PALETTE, CanvasCellLayer, createGridWorker,
  hourSlotIso, weatherKey, toEngineWeather, hourSlotDate, formatSlotLabel, loadCommonData,
  buildRealEventStageSources, buildCitizenGeneratorSources, listTodaysRealEvents,
  allCellsUnknown, uniformUnknownMessage,
} from "./shared.js";

const NUM_HOURS = 72;
const EMPTY_VENUES = new Set(); // 체크박스가 없어서 "데모로 추가한 장소"는 항상 없음

const state = {
  weatherByHour: null, concaweData: null, siteByName: new Map(), assumptions: null, events: null,
  truckRecords: [], noGeneratorDays: [],
  cellCache: new Map(),
  placeSeries: null,
};
let placesCache = null;

function getPlaces() {
  if (!placesCache) {
    placesCache = DEFAULT_PLACE_NAMES.map((name) => {
      const f = state.siteByName.get(name);
      if (!f) return null;
      const [lon, lat] = f.geometry.coordinates;
      return { name, lat, lon };
    }).filter(Boolean);
  }
  return placesCache;
}

const computeHourInWorker = createGridWorker();

async function loadData() {
  const { weatherByHour, siteByName, assumptions, concaweData, events } = await loadCommonData();
  state.weatherByHour = weatherByHour;
  state.siteByName = siteByName;
  state.assumptions = assumptions;
  state.concaweData = concaweData;
  state.events = events;
  // 11/26: 공단이 agency.html에서 "내보내기"한 실제 발전차 정보(없으면 빈 목록 — 404도 그냥
  // 빈 목록으로 다뤄요, 아직 아무도 안 내보낸 상태일 수 있어서 에러로 막지 않음).
  try {
    const res = await fetch("./data/generator_inputs.json");
    const json = res.ok ? await res.json() : {};
    state.truckRecords = json.trucks ?? [];
    state.noGeneratorDays = json.미사용 ?? []; // 11/27: 공단 화면 '발전차 사용 안 함'
  } catch {
    state.truckRecords = [];
    state.noGeneratorDays = [];
  }
}

function resolveWeather(date) {
  const hourIso = hourSlotIso(date);
  return toEngineWeather(state.weatherByHour.get(weatherKey(date)), hourIso);
}

function buildStageSources(hourIso) {
  return buildRealEventStageSources(state.events, state.siteByName, "기본", state.assumptions, hourIso, EMPTY_VENUES);
}
function buildGeneratorSourcesForHour(hourIso) {
  return buildCitizenGeneratorSources({
    events: state.events, truckRecords: state.truckRecords, noGeneratorDays: state.noGeneratorDays, siteByName: state.siteByName,
    assumptions: state.assumptions, hourIso,
  });
}

async function getCellsForHour(date) {
  const hourIso = hourSlotIso(date);
  if (state.cellCache.has(hourIso)) return state.cellCache.get(hourIso);

  const weather = resolveWeather(date);
  if (!weather) {
    const result = { cells: [], warning: "이 시각은 기상 자료가 없어 계산하지 않았어요(자료 부족)." };
    state.cellCache.set(hourIso, result);
    return result;
  }

  const stageSources = buildStageSources(hourIso);
  const generatorSources = buildGeneratorSourcesForHour(hourIso);
  const { cells, error } = await computeHourInWorker({
    stageSources, generatorSources, weather, hour: hourIso, noiseScenario: "concawe", concaweData: state.concaweData,
    배출시나리오: "인증",
  });
  const result = error ? { cells: [], warning: `계산 오류: ${error}` } : { cells, warning: null };
  state.cellCache.set(hourIso, result);
  return result;
}

// 문장 예보가 쓰는 72시간 치 8장소 시리즈. main.js와 같은 구조예요.
function buildPlaceSeries() {
  const places = getPlaces();
  const series = [];
  for (let offset = 0; offset < NUM_HOURS; offset++) {
    const date = hourSlotDate(offset);
    const weather = resolveWeather(date);
    if (!weather) continue;
    const hourIso = hourSlotIso(date);
    series.push({
      hour: hourIso, weather,
      cellsByPlace: placeCellsForHour({
        places, stageSources: buildStageSources(hourIso), generatorSources: buildGeneratorSourcesForHour(hourIso),
        weather, hour: hourIso, concaweData: state.concaweData, 배출시나리오: "인증",
      }),
    });
  }
  return series;
}
function getPlaceSeries() {
  if (!state.placeSeries) state.placeSeries = buildPlaceSeries();
  return state.placeSeries;
}

async function main() {
  await loadData();

  // 11/27 하린 지시: 발전차 대수를 가정값으로 자동 채운다는 걸 화면에 명시
  const genNote = document.getElementById("generator-count-note");
  const genNoteText = state.assumptions?.발전차_기본대수?.화면_문구;
  if (genNote && genNoteText) genNote.textContent = genNoteText;

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

  let gpsMarker = null;
  let gpsAccuracyCircle = null;
  map.on("locationfound", (e) => {
    if (!gpsMarker) {
      gpsMarker = L.circleMarker(e.latlng, { radius: 7, color: "#fff", weight: 2, fillColor: "#1a73e8", fillOpacity: 1 }).addTo(map);
      gpsMarker.bindTooltip("내 위치(GPS)", { direction: "top" });
    } else {
      gpsMarker.setLatLng(e.latlng);
    }
    if (!gpsAccuracyCircle) {
      gpsAccuracyCircle = L.circle(e.latlng, { radius: e.accuracy, color: "#1a73e8", weight: 1, fillOpacity: 0.08 }).addTo(map);
    } else {
      gpsAccuracyCircle.setLatLng(e.latlng).setRadius(e.accuracy);
    }
  });
  map.on("locationerror", () => { /* 위치 접근 거절/실패 — 필수 기능 아님 */ });
  map.locate({ watch: true, setView: false, enableHighAccuracy: true });

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
  const layerWarningEl = document.getElementById("layer-warning");

  function renderLayerWarnings(cells, weather) {
    const lines = [];
    for (const key of ["exhaust", "noise"]) {
      const layerCells = cells.filter((c) => c.layer === key);
      if (allCellsUnknown(layerCells)) lines.push(uniformUnknownMessage(key, layerCells, weather));
    }
    layerWarningEl.innerHTML = lines.map((l) => `<div>${l}</div>`).join("");
  }

  const autoEventsEl = document.getElementById("auto-events");
  function renderAutoEvents(hourIso) {
    const items = listTodaysRealEvents(state.events, hourIso);
    autoEventsEl.innerHTML = items.length
      ? items.map((e) => `<div>${e.site} — ${e.title} (${e.startTimeStr ? e.startTimeStr + " 시작" : "그날 시작 시각 모름"})${e.요일추정 ? " — 공연 시각은 공단 일정 페이지 문장에서 읽은 값이에요(요일별로 바뀔 수 있음)" : ""}</div>`).join("")
      : "<div>지금 자동으로 찾은 실제 공연 일정이 없어요.</div>";
  }

  let refreshSeq = 0;
  function renderCells(cells, warning, date) {
    warningEl.textContent = warning ?? "";
    const noiseCells = cells.filter((c) => c.layer === "noise");
    const exhaustCells = cells.filter((c) => c.layer === "exhaust");
    const weather = resolveWeather(date);
    renderLayerWarnings(cells, weather);
    noiseLayer.setCells(allCellsUnknown(noiseCells) ? [] : noiseCells, 25);
    exhaustLayer.setCells(allCellsUnknown(exhaustCells) ? [] : exhaustCells, 25);
    renderAutoEvents(hourSlotIso(date));
    refreshForecastSentences();
  }
  async function refresh() {
    const mySeq = ++refreshSeq;
    const offset = Number(slider.value);
    const date = hourSlotDate(offset);
    const hourIso = hourSlotIso(date);
    sliderLabel.textContent = formatSlotLabel(date);
    if (!state.cellCache.has(hourIso)) warningEl.textContent = "계산 중…";
    const { cells, warning } = await getCellsForHour(date);
    if (mySeq !== refreshSeq) return;
    renderCells(cells, warning, date);
  }
  function renderCachedIfAvailable(offset) {
    const date = hourSlotDate(offset);
    const hourIso = hourSlotIso(date);
    const cached = state.cellCache.get(hourIso);
    if (!cached) return;
    refreshSeq++;
    renderCells(cached.cells, cached.warning, date);
  }
  let prefetchToken = 0;
  async function prefetchAllHours() {
    const myToken = ++prefetchToken;
    for (let offset = 0; offset < NUM_HOURS; offset++) {
      if (myToken !== prefetchToken) return;
      await getCellsForHour(hourSlotDate(offset));
    }
  }

  const sliderBandEl = document.getElementById("slider-band");
  function refreshSliderBand() {
    const segs = [];
    for (let offset = 0; offset < NUM_HOURS; offset++) {
      const weather = resolveWeather(hourSlotDate(offset));
      const hourIso = hourSlotIso(hourSlotDate(offset));
      const hasGenerators = buildGeneratorSourcesForHour(hourIso).length > 0;
      const impossible = hasGenerators && weather && weather.wsd10m < 1.0;
      segs.push(`<div class="slider-seg${impossible ? " impossible" : ""}" title="${impossible ? "이 시간은 매연을 계산 못 해요(약풍)" : ""}"></div>`);
    }
    sliderBandEl.innerHTML = segs.join("");
  }

  const sentencesEl = document.getElementById("forecast-sentences");
  function refreshForecastSentences() {
    const series = getPlaceSeries();
    const lines = buildForecastSentences({ series, now: hourSlotIso(hourSlotDate(0)) });
    sentencesEl.innerHTML = lines.length
      ? lines.map((l, i) => `<div>${i + 1}. ${l}</div>`).join("")
      : "<div>주요 장소 8곳에 '약' 이상으로 예보된 소음·배출가스가 없어요.</div>";
  }

  sliderLabel.textContent = formatSlotLabel(hourSlotDate(0));
  slider.addEventListener("change", refresh);
  slider.addEventListener("input", (e) => {
    const offset = Number(e.target.value);
    sliderLabel.textContent = formatSlotLabel(hourSlotDate(offset));
    renderCachedIfAvailable(offset);
  });

  refreshSliderBand();
  refresh();
  prefetchAllHours();
}

main().catch((err) => {
  document.body.insertAdjacentHTML("beforeend", `<p style="color:red">초기화 실패: ${err.message}</p>`);
  console.error(err);
});
