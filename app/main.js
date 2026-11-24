// app/main.js — 시민 화면(index.html)의 지도·격자 색 표시·시간 슬라이더.
// 로드맵 M3(11/22~25) "친구" 담당: 지도, 격자 색 표시, 시간 슬라이더.
//
// ⚠️ 지금은 데모/시연 단계예요. 실제 공연 일정(data/events.json)·강좌 시간표는
// 아직 빈 자리라서(11/23·11/24 작업), 이 화면은 "공연 있다고 가정하고 버튼으로
// 켜고 끄는" 데모 음원을 써요. 음원 세기(LW)도 공단 측정 기준 답이 아직 없어서
// 가정값이에요 — 로드맵 §2 11/22 결론대로 "엔진 만져 보기(풍향·음량 바꿔 보기)"
// 용도로 만든 화면이라, 숫자 자체보다 지도·슬라이더가 엔진과 잘 연결되는지를
// 보는 게 목적이에요.

import { skyCodeToName, stabilityFromForecast } from "../engine/plume.js";
import { placeCellsForHour, buildForecastSentences, DEFAULT_PLACE_NAMES } from "../engine/forecast_text.js";
import { buildPlaceTimeline } from "../engine/place_view.js";
import { renderPlaceTimeline } from "./place_view_ui.js";
import {
  PARK_CENTER, NOISE_PALETTE, EXHAUST_PALETTE, CanvasCellLayer, createGridWorker,
  hourSlotIso, weatherKey, toEngineWeather, hourSlotDate, formatSlotLabel, loadCommonData,
  buildDemoStageSources, allCellsUnknown, uniformUnknownMessage,
} from "./shared.js";

const NUM_HOURS = 72; // 로드맵: 지금부터 6시간(초단기)+3일(단기), 1시간 단위

// ---------------------------------------------------------------------------
// 앱 상태
// ---------------------------------------------------------------------------
const state = {
  weatherByHour: null,
  concaweData: null,
  siteByName: new Map(),
  selectedVenues: new Set(),
  generatorCount: 0,
  배출시나리오: "인증", // 발전차 인증등급 가정(v2). 시민 화면은 "인증" 고정(하린 11/23 결정) — 비인증 비교는 공단 화면(agency.js)에만(하린 11/24 결정)
  volumePreset: "기본",
  windOverride: null, // {windVecFromDeg, wsd10m} 또는 null(실제 예보 사용)
  cellCache: new Map(), // hourIso -> {cells, warnings}
  placeSeries: null, // 장소별 보기·문장 예보가 같이 쓰는 72시간 치 8장소 시리즈(설정 바뀌면 null로 비움)
};
let placesCache = null;

/** 문장 예보·장소별 보기 표준 장소 8곳의 좌표(site.geojson 기준, 한 번만 계산해 재사용). */
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
  const { weatherByHour, siteByName, assumptions, concaweData } = await loadCommonData();
  state.weatherByHour = weatherByHour;
  state.siteByName = siteByName;
  state.assumptions = assumptions;
  state.concaweData = concaweData;
  return { assumptions };
}

// 11/24 하린 지시(배출가스 v2, 커밋 813eef1): "발전차 대수"는 이제 발전차(트럭) 수예요 —
// 트럭 한 대 = 발전기 2대(국내 렌탈 조사 기준, engine/plume_v2.js V2_ASSUMPTIONS). 엔진출력·
// 인증등급을 안 넣으면 v2가 대표모델(Cat XQ230, 320마력) 가정값을 쓰고 꼬리표도 붙여줘요.
function buildGeneratorSources() {
  if (state.generatorCount <= 0) return [];
  const feature = state.siteByName.get("KSPO DOME");
  const [lon, lat] = feature.geometry.coordinates;
  return Array.from({ length: state.generatorCount }, () => ({
    lat, lon,
    정보출처: "시연용가정",
    time: { start: "2026-01-01T00:00:00+09:00", end: "2026-12-31T23:00:00+09:00", 출처: "데모" },
  }));
}

