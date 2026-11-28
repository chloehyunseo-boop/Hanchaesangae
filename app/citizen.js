// 11/27 하린·친구 합의: 디자인 시안 C(citizen_design_c.html + app/citizen_design.js)를 그대로 옮겨 왔어요.
// 지도 색은 블러 대신 등치선 면(app/contour_layer.js). 계산·데이터 로직은 바뀌지 않았어요.
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

import { placeCellsForHour, buildForecastSentences, DEFAULT_PLACE_NAMES } from "../engine/forecast_text.js?v=20261128d";
import {
  PARK_CENTER, NOISE_PALETTE, EXHAUST_PALETTE, CanvasCellLayer, createGridWorker,
  hourSlotIso, weatherKey, toEngineWeather, hourSlotDate, kstParts, formatSlotLabel, loadCommonData,
  buildRealEventStageSources, buildCitizenGeneratorSources, listTodaysRealEvents,
  allCellsUnknown, uniformUnknownMessage, setupWeatherFreshness, initTabs,
} from "./shared.js?v=20261128p";
import { setupEventsNotice, eventsEmptyMessage } from "./events_notice.js?v=20261128a"; // 11/28: 공연 일정 수집 실패·멈춤 안내
import { ContourCellLayer } from "./contour_layer.js?v=20261128p"; // 디자인 사본: 블러 대신 등치선 면
import { createGeneratorMarkers } from "./generator_markers.js?v=20261128d"; // 11/28: 지도에 발전차 위치
import { generatorActivityAtHour } from "../engine/combine.js";

// 11/28 최종 점검: 공연명·장소는 공단 홈페이지 글(자동 수집)이나 공단 직원이 입력한 글이라 그대로 innerHTML에
// 넣으면 '<오페라의 유령>'처럼 꺾쇠가 든 이름이 깨지거나 스크립트가 실행돼요. 화면에 넣기 전에 이스케이프해요.
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

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
  const { weatherByHour, weatherSavedAt, siteByName, assumptions, concaweData, events } = await loadCommonData();
  state.weatherByHour = weatherByHour;
  setupWeatherFreshness(weatherSavedAt, { metaEl: document.querySelector("header.top .meta"), metaSuffix: "" });
  state.siteByName = siteByName;
  state.assumptions = assumptions;
  state.concaweData = concaweData;
  state.events = events;
  setupEventsNotice(events);
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

