// 11/27 하린 확인: 디자인 시안(case_design.html + app/case_design.js)을 그대로 옮겨 왔어요. 계산 로직은 그대로.
// app/case.js — 사례 재현 화면(case.html), 하린 라인 (로드맵 11/26 "2024-10-12 재현 데모 모드").
//
// 시민 지도(main.js)·공단 화면(agency.js)은 건드리지 않고, 같은 부품(shared.js의 지도 칸 그리기·
// 색·Web Worker, engine/ 계산)을 그대로 빌려 써요. 다른 점은 입력뿐이에요:
//  - 날씨: 예보(weather.json)가 아니라 그날 실제 관측(data/case_20241012.json ← ASOS 서울)
//  - 공연: 자동 수집이 아니라 그날 실제 공연 3개(docs/사례_20241012_공연시각.md)
// 음원 세기·스펙트럼·지면은 shared.js의 buildDemoStageSources가 주는 값을 그대로 써요 —
// 친구가 음량(LW)을 바꾸면 이 화면도 자동으로 새 값으로 계산돼요(따로 고칠 필요 없음).
// 발전차(배출가스)는 넣지 않아요: 이 사례는 소음 간섭 보도예요(validation/case_20241012_demo.mjs와 같음).

import { stabilityFromForecast } from "../engine/plume.js";
import { computeNoiseCellConcawe } from "../engine/combine.js";
import { placeCellsForHour, DEFAULT_PLACE_NAMES } from "../engine/forecast_text.js";
import { placeCellState } from "../engine/place_view.js";
import {
  PARK_CENTER, NOISE_PALETTE, CanvasCellLayer, createGridWorker, loadCommonData,
  buildDemoStageSources, allCellsUnknown, uniformUnknownMessage, initTabs,
} from "./shared.js?v=20261129-5";
import { ContourCellLayer } from "./contour_layer.js?v=20261129-5";

const HOURS = [16, 17, 18, 19, 20, 21];
const DEFAULT_HOUR = 18;
const NEWS_FROM_MIN = 18 * 60; // 보도 "2막 중간" 추정 18:15 ±15분 → 18:00~18:30
const NEWS_TO_MIN = 18 * 60 + 30;

const state = { caseData: null, siteByName: null, concaweData: null, assumptions: null, excludeDome: true, cache: new Map() };

const pad = (n) => String(n).padStart(2, "0");
const iso = (date, hh, mm = "00") => `${date}T${pad(hh)}:${mm}:00+09:00`;
function hm(date, s) { const [h, m] = s.split(":"); return iso(date, h, m); }
function coords(name) {
  const f = state.siteByName.get(name);
  if (!f) throw new Error(`site.geojson에 없는 장소: ${name}`);
  const [lon, lat] = f.geometry.coordinates;
  return { lat, lon };
}

/** ASOS 전운량(0~10) → 안정도 계산용 하늘 상태. 기상청 공식 환산 아님(case_20241012.json "기상_가정"). */
function cloudToSky(c) { return c <= 5 ? "맑음" : c <= 8 ? "구름많음" : "흐림"; }

function weatherAt(hh) {
  const r = state.caseData.기상[pad(hh)];
  if (!r) return null;
  const hourIso = iso(state.caseData.날짜, hh);
  const { stability } = stabilityFromForecast({
    sky: cloudToSky(r.전운량_10분위), wsd10m: r.풍속_ms, lat: PARK_CENTER.lat, lon: PARK_CENTER.lon, dateUtc: new Date(hourIso),
  });
  return { tempC: r.기온_C, tmp: r.기온_C, rhPercent: r.습도_pct, windVecFromDeg: r.풍향_deg, wsd10m: r.풍속_ms, stability };
}

/** 그날 공연 → 음원. 세기·스펙트럼·지면은 시민 지도와 같은 함수(buildDemoStageSources)에서 받아요. */
function stageSources({ excludeDome }) {
  const out = [];
  for (const ev of state.caseData.공연) {
    if (excludeDome && ev.site === "KSPO DOME") continue;
    const base = buildDemoStageSources(new Set([ev.site]), state.siteByName, "기본")[0];
    if (!base) continue;
    // 실내 공연장은 외피 방사 값(엔진 입력 lwDb, docs/실내공연장_외피.md)을 써요(11/26). 없으면(올림픽홀·K아트홀) 야외값 그대로.
    const indoorLw = state.assumptions?.실내공연장_외피?.공연장?.[ev.site]?.엔진입력_lwDb;
    out.push({
      ...base,
      ...(Number.isFinite(indoorLw) ? { lwDb: indoorLw } : {}),
      ...coords(ev.음원좌표), // 야외 무대는 무대 좌표(CLAUDE.md 6번 좌표)
      time: { start: hm(state.caseData.날짜, ev.시작), end: hm(state.caseData.날짜, ev.끝), 출처: ev.출처 },
    });
  }
  return out;
}