// 알려진 한계(6차 외부 검토, 하린 — "동결 후 미해결로 남겨도 됨" 합의): 이 함수가 계산을
// 끝낸 뒤 state.cellCache에 쓰는 시점 자체는 refresh()의 요청 순번 검사를 안 거쳐요 —
// 화면에 "그리는 것"은 refresh()의 refreshSeq로 막아뒀지만(최신 요청이 아니면 안 그림),
// 아주 드물게 늦게 끝난 옛 요청이 캐시"값"을 새 값 뒤에 다시 덮어쓸 수 있어요(그 시각으로
// 나중에 다시 돌아오면 잠깐 옛 값이 보일 수 있음). 동결 전 급한 문제는 아니라고 봐서 보류.
/** 그 시각 엔진 입력 날씨 — 실제 예보 또는 사용자가 직접 설정한 값. 지도 격자 계산과
 * 장소별 보기·문장 예보 시리즈(buildPlaceSeries)가 똑같이 이 함수를 써요(하린 11/24
 * 요청의 전제 — 지도·장소별 보기·문장 예보가 항상 같은 답을 내야 해요). */
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

async function getCellsForHour(date) {
  const hourIso = hourSlotIso(date);
  if (state.cellCache.has(hourIso)) return state.cellCache.get(hourIso);

  const weather = resolveWeather(date);
  if (!weather) {
    const result = { cells: [], warning: "이 시각은 기상 자료가 없어 계산하지 않았어요(자료 부족)." };
    state.cellCache.set(hourIso, result);
    return result;
  }

  const stageSources = buildDemoStageSources(state.selectedVenues, state.siteByName, state.volumePreset);
  const generatorSources = buildGeneratorSources();
  const { cells, error } = await computeHourInWorker({
    stageSources, generatorSources, weather, hour: hourIso, noiseScenario: "concawe", concaweData: state.concaweData,
    배출시나리오: state.배출시나리오,
  });
  const result = error ? { cells: [], warning: `계산 오류: ${error}` } : { cells, warning: null };
  state.cellCache.set(hourIso, result);
  return result;
}

// 장소별 보기(app/place_view_ui.js)·문장 예보(engine/forecast_text.js)가 같이 쓰는 72시간
// 치 시리즈예요. 표준 장소 8곳만 계산해서(24,178칸짜리 지도 격자보다 훨씬 가벼움) Web
// Worker 없이 메인 스레드에서 바로 돌려요. 설정이 바뀌면 state.placeSeries를 null로
// 비워서 다음에 쓸 때 다시 계산하게 해요(지도 캐시 비우는 자리마다 같이 비워요).
function buildPlaceSeries() {
  const places = getPlaces();
  const stageSources = buildDemoStageSources(state.selectedVenues, state.siteByName, state.volumePreset);
  const generatorSources = buildGeneratorSources();
  const series = [];
  for (let offset = 0; offset < NUM_HOURS; offset++) {
    const date = hourSlotDate(offset);
    const weather = resolveWeather(date);
    if (!weather) continue;
    const hourIso = hourSlotIso(date);
    series.push({
      hour: hourIso, weather,
      cellsByPlace: placeCellsForHour({
        places, stageSources, generatorSources, weather, hour: hourIso, concaweData: state.concaweData,
        배출시나리오: state.배출시나리오,
      }),
    });
  }
  return series;
}
function getPlaceSeries() {
  if (!state.placeSeries) state.placeSeries = buildPlaceSeries();
  return state.placeSeries;
}

