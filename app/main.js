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
import {
  PARK_CENTER, NOISE_PALETTE, EXHAUST_PALETTE, CanvasCellLayer, createGridWorker,
  hourSlotIso, weatherKey, toEngineWeather, hourSlotDate, formatSlotLabel, loadCommonData,
  buildDemoStageSources,
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
  배출시나리오: "인증", // 발전차 인증등급 가정(v2). "인증" = 시민 지도 기본(하린 11/23 결정), "비인증" = 비교 보기
  volumePreset: "기본",
  windOverride: null, // {windVecFromDeg, wsd10m} 또는 null(실제 예보 사용)
  cellCache: new Map(), // hourIso -> {cells, warnings}
};

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
  document.getElementById("generator-grade-unauthorized").addEventListener("change", (e) => {
    state.배출시나리오 = e.target.checked ? "비인증" : "인증";
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