async function cellsFor(hh, computeHourInWorker) {
  const key = `${hh}|${state.excludeDome}`;
  if (state.cache.has(key)) return state.cache.get(key);
  const weather = weatherAt(hh);
  let result;
  if (!weather) result = { cells: [], weather: null, warning: "이 시각 관측 자료 없음" };
  else {
    const { cells, error } = await computeHourInWorker({
      stageSources: stageSources({ excludeDome: state.excludeDome }), generatorSources: [], weather,
      hour: iso(state.caseData.날짜, hh), noiseScenario: "concawe", concaweData: state.concaweData,
    });
    result = error ? { cells: [], weather, warning: `계산 오류: ${error}` } : { cells, weather, warning: null };
  }
  state.cache.set(key, result);
  return result;
}

function windName(deg) {
  const names = ["북", "북북동", "북동", "동북동", "동", "동남동", "남동", "남남동", "남", "남남서", "남서", "서남서", "서", "서북서", "북서", "북북서"];
  return `${names[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16]}풍`;
}

function chip(st) {
  const bg = st.kind === "level" ? NOISE_PALETTE[st.level] : st.kind === "unknown" ? "#e0e0e0" : "transparent";
  const span = document.createElement("span");
  span.className = "chip";
  span.style.background = bg;
  span.textContent = st.kind === "none" ? "–" : st.text;
  return span;
}

function renderSide(hh) {
  const date = state.caseData.날짜;
  const hourIso = iso(date, hh);
  const weather = weatherAt(hh);
  const r = state.caseData.기상[pad(hh)];
  document.getElementById("weather-box").textContent = weather
    ? `${hh}시 관측: ${windName(r.풍향_deg)}(${r.풍향_deg}°) ${r.풍속_ms}m/s, 기온 ${r.기온_C}℃, 습도 ${r.습도_pct}%, 전운량 ${r.전운량_10분위}/10 → 대기 안정도 ${weather.stability}`
    : "관측 자료 없음";

  // 공연 표: 이 1시간 칸에 진행 중인지
  const tbl = document.getElementById("event-table");
  tbl.replaceChildren();
  const slotStart = Date.parse(hourIso), slotEnd = slotStart + 3600e3;
  for (const ev of state.caseData.공연) {
    const s = Date.parse(hm(date, ev.시작)), e = Date.parse(hm(date, ev.끝));
    const on = s < slotEnd && e > slotStart;
    const tr = document.createElement("tr");
    const td1 = document.createElement("td"); td1.innerHTML = `<span class="${on ? "on" : "off"}">${on ? "● 진행 중" : "○"}</span>`;
    const td2 = document.createElement("td");
    td2.textContent = `${ev.이름} — ${ev.site.replace(/\(.*\)/, "")} ${ev.시작}~${ev.끝}`;
    const note = document.createElement("div"); note.className = "muted"; note.textContent = `종료: ${ev.끝_근거}`;
    td2.appendChild(note);
    if (state.excludeDome && ev.site === "KSPO DOME") {
      const ex = document.createElement("div"); ex.className = "muted"; ex.textContent = "지도에서 뺌(바깥 소리만 보기)"; td2.appendChild(ex);
    }
    tr.append(td1, td2);
    tbl.appendChild(tr);
  }

  // 투란도트 관객석: KSPO DOME 좌표에서 바깥 공연 소리만
  const dome = document.getElementById("dome-result");
  if (!weather) dome.textContent = "관측 자료 없음";
  else {
    const cell = computeNoiseCellConcawe({ stageSources: stageSources({ excludeDome: true }), receiver: coords("KSPO DOME"), weather, hour: hourIso, concaweData: state.concaweData });
    const st = placeCellState(cell);
    const db = typeof cell.value === "number" && Number.isFinite(cell.value) && st.kind !== "unknown" ? ` (${cell.value.toFixed(1)} dB(A))` : "";
    dome.replaceChildren(chip(st), document.createTextNode(db));
  }

  // 주요 장소 8곳 (지도와 같은 음원 설정)
  const places = DEFAULT_PLACE_NAMES.map((name) => ({ name, ...coords(name) }));
  const pt = document.getElementById("place-table");
  pt.replaceChildren();
  if (weather) {
    const byPlace = placeCellsForHour({ places, stageSources: stageSources({ excludeDome: state.excludeDome }), generatorSources: [], weather, hour: hourIso, concaweData: state.concaweData });
    for (const p of places) {
      const tr = document.createElement("tr");
      const a = document.createElement("td"); a.textContent = p.name;
      const b = document.createElement("td"); b.appendChild(chip(placeCellState(byPlace[p.name]?.noise)));
      tr.append(a, b);
      pt.appendChild(tr);
    }
  }
}