// ---------------------------------------------------------------------------
// 지도 + UI
// ---------------------------------------------------------------------------
async function main() {
  const { assumptions } = await loadData();

  const map = L.map("map", { center: [PARK_CENTER.lat, PARK_CENTER.lon], zoom: 15 });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  const noiseLayer = new CanvasCellLayer({ palette: NOISE_PALETTE }).addTo(map);
  const exhaustLayer = new CanvasCellLayer({ palette: EXHAUST_PALETTE }).addTo(map);

  // 장소별 보기(하린 11/24 요청) — 표준 장소 8곳에 점을 찍고, 누르면 그 장소의 72시간
  // 소음·배출가스 시간표를 보여줘요(app/place_view_ui.js의 renderPlaceTimeline 그대로 재사용).
  const placeViewPanel = document.getElementById("place-view");
  const placeMarkersLayer = L.layerGroup().addTo(map);
  for (const p of getPlaces()) {
    const marker = L.circleMarker([p.lat, p.lon], {
      radius: 6, color: "#1565c0", weight: 2, fillColor: "#64b5f6", fillOpacity: 0.9,
    }).addTo(placeMarkersLayer);
    marker.bindTooltip(p.name, { direction: "top" });
    marker.on("click", () => {
      const timeline = buildPlaceTimeline({ series: getPlaceSeries(), placeName: p.name });
      placeViewPanel.hidden = false;
      renderPlaceTimeline(placeViewPanel, timeline, { onClose: () => { placeViewPanel.hidden = true; } });
    });
  }

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
      state.placeSeries = null;
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
    state.placeSeries = null;
    refresh();
  });
  document.getElementById("generator-count").addEventListener("change", (e) => {
    state.generatorCount = Number(e.target.value) || 0;
    state.cellCache.clear();
    state.placeSeries = null;
    refreshSliderBand();
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
    state.placeSeries = null;
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
  // 11/25 하린 결정: 그 시각 한 레이어가 "전부" 모름(예: 약풍이라 발전차 확산을 계산
  // 못 함)이면 칸을 회색 점무늬로 칠하는 대신 지도 위 띠로 "왜 못 그렸는지" 말해줘요 —
  // 지도 전체가 고장처럼 회색으로 덮이는 걸 막으면서도, "모름≠빈칸"(5차 외부 검토) 원칙은
  // 띠 문구로 그대로 지켜요. 일부만 모름이거나(시간미확인 등) 빗금(근거리)은 그대로 칸으로 보여줘요.
  const layerWarningEl = document.getElementById("layer-warning");
  function renderLayerWarnings(cells, weather) {
    const lines = [];
    for (const [key, label] of [["exhaust", "exhaust"], ["noise", "noise"]]) {
      const layerCells = cells.filter((c) => c.layer === key);
      if (allCellsUnknown(layerCells)) lines.push(uniformUnknownMessage(key, layerCells, weather));
    }
    layerWarningEl.innerHTML = lines.map((l) => `<div>${l}</div>`).join("");
  }

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
    const noiseCells = cells.filter((c) => c.layer === "noise");
    const exhaustCells = cells.filter((c) => c.layer === "exhaust");
    const weather = resolveWeather(date);
    renderLayerWarnings(cells, weather);
    noiseLayer.setCells(allCellsUnknown(noiseCells) ? [] : noiseCells, 25);
    exhaustLayer.setCells(allCellsUnknown(exhaustCells) ? [] : exhaustCells, 25);
    refreshForecastSentences();
  }

  // 슬라이더 위 회색 구간 — 어느 시간이 "매연을 계산 못 하는 시간"(발전차는 있는데 바람이
  // 1m/s 미만)인지 미리 보여줘요. 격자 전체를 72번 돌릴 필요 없이, 그 조건(약풍미표시는
  // plume.js가 바람 자체로 판정)을 날씨만 보고 미리 알 수 있어요(지금 엔진에서 소음이
  // 똑같이 "전부 모름"이 되는 경우는 없어요 — 생기면 이 자리에 조건을 더 추가하면 돼요).
  const sliderBandEl = document.getElementById("slider-band");
  function refreshSliderBand() {
    const segs = [];
    for (let offset = 0; offset < NUM_HOURS; offset++) {
      const weather = resolveWeather(hourSlotDate(offset));
      const impossible = state.generatorCount > 0 && weather && weather.wsd10m < 1.0;
      segs.push(`<div class="slider-seg${impossible ? " impossible" : ""}" title="${impossible ? "이 시간은 매연을 계산 못 해요(약풍)" : ""}"></div>`);
    }
    sliderBandEl.innerHTML = segs.join("");
  }

  // 문장 예보(하린 11/24 요청) — 지도 아래에 최대 5줄, buildForecastSentences 그대로 재사용.
  // 장소별 보기와 같은 placeSeries를 쓰니까 지도·장소별 보기·문장 예보가 항상 같은 답이에요.
  const sentencesEl = document.getElementById("forecast-sentences");
  function refreshForecastSentences() {
    const series = getPlaceSeries();
    const lines = buildForecastSentences({ series, now: hourSlotIso(hourSlotDate(0)) });
    sentencesEl.innerHTML = lines.length
      ? lines.map((l, i) => `<div>${i + 1}. ${l}</div>`).join("")
      : "<div>주요 장소 8곳에 '약' 이상으로 예보된 소음·배출가스가 없어요.</div>";
  }

  sliderLabel.textContent = formatSlotLabel(hourSlotDate(0));
  slider.addEventListener("change", refresh); // 로드맵 권고: 슬라이더를 "놓았을 때"만 계산
  slider.addEventListener("input", (e) => { sliderLabel.textContent = formatSlotLabel(hourSlotDate(Number(e.target.value))); });

  refreshSliderBand();
  refresh();
}

main().catch((err) => {
  document.body.insertAdjacentHTML("beforeend", `<p style="color:red">초기화 실패: ${err.message}</p>`);
  console.error(err);
});