// 11/28 독립 검토: 첫 로드에서 화면 갱신과 미리 계산이 같은 시각을 동시에 요청해 20~40초짜리 계산이 두 번 돌았어요.
// 같은 시각이 계산 중이면 그 결과를 같이 기다려요.
const inflightCells = new Map();
function getCellsForHour(date) {
  const hourIso = hourSlotIso(date);
  if (state.cellCache.has(hourIso)) return Promise.resolve(state.cellCache.get(hourIso));
  if (inflightCells.has(hourIso)) return inflightCells.get(hourIso);
  const p = computeCellsForHour(date).finally(() => inflightCells.delete(hourIso));
  inflightCells.set(hourIso, p);
  return p;
}
async function computeCellsForHour(date) {
  const hourIso = hourSlotIso(date);
  if (state.cellCache.has(hourIso)) return state.cellCache.get(hourIso);

  const weather = resolveWeather(date);
  if (!weather) {
    const result = { cells: [], warning: "이 시각 기상 자료 없음, 계산 안 함" };
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
  initTabs({ defaultTab: "forecast" });

  // 11/27 하린 지시: 발전차 대수를 가정값으로 자동 채운다는 걸 화면에 명시
  const genNote = document.getElementById("generator-count-note");
  const genNoteText = state.assumptions?.발전차_기본대수?.화면_문구;
  if (genNote && genNoteText) genNote.textContent = genNoteText;

  const map = L.map("map", { center: [PARK_CENTER.lat, PARK_CENTER.lon], zoom: 15, zoomSnap: 0.25 }); // 디자인 사본: 0.25 단위 확대로 공원이 꽉 차게
  // OpenFreeMap Bright(MapLibre 벡터타일) — maplibre-gl-leaflet로 Leaflet 지도 위에 올림(11/27).
  L.maplibreGL({
    style: "https://tiles.openfreemap.org/styles/bright",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  const noiseLayer = new ContourCellLayer({ palette: NOISE_PALETTE }).addTo(map);
  const exhaustLayer = new ContourCellLayer({ palette: EXHAUST_PALETTE }).addTo(map);
  const genMarkers = createGeneratorMarkers(map, generatorActivityAtHour);

  L.control.scale({ metric: true, imperial: false, position: "bottomleft" }).addTo(map);
  // 창 크기가 바뀌면 지도 칸 크기도 바뀌어서 다시 맞춰요(친구 11/27 원본 수정 반영)
  window.addEventListener("resize", () => map.invalidateSize());

  // 디자인 사본(11/27): 범례는 오른쪽 패널(html)로 옮겨서 지도 위 상자는 없앰.
  // 지도는 공원과 주요 장소 8곳이 한눈에 들어오게 맞춰요(양옆 여백 최소).
  const pl = getPlaces();
  // 시안 B처럼 지도 위에 패널이 떠 있으면 #map의 data-fit-pad="위,오른쪽,아래,왼쪽"(px)만큼 비워 두고 맞춰요(넓은 화면만).
  const padAttr = document.getElementById("map").dataset.fitPad;
  const [pt, pr, pb, plft] = padAttr && window.innerWidth > 860 ? padAttr.split(",").map(Number) : [0, 0, 0, 0];
  if (pl.length) map.fitBounds(L.latLngBounds(pl.map((p) => [p.lat, p.lon])).pad(0.03), { animate: false, paddingTopLeft: [plft, pt], paddingBottomRight: [pr, pb] });

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
    if (e.target.checked) exhaustLayer.addTo(map); else map.removeLayer(exhaustLayer); genMarkers.setVisible(e.target.checked);
  });

  const slider = document.getElementById("time-slider");
  slider.min = "0";
  slider.max = String(NUM_HOURS - 1);
  slider.value = "0";
  const sliderLabel = document.getElementById("slider-label");
  const warningEl = document.getElementById("slider-warning");
  const layerWarningEl = document.getElementById("layer-warning");

  function renderLayerWarnings(cells, weather, warning = null) {
    const lines = [];
    // 11/28 독립 검토: 기상 자료가 없는 시각엔 지도가 빈칸인데 안내가 슬라이더 옆 작은 글씨뿐이었어요.
    if (warning) lines.push(esc(warning));
    for (const key of ["exhaust", "noise"]) {
      const layerCells = cells.filter((c) => c.layer === key);
      if (allCellsUnknown(layerCells)) lines.push(uniformUnknownMessage(key, layerCells, weather));
    }
    layerWarningEl.innerHTML = lines.map((l) => `<div>${l}</div>`).join("");
  }

  const autoEventsEl = document.getElementById("auto-events");
  // 11/28 하린: 공단 화면과 같이 앞으로 2주 공연을 날짜별로 보여주고, 날짜를 누르면 시간 막대가
  // 그날 첫 공연 시각으로 이동해요(72시간 예측 범위 안일 때만).
  const SCHEDULE_DAYS = 14;
  const ymdOf = (d) => { const { y, m, d: dd } = kstParts(d); return `${y}-${m}-${dd}`; };
  function renderAutoEvents(hourIso) {
    const selDay = ymdOf(new Date(hourIso));
    const start = hourSlotDate(0);
    const fmt = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", weekday: "short" });
    const blocks = [];
    for (let i = 0; i < SCHEDULE_DAYS; i++) {
      const day = ymdOf(new Date(start.getTime() + i * 86400e3));
      const items = listTodaysRealEvents(state.events, `${day}T12:00:00+09:00`)
        .sort((p, q) => String(p.startTimeStr ?? "99").localeCompare(String(q.startTimeStr ?? "99")));
      if (!items.length) continue;
      const firstHour = items.find((x) => x.startTimeStr)?.startTimeStr?.slice(0, 2) ?? null;
      let offset = -1;
      for (let o = 0; o < NUM_HOURS; o++) {
        const d = hourSlotDate(o);
        if (ymdOf(d) !== day) continue;
        if (offset < 0) offset = o;
        if (firstHour && kstParts(d).h === firstHour) { offset = o; break; }
      }
      const dp = Object.fromEntries(fmt.formatToParts(new Date(`${day}T12:00:00+09:00`)).map((x) => [x.type, x.value]));
      const hint = offset >= 0 ? (day === selDay ? "지도에 표시 중" : "지도에서 보기") : "예측 범위 밖";
      blocks.push(`<section class="day${day === selDay ? " sel" : ""}">
        <button type="button" class="day-head" ${offset >= 0 ? `data-offset="${offset}"` : "disabled"}><b>${dp.month}월 ${dp.day}일 (${dp.weekday})</b><small>${hint}</small></button>
        ${items.map((e) => `<div class="ev"><b>${esc(e.startTimeStr ?? "시각 미상")}</b> · ${esc(e.site)}<br><span>${esc(e.title)}</span></div>`).join("")}
      </section>`);
    }
    autoEventsEl.innerHTML = blocks.length ? blocks.join("") : `<p class="muted">${esc(eventsEmptyMessage(state.events))}</p>`;
  }
  autoEventsEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".day-head[data-offset]");
    if (!btn) return;
    slider.value = btn.dataset.offset;
    slider.dispatchEvent(new Event("input"));
    slider.dispatchEvent(new Event("change"));
  });


  let refreshSeq = 0;
  function renderCells(cells, warning, date) {
    warningEl.textContent = warning ?? "";
    const noiseCells = cells.filter((c) => c.layer === "noise");
    const exhaustCells = cells.filter((c) => c.layer === "exhaust");
    const weather = resolveWeather(date);
    renderLayerWarnings(cells, weather, warning);
    noiseLayer.setCells(allCellsUnknown(noiseCells) ? [] : noiseCells, 25);
    exhaustLayer.setCells(allCellsUnknown(exhaustCells) ? [] : exhaustCells, 25);
    genMarkers.update(buildGeneratorSourcesForHour(hourSlotIso(date)), hourSlotIso(date));
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
  // 11/28 친구 요청: 드래그하다 지도가 비어 보이면 "공연이 없어서"인지 "계산 중"인지
  // 구분이 안 돼요 — 공연·발전차 중 하나라도 있는 시간은 노란 칸으로 미리 표시해요
  // (impossible이 아니면, 즉 지도에 뭔가 뜰 가능성이 있는 시간만).
  function refreshSliderBand() {
    const segs = [];
    for (let offset = 0; offset < NUM_HOURS; offset++) {
      const weather = resolveWeather(hourSlotDate(offset));
      const hourIso = hourSlotIso(hourSlotDate(offset));
      const hasGenerators = buildGeneratorSourcesForHour(hourIso).length > 0;
      const hasStage = buildStageSources(hourIso).length > 0;
      const impossible = hasGenerators && weather && weather.wsd10m < 1.0;
      const active = !impossible && (hasGenerators || hasStage);
      const cls = impossible ? " impossible" : active ? " active" : "";
      const title = impossible ? "약풍이어서 배출가스 계산 불가" : active ? "공연·발전차 있음" : "";
      segs.push(`<div class="slider-seg${cls}" title="${title}"></div>`);
    }
    sliderBandEl.innerHTML = segs.join("");
    // 디자인 사본: 회색·노란 칸이 있을 때만 무슨 뜻인지 한 줄 표시
    const noteEl = document.getElementById("band-note");
    if (noteEl) {
      const notes = [];
      if (segs.some((x) => x.includes("impossible"))) notes.push('<i class="sw-impossible"></i>약풍이어서 배출가스 계산 불가');
      if (segs.some((x) => x.includes(" active"))) notes.push('<i class="sw-active"></i>공연·발전차 있는 시간');
      noteEl.innerHTML = notes.join(" · ");
    }
  }

  const sentencesEl = document.getElementById("forecast-sentences");
  function refreshForecastSentences() {
    const series = getPlaceSeries();
    const lines = buildForecastSentences({ series, now: hourSlotIso(hourSlotDate(0)), placeViewAvailable: false });
    sentencesEl.innerHTML = lines.length
      ? lines.map((l) => `<div>${l}</div>`).join("")
      : "<div style=\"color:var(--sub)\">주요 장소 8곳 모두 '약' 미만</div>";
  }

  sliderLabel.textContent = formatSlotLabel(hourSlotDate(0));
  // 시간 막대 아래 날짜 눈금(지금 · 다음 날 0시들)
  const ticksEl = document.getElementById("slider-ticks");
  if (ticksEl) {
    const marks = [[0, "지금"]];
    for (let o = 1; o < NUM_HOURS; o++) {
      const lab = formatSlotLabel(hourSlotDate(o));
      if (lab.endsWith(" 00시") && (o - marks[marks.length - 1][0]) / (NUM_HOURS - 1) >= 0.1) marks.push([o, lab.replace(" 00시", "")]); // 앞 눈금과 너무 가까우면 생략(겹침 방지)
    }
    ticksEl.innerHTML = marks.map(([o, m]) => `<span style="left:${(o / (NUM_HOURS - 1)) * 100}%;${o === 0 ? "" : "transform:translateX(-50%)"}">${m}</span>`).join("");
  }
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