async function main() {
  const [{ siteByName, concaweData, assumptions }, caseData] = await Promise.all([
    loadCommonData(),
    fetch("./data/case_20241012.json").then((r) => r.json()),
  ]);
  Object.assign(state, { siteByName, concaweData, caseData, assumptions });
  document.getElementById("lw-note").textContent = "가정값(야외: 공단 65dB 기준 역산, 실내: 최대 음량 100dB(A)와 유사 구조 지붕·벽 시험값)";

  const computeHourInWorker = createGridWorker();
  const map = L.map("map", { center: [PARK_CENTER.lat, PARK_CENTER.lon], zoom: 15 });
  L.maplibreGL({
    style: "https://tiles.openfreemap.org/styles/bright",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  const noiseLayer = new ContourCellLayer({ palette: NOISE_PALETTE }).addTo(map);
  L.control.scale({ metric: true, imperial: false, position: "bottomleft" }).addTo(map);
  window.addEventListener("resize", () => map.invalidateSize());
  initTabs({ defaultTab: "weather" });
  map.options.zoomSnap = 0.25;
  const fitPts = DEFAULT_PLACE_NAMES.map((n) => coords(n));
  map.fitBounds(L.latLngBounds(fitPts.map((p) => [p.lat, p.lon])).pad(0.03), { animate: false });
  for (const ev of caseData.공연) {
    const c = coords(ev.음원좌표);
    L.circleMarker([c.lat, c.lon], { radius: 6, color: "#0A2A70", weight: 2, fillColor: "#fff", fillOpacity: 1 })
      .bindTooltip(`${ev.이름} ${ev.시작}~${ev.끝}`).addTo(map);
  }

  const slider = document.getElementById("time-slider");
  slider.min = 0; slider.max = HOURS.length - 1; slider.step = 1;
  slider.value = HOURS.indexOf(DEFAULT_HOUR);
  const band = document.getElementById("news-band");
  const ticksEl = document.getElementById("slider-ticks");
  if (ticksEl) ticksEl.innerHTML = HOURS.map((h, i) => `<span style="left:${(i / (HOURS.length - 1)) * 100}%;transform:translateX(${i === 0 ? "0" : i === HOURS.length - 1 ? "-100%" : "-50%"})">${h}시</span>`).join("");
  for (const h of HOURS) {
    const seg = document.createElement("span");
    if (h * 60 < NEWS_TO_MIN && (h + 1) * 60 > NEWS_FROM_MIN) seg.className = "news";
    band.appendChild(seg);
  }

  let seq = 0;
  async function refresh() {
    const my = ++seq;
    const hh = HOURS[Number(slider.value)];
    document.getElementById("slider-label").textContent = `10/12 ${hh}~${hh + 1}시`;
    slider.dispatchEvent(new Event("change")); // 채워진 막대 폭 갱신(화면 스크립트)
    renderSide(hh);
    const warnEl = document.getElementById("layer-warning");
    if (!state.cache.has(`${hh}|${state.excludeDome}`)) warnEl.textContent = "지도 계산 중(바람 방향 여러 개 확인, 20~30초)…";
    const { cells, weather, warning } = await cellsFor(hh, computeHourInWorker);
    if (my !== seq) return;
    const warn = document.getElementById("layer-warning");
    if (warning) { warn.textContent = warning; noiseLayer.setCells([], 25); return; }
    if (allCellsUnknown(cells.filter((c) => c.layer === "noise"))) {
      warn.textContent = uniformUnknownMessage("noise", cells.filter((c) => c.layer === "noise"), weather);
      noiseLayer.setCells([], 25);
      return;
    }
    warn.textContent = "";
    noiseLayer.setCells(cells.filter((c) => c.layer === "noise"), 25);
  }
  slider.addEventListener("input", refresh);
  document.getElementById("exclude-dome").addEventListener("change", (e) => { state.excludeDome = e.target.checked; refresh(); });
  refresh();
}

main().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML("beforeend", `<p style="color:red;padding:16px">초기화 실패: ${err.message}</p>`);
});
