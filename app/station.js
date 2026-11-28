// 11/27 하린 확인: 공단 화면 시안 B(station_design_b.html + app/station_design.js)를 그대로 옮겨 왔어요. 계산 로직은 그대로.
// 바뀐 것: 등치선 면 레이어, 지도 위 범례 상자 제거(오른쪽 표시 항목), 처음 지도 맞춤, 시간 눈금, 공연 일정 날짜·목록형.
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

import { placeCellsForHour, buildForecastSentences, DEFAULT_PLACE_NAMES } from "../engine/forecast_text.js?v=20261128d";
import { generatorActivityAtHour } from "../engine/combine.js";
import { placeCellState, nearestPlace } from "../engine/place_view.js";
import {
  PARK_CENTER, NOISE_PALETTE, EXHAUST_PALETTE, CanvasCellLayer, createGridWorker,
  hourSlotIso, weatherKey, toEngineWeather, hourSlotDate, formatSlotLabel, loadCommonData,
  buildRealEventStageSources, buildManualEventStageSources, buildCitizenGeneratorSources,
  listTodaysRealEvents, kstParts, allCellsUnknown, uniformUnknownMessage, setupWeatherFreshness,
  buildGeneratorSourcesFromTruckRecords, localInputToIso, initTabs,
} from "./shared.js?v=20261128p";
import { setupEventsNotice, eventsEmptyMessage } from "./events_notice.js?v=20261128a"; // 11/28: 공연 일정 수집 실패·멈춤 안내
import { ContourCellLayer } from "./contour_layer.js?v=20261128p";
import { createGeneratorMarkers } from "./generator_markers.js?v=20261128d"; // 11/28: 지도에 발전차 위치
import { buildRealEventGeneratorSources, defaultGeneratorCount, generatorPosition } from "../engine/event_generators.js";

const NUM_HOURS = 72;
// 11/28 최종 점검: 공연명·장소는 공단 홈페이지 글(자동 수집)이나 공단 직원이 입력한 글이라 그대로 innerHTML에
// 넣으면 '<오페라의 유령>'처럼 꺾쇠가 든 이름이 깨지거나 스크립트가 실행돼요. 화면에 넣기 전에 이스케이프해요.
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

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

// ---------------------------------------------------------------------------
// 11/28 하린: 발전차는 "어느 공연의 발전차인지"만 고르고, 가동 시간은 그 공연에서 가져와요.
//  - 공연 추가(수동)에서 셋업 시각을 넣으면 → 그 공연 발전차는 셋업 시각부터 가동
//  - 셋업이 없거나 홈페이지 자동 수집 공연이면 → 공연 시작 2시간 전부터(엔진 기본 규칙)
//  - 끝은 공연 종료(소요 시간, 없으면 시작+3시간, 옥외는 21:30 중 먼저 — 소음 계산과 같은 규칙)
//  같은 공연의 시간을 소음·기본 발전차·입력 발전차가 모두 같은 함수(occurrenceTime)로 받아서 어긋나지 않아요.
// ---------------------------------------------------------------------------
const OCC_DAYS = 14;
const ymdKst = (d) => { const { y, m, d: dd } = kstParts(d); return `${y}-${m}-${dd}`; };
const weekdayOfYmd = (ymd) => { const [y, m, d] = ymd.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
function isoToLocalInput(iso) {
  if (!iso) return null;
  const { y, m, d, h } = kstParts(new Date(iso));
  const mm = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Seoul", minute: "2-digit" }).format(new Date(iso)).padStart(2, "0");
  return `${y}-${m}-${d}T${h}:${mm}`;
}
/** 오늘부터 2주 안의 공연(자동 수집 + 공단이 추가한 공연), 날짜마다 하나씩. */
function eventOccurrences() {
  const out = [];
  const start = hourSlotDate(0);
  for (let i = 0; i < OCC_DAYS; i++) {
    const day = ymdKst(new Date(start.getTime() + i * 86400e3));
    for (const ev of state.events?.공연 ?? []) {
      if (ev.출처 !== "공단일정페이지" || !ev.기간시작 || !ev.기간끝 || day < ev.기간시작 || day > ev.기간끝) continue;
      if (Array.isArray(ev.공연요일) && !ev.공연요일.includes(weekdayOfYmd(day))) continue;
      out.push({ key: `auto|${ev.공단일정번호 ?? ev.title}|${ev.site}|${day}`, kind: "auto", ev, day, site: ev.site, title: ev.title, 시작: ev.일자별시작?.[day] ?? null, 셋업: null });
    }
    for (const ev of state.manualEvents) {
      if (!(ev.title && ev.site && ev.날짜 && ev.시작) || ev.날짜 !== day) continue;
      out.push({ key: `manual|${ev.id}`, kind: "manual", ev, day, site: ev.site, title: ev.title, 시작: ev.시작, 셋업: ev.셋업 ?? null });
    }
  }
  return out.sort((a, b) => (a.day + (a.시작 ?? "99")).localeCompare(b.day + (b.시작 ?? "99")));
}
/** 공연 하나의 가동 시간 {start, end, setupStart?, 출처}. 소음 음원과 같은 함수로 시작·종료를 정해요. */
function occurrenceTime(o) {
  const noon = `${o.day}T12:00:00+09:00`;
  let time = null;
  if (o.kind === "auto") {
    time = buildRealEventGeneratorSources({ 공연: [o.ev] }, state.siteByName, state.assumptions, noon)[0]?.time
      ?? buildRealEventStageSources({ 공연: [o.ev] }, state.siteByName, "기본", state.assumptions, noon, NO_EXCLUDE)[0]?.time ?? null;
  } else {
    time = buildManualEventStageSources([o.ev], state.siteByName, "기본", state.assumptions, noon)[0]?.time ?? null;
  }
  if (!time && o.시작) {
    const s0 = new Date(`${o.day}T${o.시작}:00+09:00`).getTime();
    const dur = Number.isFinite(o.ev?.소요분) && o.ev.소요분 > 0 ? o.ev.소요분 * 60000 : 3 * 3600e3;
    time = { start: new Date(s0).toISOString(), end: new Date(s0 + dur).toISOString(), 출처: "공연시각_종료가정" };
  }
  if (!time) return { start: null, end: null, 출처: "미확인" };
  if (time.start && o.셋업) time = { ...time, setupStart: `${o.셋업}:00+09:00` };
  return time;
}
/** 발전차 입력 → 계산용 기록(공연에서 위치·시각을 가져옴). 고른 공연이 목록에 없으면 null(계산에서 빠짐). */
function resolveTruck(t, occs = eventOccurrences()) {
  if (!t.공연키) return null;
  const o = occs.find((x) => x.key === t.공연키);
  if (!o || !o.site) return null;
  const time = occurrenceTime(o);
  return {
    site: o.site, 발전기수: t.발전기수 ?? null, 인증등급: t.인증등급 ?? "모름", 엔진출력_kW: t.엔진출력_kW ?? null,
    시작시각: isoToLocalInput(time.start), 셋업시작: isoToLocalInput(time.setupStart), 종료시각: isoToLocalInput(time.end),
    시간미확인: !time.start, 날짜: o.day, 공연명: o.title,
  };
}
function resolvedTruckRecords() {
  const occs = eventOccurrences();
  return state.trucks.map((t) => resolveTruck(t, occs)).filter(Boolean);
}

function buildGeneratorSourcesFromTrucks() {
  return buildGeneratorSourcesFromTruckRecords(resolvedTruckRecords(), state.siteByName, state.assumptions);
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
  const records = resolvedTruckRecords();
  const base = buildCitizenGeneratorSources({
    events: state.events, truckRecords: records, noGeneratorDays: state.noGeneratorDays,
    siteByName: state.siteByName, assumptions: state.assumptions, hourIso,
  });
  // 11/28: 공단이 추가한 공연도 홈페이지 공연처럼 기본 대수 발전차를 넣어요(셋업 시각이 있으면 그때부터).
  // 그 공연장·날짜에 발전차를 직접 입력했거나 '사용 안 함'이면 넣지 않아요(입력값 우선).
  const entered = new Set(records.map((r) => `${r.site}|${r.날짜}`));
  const noGen = new Set(state.noGeneratorDays.filter((r) => r.site && r.날짜).map((r) => `${r.site}|${r.날짜}`));
  const manual = [];
  for (const o of eventOccurrences()) {
    if (o.kind !== "manual" || entered.has(`${o.site}|${o.day}`) || noGen.has(`${o.site}|${o.day}`)) continue;
    const n = defaultGeneratorCount(o.site, state.assumptions);
    const feature = state.siteByName.get(o.site);
    if (!n || !feature) continue;
    const pos = generatorPosition(o.site, feature, state.assumptions);
    const time = occurrenceTime(o);
    const 대수근거 = state.assumptions.발전차_기본대수?.공연장별?.[o.site] ? "공단확인값" : "확인된최소";
    for (let i = 0; i < n; i++) manual.push({ lat: pos.lat, lon: pos.lon, 위치출처: pos.위치출처, site: o.site, 정보출처: "공연일정자동_대수가정", 대수근거, time });
  }
  return [...base, ...manual];
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
    const result = { cells: [], warning: "이 시각 기상 자료 없음, 계산 안 함" };
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
const editingTruckIds = new Set(); // 지금 펼쳐서 고치는 중인 발전차(저장 전)
const fmtMD = (ymd) => { const [, m, d] = ymd.split("-"); return `${Number(m)}/${Number(d)}`; };
const fmtLocal = (v) => (v ? `${fmtMD(v.slice(0, 10))} ${v.slice(11, 16)}` : "");
function renderTruckTable(onChange) {
  // 11/28 하린: 발전차는 '어느 공연'만 고르고(위치·가동 시간은 그 공연에서), 대수·인증·출력만 넣어요.
  // 저장을 눌러야 반영되고, 저장하면 한 줄 요약(수정·삭제)으로 접혀요.
  const tbody = document.getElementById("truck-rows");
  tbody.innerHTML = "";
  const occs = eventOccurrences();
  const occLabel = (o) => `${fmtMD(o.day)} ${o.시작 ?? "시각 미확인"} · ${o.site ?? "장소 미확인"} · ${o.title}`;
  const delTruck = (t) => {
    state.trucks = state.trucks.filter((x) => x.id !== t.id);
    editingTruckIds.delete(t.id);
    renderTruckTable(onChange);
    onChange();
  };
  for (const t of state.trucks) {
    const occ = t.공연키 ? occs.find((x) => x.key === t.공연키) : null;
    if (t.공연키 && !editingTruckIds.has(t.id)) {
      const tr = document.createElement("tr");
      tr.className = "compact";
      const td = document.createElement("td");
      const parts = [`${t.발전기수 ?? "대수 모름"}${t.발전기수 ? "대" : ""}`, t.인증등급 && t.인증등급 !== "모름" ? t.인증등급 : "등급 모름", t.엔진출력_kW ? `${t.엔진출력_kW}kW` : "출력 모름"];
      let head, when;
      const r = occ ? resolveTruck(t, occs) : null; // 장소 미확인 공연이면 null(독립 검토 11/28: 이때 r.셋업시작을 읽다 화면이 죽었음)
      if (occ && r) {
        head = `${fmtMD(occ.day)} ${occ.시작 ?? ""} · ${esc(occ.site)}`;
        when = r?.시간미확인 ? "공연 시각 미확인 → 가동 시간 모름(그 칸은 계산 안 함)"
          : `가동 ${r.셋업시작 ? `${fmtLocal(r.셋업시작)}부터(셋업)` : `${fmtLocal(isoToLocalInput(new Date(new Date(`${r.시작시각}:00+09:00`).getTime() - 2 * 3600e3).toISOString()))}부터(공연 2시간 전)`} ~ ${fmtLocal(r.종료시각) || "종료 미상"}`;
        head += ` · ${esc(occ.title)}`;
      } else {
        head = occ ? `${fmtMD(occ.day)} ${occ.시작 ?? ""} · 장소 미확인 · ${esc(occ.title)}`
          : t.공연표시 ? `${fmtMD(t.공연표시.day)} · ${esc(t.공연표시.site)} · ${esc(t.공연표시.title)}` : "공연 정보 없음";
        when = occ ? "공연 장소 미확인 → 계산에서 빠짐" : "고른 공연이 목록에 없어 계산에서 빠짐(지난 공연이거나 일정 삭제)";
      }
      td.innerHTML = `<div class="ev-sum"><b>${head}</b><br><span>${parts.join(" · ")} · ${when}</span></div>`;
      const btns = document.createElement("div");
      btns.className = "ev-btns";
      const edit = document.createElement("button");
      edit.type = "button"; edit.textContent = "수정";
      edit.addEventListener("click", () => { editingTruckIds.add(t.id); renderTruckTable(onChange); });
      const del = document.createElement("button");
      del.type = "button"; del.textContent = "삭제";
      del.addEventListener("click", () => delTruck(t));
      btns.append(edit, del);
      td.appendChild(btns);
      tr.appendChild(td);
      tbody.appendChild(tr);
      continue;
    }
    const draft = { 공연키: t.공연키 ?? "", 발전기수: t.발전기수 ?? "", 인증등급: t.인증등급 ?? "모름", 엔진출력_kW: t.엔진출력_kW ?? "" };
    const tr = document.createElement("tr");
    const status = document.createElement("span");
    status.className = "ev-status";
    const keys = Object.keys(draft);
    const dirty = () => keys.some((k) => String(draft[k] ?? "") !== String(t[k] ?? (k === "인증등급" ? "모름" : "")));
    const paint = (msg) => {
      if (msg) { status.textContent = msg; status.dataset.state = "error"; return; }
      if (dirty()) { status.textContent = "저장 안 됨"; status.dataset.state = "dirty"; }
      else if (t.공연키) { status.textContent = "반영됨"; status.dataset.state = "ok"; }
      else { status.textContent = t.site ? "공연 선택 필요(예전 입력)" : "입력 필요"; status.dataset.state = "dirty"; }
    };

    // 공연 고르기: 날짜별로 묶어서(앞으로 2주)
    const occSel = document.createElement("select");
    const byDay = new Map();
    for (const o of occs) { if (!byDay.has(o.day)) byDay.set(o.day, []); byDay.get(o.day).push(o); }
    occSel.innerHTML = `<option value="">공연 고르기</option>` + [...byDay].map(([day, list]) =>
      `<optgroup label="${fmtMD(day)}">${list.map((o) => `<option value="${esc(o.key)}">${esc(occLabel(o))}</option>`).join("")}</optgroup>`).join("");
    occSel.value = draft.공연키;
    if (draft.공연키 && occSel.value !== draft.공연키) occSel.value = ""; // 목록에서 사라진 공연
    occSel.addEventListener("change", () => { draft.공연키 = occSel.value; paint(); });

    const countInput = document.createElement("input");
    countInput.type = "number"; countInput.min = "1"; countInput.max = "4"; countInput.placeholder = "모름=2";
    countInput.value = draft.발전기수;
    countInput.addEventListener("input", () => { draft.발전기수 = countInput.value; paint(); });

    const gradeSel = document.createElement("select");
    gradeSel.innerHTML = Object.entries(GRADE_LABEL).map(([v, label]) => `<option value="${v}">${label}</option>`).join("");
    gradeSel.value = draft.인증등급;
    gradeSel.addEventListener("change", () => { draft.인증등급 = gradeSel.value; paint(); });

    const powerInput = document.createElement("input");
    powerInput.type = "number"; powerInput.min = "1"; powerInput.max = "2000"; powerInput.placeholder = "모름=239kW";
    powerInput.value = draft.엔진출력_kW;
    powerInput.addEventListener("input", () => { draft.엔진출력_kW = powerInput.value; paint(); });

    const actions = document.createElement("div");
    actions.className = "ev-actions";
    const saveBtn = document.createElement("button");
    saveBtn.type = "button"; saveBtn.className = "save"; saveBtn.textContent = "저장";
    saveBtn.addEventListener("click", () => {
      if (!draft.공연키) { paint("공연 선택 필요"); return; }
      const num = (v) => (v === "" || v === null ? null : Number(v));
      const cnt = num(draft.발전기수), kw = num(draft.엔진출력_kW);
      if (cnt !== null && !(Number.isInteger(cnt) && cnt >= 1 && cnt <= 4)) { paint("발전기 수는 1~4"); return; }
      if (kw !== null && !(Number.isFinite(kw) && kw >= 1 && kw <= 2000)) { paint("엔진 출력은 1~2000 kW"); return; }
      const o = occs.find((x) => x.key === draft.공연키);
      Object.assign(t, { 공연키: draft.공연키, 공연표시: o ? { day: o.day, site: o.site, title: o.title } : t.공연표시 ?? null,
        발전기수: cnt, 인증등급: draft.인증등급, 엔진출력_kW: kw });
      // 예전 방식(위치·시각 직접 입력) 값은 지워요 — 이제 공연에서 가져와요
      delete t.site; delete t.시작시각; delete t.셋업시작;
      editingTruckIds.delete(t.id);
      renderTruckTable(onChange);
      onChange();
    });
    const delBtn = document.createElement("button");
    delBtn.type = "button"; delBtn.textContent = "삭제";
    delBtn.addEventListener("click", () => delTruck(t));
    actions.append(status, delBtn, saveBtn);

    for (const el of [occSel, countInput, gradeSel, powerInput, actions]) {
      const td = document.createElement("td");
      td.appendChild(el);
      tr.appendChild(td);
    }
    paint();
    tbody.appendChild(tr);
  }
}

// 공연 일정(하린 11/27): 선택 시각의 날짜만이 아니라 앞으로 2주를 날짜별로 묶어 보여줘요.
// 날짜를 누르면 시간 막대가 그날 첫 공연 시각으로 이동해요(예보 범위 72시간 안일 때만).
const SCHEDULE_DAYS = 14;
let scheduleClickBound = false;
function renderAutoEvents(hourIso) {
  const el = document.getElementById("auto-events");
  const ymd = (d) => { const { y, m, d: dd } = kstParts(d); return `${y}-${m}-${dd}`; };
  const selDay = ymd(new Date(hourIso));
  const start = hourSlotDate(0);
  const fmt = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", weekday: "short" });
  const blocks = [];
  for (let i = 0; i < SCHEDULE_DAYS; i++) {
    const day = ymd(new Date(start.getTime() + i * 86400e3));
    const auto = listTodaysRealEvents(state.events, `${day}T12:00:00+09:00`);
    const manual = state.manualEvents.filter((e) => e.title && e.site && e.날짜 === day && e.시작)
      .map((e) => ({ title: e.title, site: e.site, startTimeStr: e.시작, 수동: true }));
    const items = [...auto, ...manual].sort((p, q) => String(p.startTimeStr ?? "99").localeCompare(String(q.startTimeStr ?? "99")));
    if (!items.length) continue;
    // 그날 첫 공연 시각(없으면 그날 첫 시간)에 해당하는 시간 막대 위치
    const firstHour = items.find((x) => x.startTimeStr)?.startTimeStr?.slice(0, 2) ?? null;
    let offset = -1;
    for (let o = 0; o < NUM_HOURS; o++) {
      const d = hourSlotDate(o);
      if (ymd(d) !== day) continue;
      if (offset < 0) offset = o;
      if (firstHour && kstParts(d).h === firstHour) { offset = o; break; }
    }
    const dp = Object.fromEntries(fmt.formatToParts(new Date(`${day}T12:00:00+09:00`)).map((x) => [x.type, x.value]));
    const label = `${dp.month}월 ${dp.day}일 (${dp.weekday})`;
    const hint = offset >= 0 ? (day === selDay ? "지도에 표시 중" : "지도에서 보기") : "예측 범위 밖";
    blocks.push(`<section class="day${day === selDay ? " sel" : ""}">
      <button type="button" class="day-head" ${offset >= 0 ? `data-offset="${offset}"` : "disabled"}><b>${label}</b><small>${hint}</small></button>
      ${items.map((e) => `<div class="ev"><b>${esc(e.startTimeStr ?? "시각 미상")}</b> · ${esc(e.site)}${e.수동 ? ' <span class="tag">직접 입력</span>' : ""}<br><span>${esc(e.title)}</span></div>`).join("")}
    </section>`);
  }
  el.innerHTML = blocks.length ? blocks.join("") : `<p class="muted">${esc(eventsEmptyMessage(state.events))}</p>`;
  if (!scheduleClickBound) {
    scheduleClickBound = true;
    el.addEventListener("click", (e) => {
      const btn = e.target.closest(".day-head[data-offset]");
      if (!btn) return;
      const slider = document.getElementById("time-slider");
      slider.value = btn.dataset.offset;
      slider.dispatchEvent(new Event("input"));
      slider.dispatchEvent(new Event("change"));
    });
  }
}

const editingEventIds = new Set(); // 지금 펼쳐서 고치는 중인 공연(저장 전)
function renderManualEventsTable(onChange) {
  // 11/27 하린: 카드에서 고친 내용은 '저장'을 눌러야 반영돼요(실수로 반쯤 입력된 값이 계산에 들어가지 않게).
  // 시작 시각은 브라우저마다 다르게 동작하는 시계 입력 대신 '시'·'분' 선택으로 받아요(Safari에서 입력이 안 되던 문제).
  const tbody = document.getElementById("event-rows");
  tbody.innerHTML = "";
  const venueNames = [...state.siteByName.keys()];
  const hours = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
  const mins = Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, "0"));
  for (const ev of state.manualEvents) {
    const saved = ev.title && ev.site && ev.날짜 && ev.시작;
    if (saved && !editingEventIds.has(ev.id)) {
      // 저장된 공연: 한 줄 요약 + 수정·삭제
      const tr = document.createElement("tr");
      tr.className = "compact";
      const td = document.createElement("td");
      const [, mm, dd] = ev.날짜.split("-");
      td.innerHTML = `<div class="ev-sum"><b>${Number(mm)}/${Number(dd)} ${esc(ev.시작)}</b> · ${esc(ev.site)}<br><span>${esc(ev.title)}${ev.소요분 ? ` · ${ev.소요분}분` : ""} · ${ev.셋업 ? `셋업 ${fmtLocal(ev.셋업)}부터 발전차 가동` : "발전차 공연 2시간 전부터"}</span></div>`;
      const btns = document.createElement("div");
      btns.className = "ev-btns";
      const edit = document.createElement("button");
      edit.type = "button"; edit.textContent = "수정";
      edit.addEventListener("click", () => { editingEventIds.add(ev.id); renderManualEventsTable(onChange); });
      const del = document.createElement("button");
      del.type = "button"; del.textContent = "삭제";
      del.addEventListener("click", () => {
        state.manualEvents = state.manualEvents.filter((x) => x.id !== ev.id);
        renderManualEventsTable(onChange);
        onChange();
      });
      btns.append(edit, del);
      td.appendChild(btns);
      tr.appendChild(td);
      tbody.appendChild(tr);
      continue;
    }
    const draft = { title: ev.title ?? "", site: ev.site ?? "", 날짜: ev.날짜 ?? "", 시작: ev.시작 ?? "", 소요분: ev.소요분 ?? "", 셋업: ev.셋업 ?? "" };
    const tr = document.createElement("tr");
    const status = document.createElement("span");
    status.className = "ev-status";
    const isSaved = () => ev.title && ev.site && ev.날짜 && ev.시작;
    const dirty = () => (draft.title || "") !== (ev.title ?? "") || draft.site !== (ev.site ?? "") || draft.날짜 !== (ev.날짜 ?? "")
      || draft.시작 !== (ev.시작 ?? "") || String(draft.소요분 ?? "") !== String(ev.소요분 ?? "") || draft.셋업 !== (ev.셋업 ?? "");
    const paint = (msg) => {
      if (msg) { status.textContent = msg; status.dataset.state = "error"; return; }
      if (dirty()) { status.textContent = "저장 안 됨"; status.dataset.state = "dirty"; }
      else if (isSaved()) { status.textContent = "반영됨"; status.dataset.state = "ok"; }
      else { status.textContent = "입력 필요"; status.dataset.state = "dirty"; }
    };

    const titleInput = document.createElement("input");
    titleInput.type = "text"; titleInput.placeholder = "공연명"; titleInput.value = draft.title;
    titleInput.addEventListener("input", () => { draft.title = titleInput.value.trim(); paint(); });

    const siteSel = document.createElement("select");
    siteSel.innerHTML = `<option value="">위치 고르기</option>` + venueNames.map((n) => `<option value="${n}">${n}</option>`).join("");
    siteSel.value = draft.site;
    siteSel.addEventListener("change", () => { draft.site = siteSel.value; paint(); });

    const dateInput = document.createElement("input");
    dateInput.type = "date"; dateInput.value = draft.날짜;
    const onDate = () => { draft.날짜 = dateInput.value; paint(); };
    dateInput.addEventListener("input", onDate); dateInput.addEventListener("change", onDate);

    const timeWrap = document.createElement("div");
    timeWrap.className = "time-pick";
    const hSel = document.createElement("select");
    const mSel = document.createElement("select");
    hSel.innerHTML = `<option value="">시</option>` + hours.map((h) => `<option value="${h}">${h}시</option>`).join("");
    mSel.innerHTML = mins.map((m) => `<option value="${m}">${m}분</option>`).join("");
    if (draft.시작) { const [hh, mm] = draft.시작.split(":"); hSel.value = hh; mSel.value = mins.includes(mm) ? mm : "00"; }
    const onTime = () => { draft.시작 = hSel.value ? `${hSel.value}:${mSel.value}` : ""; paint(); };
    hSel.addEventListener("change", onTime); mSel.addEventListener("change", onTime);
    timeWrap.append(hSel, mSel);

    const durInput = document.createElement("input");
    durInput.type = "number"; durInput.min = "1"; durInput.placeholder = "비우면 180"; durInput.value = draft.소요분;
    durInput.addEventListener("input", () => { draft.소요분 = durInput.value; paint(); });

    // 11/28: 셋업 시작(선택) — 날짜 + 시·분. 넣으면 이 공연 발전차는 그때부터 가동, 비우면 공연 2시간 전부터.
    const setupWrap = document.createElement("div");
    setupWrap.className = "time-pick dt";
    const sDate = document.createElement("input"); sDate.type = "date";
    const sH = document.createElement("select"); const sM = document.createElement("select");
    sH.innerHTML = `<option value="">시</option>` + hours.map((h) => `<option value="${h}">${h}시</option>`).join("");
    sM.innerHTML = mins.map((m) => `<option value="${m}">${m}분</option>`).join("");
    if (draft.셋업) { const [d0, hm] = draft.셋업.split("T"); const [hh, mm2] = hm.split(":"); sDate.value = d0; sH.value = hh; sM.value = mins.includes(mm2) ? mm2 : "00"; }
    const onSetup = () => {
      const d0 = sDate.value || (sH.value ? draft.날짜 : "");
      if (!sDate.value && d0) sDate.value = d0; // 시만 고르면 공연 날짜로 채움
      draft.셋업 = d0 && sH.value ? `${d0}T${sH.value}:${sM.value}` : (sDate.value || sH.value ? "__partial" : "");
      paint();
    };
    for (const el of [sDate, sH, sM]) { el.addEventListener("change", onSetup); el.addEventListener("input", onSetup); }
    setupWrap.append(sDate, sH, sM);

    const actions = document.createElement("div");
    actions.className = "ev-actions";
    const saveBtn = document.createElement("button");
    saveBtn.type = "button"; saveBtn.className = "save"; saveBtn.textContent = "저장";
    saveBtn.addEventListener("click", () => {
      if (!draft.title || !draft.site || !draft.날짜 || !draft.시작) { paint("공연명·위치·날짜·시작 시각 모두 입력 필요"); return; }
      const dur = draft.소요분 === "" ? null : Number(draft.소요분);
      if (dur !== null && !(Number.isFinite(dur) && dur > 0)) { paint("소요(분)는 1 이상 숫자"); return; }
      if (draft.셋업 === "__partial") { paint("셋업은 날짜와 시 함께 입력 필요"); return; }
      if (draft.셋업 && draft.셋업 > `${draft.날짜}T${draft.시작}`) { paint("셋업은 공연 시작보다 앞이어야 함"); return; }
      Object.assign(ev, { title: draft.title, site: draft.site, 날짜: draft.날짜, 시작: draft.시작, 소요분: dur, 셋업: draft.셋업 || null });
      editingEventIds.delete(ev.id);
      renderManualEventsTable(onChange); // 저장하면 입력칸을 접고 한 줄 요약으로
      onChange();
    });
    const delBtn = document.createElement("button");
    delBtn.type = "button"; delBtn.textContent = "삭제";
    delBtn.addEventListener("click", () => {
      state.manualEvents = state.manualEvents.filter((x) => x.id !== ev.id);
      renderManualEventsTable(onChange);
      onChange();
    });
    actions.append(status, delBtn, saveBtn);

    for (const el of [titleInput, siteSel, dateInput, timeWrap, durInput, setupWrap, actions]) {
      const td = document.createElement("td");
      td.appendChild(el);
      tr.appendChild(td);
    }
    paint();
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

// ---------------------------------------------------------------------------
// 공단용 요약(시안 B, 하린 11/27). 새 계산 없이 이미 있는 결과만 모아서 보여줘요:
//  ① 이 시각 현황(진행 공연·가동 발전차·영향 강습 수) ② 주요 장소 8곳 단계 ③ 앞으로 72시간 문장 예측.
// 해결책·조치 권고는 넣지 않아요(CLAUDE.md 규칙 4).
let summarySeries = null; // 72시간 장소 시리즈(입력이 바뀌면 비움)
function invalidateSummary() { summarySeries = null; }
function overlapsHour(time, hourIso) {
  if (!time || !time.start) return time?.출처 === "미확인" ? "unknown" : false;
  const h0 = Date.parse(hourIso), h1 = h0 + 3600e3;
  const s = Date.parse(time.start), e = time.end ? Date.parse(time.end) : Infinity;
  return s < h1 && e > h0;
}
function chipHtml(st, palette) {
  if (st.kind === "level") return `<span class="chip" style="background:${palette[st.level]}">${st.text}</span>`;
  if (st.kind === "unknown") return `<span class="chip unk">${st.text}</span>`;
  return `<span class="chip none">${st.kind === "below" ? "기준 미만" : "–"}</span>`;
}
function renderSummary(date, placeCells) {
  const el = document.getElementById("station-summary");
  if (!el) return;
  const hourIso = hourSlotIso(date);
  const stages = buildStageSources(hourIso);
  const showCount = stages.filter((x) => overlapsHour(x.time, hourIso)).length;
  const showUnknown = stages.filter((x) => overlapsHour(x.time, hourIso) === "unknown").length;
  const gens = buildGeneratorSources(hourIso);
  const active = gens.filter((g) => generatorActivityAtHour(g, hourIso) === "active");
  const assumed = active.filter((g) => g.정보출처 === "공연일정자동_대수가정").length;
  const running = lessonsAtHour(state.lessons?.강좌 ?? [], date);
  let affected = 0;
  for (const l of running) {
    const f = state.siteByName.get(l.site);
    if (!f) continue;
    const [lon, lat] = f.geometry.coordinates;
    const near = nearestPlace(DEFAULT_PLACE_NAMES.map((n) => ({ name: n, ...pt(n) })).filter((p) => p.lat), lat, lon, 9999);
    const c = near ? placeCells?.[near.name] : null;
    if (placeCellState(c?.noise).kind === "level" || placeCellState(c?.exhaust).kind === "level") affected++;
  }
  const stat = (num, label, sub) => `<div class="stat"><b>${num}</b><span>${label}</span>${sub ? `<small>${sub}</small>` : ""}</div>`;
  const places = DEFAULT_PLACE_NAMES.filter((n) => placeCells?.[n]);
  const rows = places.map((n) => `<tr><td>${n}</td><td>${chipHtml(placeCellState(placeCells[n].noise), NOISE_PALETTE)}</td><td>${chipHtml(placeCellState(placeCells[n].exhaust), EXHAUST_PALETTE)}</td></tr>`).join("");
  if (!summarySeries) {
    summarySeries = [];
    const pls = DEFAULT_PLACE_NAMES.map((name) => ({ name, ...pt(name) })).filter((p) => p.lat !== undefined);
    for (let o = 0; o < NUM_HOURS; o++) {
      const d = hourSlotDate(o), w = resolveWeather(d);
      if (!w) continue;
      const h = hourSlotIso(d);
      summarySeries.push({ hour: h, weather: w, cellsByPlace: placeCellsForHour({ places: pls, stageSources: buildStageSources(h), generatorSources: buildGeneratorSources(h), weather: w, hour: h, concaweData: state.concaweData, 배출시나리오: state.배출시나리오_기본값 }) });
    }
  }
  const lines = buildForecastSentences({ series: summarySeries, now: hourSlotIso(hourSlotDate(0)), placeViewAvailable: false });
  el.innerHTML = `
    <div class="sum-sec">
      <h4>${formatSlotLabel(date)} 현황</h4>
      <div class="stats">
        ${stat(showCount, "진행 공연", showUnknown ? `시각 미상 ${showUnknown}` : "")}
        ${stat(active.length, "가동 발전차", assumed ? `기본 가정 ${assumed}` : "")}
        ${stat(`${affected}<em>/${running.length}</em>`, "영향 강습", "약 이상 / 진행")}
      </div>
    </div>
    <div class="sum-sec">
      <h4>주요 장소</h4>
      ${rows ? `<table class="mini sum-tbl"><thead><tr><th>장소</th><th>소음</th><th>배출가스</th></tr></thead><tbody>${rows}</tbody></table>` : `<p class="muted">이 시각 계산 결과 없음</p>`}
    </div>
    <div class="sum-sec">
      <h4>앞으로 72시간</h4>
      ${lines.length ? `<ul class="sum-lines">${lines.map((l) => `<li>${l}</li>`).join("")}</ul>` : `<p class="muted">주요 장소 8곳 모두 '약' 미만</p>`}
    </div>`;
}

function renderImpactedLessons(lessons, date, cells) {
  const el = document.getElementById("impacted-lessons");
  const list = lessons?.강좌 ?? [];
  if (list.length === 0) {
    el.innerHTML = "<p>강좌 자료 없음</p>";
    return;
  }
  const running = lessonsAtHour(list, date);
  if (running.length === 0) {
    el.innerHTML = "<p>이 시각 진행 중인 강좌 없음</p>";
    return;
  }
  const rows = running.map((l) => {
    const feature = state.siteByName.get(l.site);
    if (!feature) return `<tr><td>${esc(l.name)}</td><td>${esc(l.site)}</td><td colspan="2">위치 자료 없음</td></tr>`;
    const [lon, lat] = feature.geometry.coordinates;
    const near = nearestPlace(DEFAULT_PLACE_NAMES.map((n) => ({ name: n, ...pt(n) })).filter((p) => p.lat), lat, lon, 9999);
    const key = near?.name ?? null;
    const c = key ? cells?.[key] : null;
    const noise = placeCellState(c?.noise);
    const exhaust = placeCellState(c?.exhaust);
    return `<tr><td>${esc(l.name)}</td><td>${esc(l.site)}</td><td>${noise.text}</td><td>${exhaust.text}</td></tr>`;
  }).join("");
  el.innerHTML = `<table class="mini"><thead><tr><th>강좌</th><th>장소</th><th>소음</th><th>배출</th></tr></thead><tbody>${rows}</tbody></table>`;
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
  const { weatherByHour, weatherSavedAt, siteByName, assumptions, concaweData, lessons, events } = await loadCommonData();
  state.weatherByHour = weatherByHour;
  setupWeatherFreshness(weatherSavedAt, { metaEl: document.querySelector("header.top .meta"), metaSuffix: " · 입력값은 이 브라우저에만 저장" });
  state.siteByName = siteByName;
  state.assumptions = assumptions;
  state.concaweData = concaweData;
  state.lessons = lessons;
  state.events = events;
  setupEventsNotice(events);
  initTabs({ defaultTab: "events" });

  const genNote = document.getElementById("generator-count-note");
  const genNoteText = state.assumptions?.발전차_기본대수?.화면_문구;
  if (genNote && genNoteText) genNote.textContent = genNoteText;

  const computeHourInWorker = createGridWorker();

  const map = L.map("map", { center: [PARK_CENTER.lat, PARK_CENTER.lon], zoom: 15 });
  // OpenFreeMap Bright(MapLibre 벡터타일) — maplibre-gl-leaflet로 Leaflet 지도 위에 올림(11/27).
  L.maplibreGL({
    style: "https://tiles.openfreemap.org/styles/bright",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  const noiseLayer = new ContourCellLayer({ palette: NOISE_PALETTE }).addTo(map);
  const exhaustLayer = new ContourCellLayer({ palette: EXHAUST_PALETTE }).addTo(map);
  const genMarkers = createGeneratorMarkers(map, generatorActivityAtHour);

  L.control.scale({ metric: true, imperial: false, position: "bottomleft" }).addTo(map);
  // 11/27: 컴퓨터 화면 레이아웃(지도+오른쪽 박스)은 지도 칸 크기가 창 크기에 따라 바뀌어서 필요
  window.addEventListener("resize", () => map.invalidateSize());
  // 처음 지도: 공원과 주요 장소 8곳이 꽉 차게(0.25 단위 확대)
  map.options.zoomSnap = 0.25;
  const fitPlaces = DEFAULT_PLACE_NAMES.map((n) => pt(n)).filter((p) => p.lat !== undefined);
  if (fitPlaces.length) map.fitBounds(L.latLngBounds(fitPlaces.map((p) => [p.lat, p.lon])).pad(0.03), { animate: false });

  document.getElementById("add-truck").addEventListener("click", () => {
    state.trucks.push({ id: `t${Date.now()}${Math.random().toString(36).slice(2, 6)}`, 공연키: null, 발전기수: null, 인증등급: "모름", 엔진출력_kW: null });
    saveTrucks();
    renderTruckTable(onTruckChange);
  });
  document.getElementById("add-nogen").addEventListener("click", () => {
    state.noGeneratorDays.push({ id: `n${Date.now()}${Math.random().toString(36).slice(2, 6)}`, site: null, 날짜: null });
    saveList(NOGEN_STORAGE_KEY, state.noGeneratorDays);
    renderNoGenTable(onNoGenChange);
  });
  function onNoGenChange() {
    invalidateSummary();
    saveList(NOGEN_STORAGE_KEY, state.noGeneratorDays);
    state.cellCache.clear();
    refresh();
  }
  renderNoGenTable(onNoGenChange);

  document.getElementById("export-trucks").addEventListener("click", () => {
    const payload = {
      _설명: "station.html에서 내보낸 발전차 입력값 — data/generator_inputs.json 자리에 덮어써서 커밋하면 시민 화면에 반영돼요.",
      내보낸시각: new Date().toISOString(), trucks: resolvedTruckRecords(),
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
    invalidateSummary();
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
    invalidateSummary();
    saveManualEvents();
    state.cellCache.clear(); // 11/26: 이제 계산에 들어가니 agency.js와 달리 캐시도 비워요
    renderTruckTable(onTruckChange); // 11/28: 발전차의 공연 목록·가동 시간이 공연에서 오니 같이 갱신
    refreshSliderBand();
    refresh();
  }
  renderManualEventsTable(onEventChange);

  document.getElementById("scenario-default").addEventListener("change", (e) => {
    state.배출시나리오_기본값 = e.target.value;
    invalidateSummary();
    state.cellCache.clear();
    refresh();
  });

  document.getElementById("toggle-noise").addEventListener("change", (e) => {
    if (e.target.checked) noiseLayer.addTo(map); else map.removeLayer(noiseLayer);
  });
  document.getElementById("toggle-exhaust").addEventListener("change", (e) => {
    if (e.target.checked) exhaustLayer.addTo(map); else map.removeLayer(exhaustLayer); genMarkers.setVisible(e.target.checked);
  });

  document.getElementById("download-csv").addEventListener("click", async (e) => {
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = "만드는 중…(72시간 계산)";
    try {
      const csv = await buildForecastCsv();
      const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" }) // BOM: 엑셀에서 한글이 안 깨지게;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `올팍_예측기록_${hourSlotIso(new Date()).slice(0, 13)}시.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      btn.disabled = false;
      btn.textContent = "72시간 CSV 받기";
    }
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

  const sliderBandEl = document.getElementById("slider-band");
  // 11/28 친구 요청: 드래그하다 지도가 비어 보이면 "공연이 없어서"인지 "계산 중"인지
  // 구분이 안 돼요 — 공연·발전차 중 하나라도 있는 시간은 노란 칸으로 미리 표시해요
  // (impossible이 아니면, 즉 지도에 뭔가 뜰 가능성이 있는 시간만).
  function refreshSliderBand() {
    const segs = [];
    for (let offset = 0; offset < NUM_HOURS; offset++) {
      const weather = resolveWeather(hourSlotDate(offset));
      const hourIso = hourSlotIso(hourSlotDate(offset));
      const hasGenerators = buildGeneratorSources(hourIso).length > 0;
      const hasStage = buildStageSources(hourIso).length > 0;
      const impossible = hasGenerators && weather && weather.wsd10m < 1.0;
      const active = !impossible && (hasGenerators || hasStage);
      const cls = impossible ? " impossible" : active ? " active" : "";
      const title = impossible ? "약풍이어서 배출가스 계산 불가" : active ? "공연·발전차 있음" : "";
      segs.push(`<div class="slider-seg${cls}" title="${title}"></div>`);
    }
    sliderBandEl.innerHTML = segs.join("");
    const noteEl = document.getElementById("band-note");
    if (noteEl) {
      const notes = [];
      if (segs.some((x) => x.includes("impossible"))) notes.push('<i class="sw-impossible"></i>약풍이어서 배출가스 계산 불가');
      if (segs.some((x) => x.includes(" active"))) notes.push('<i class="sw-active"></i>공연·발전차 있는 시간');
      noteEl.innerHTML = notes.join(" · ");
    }
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
    renderLayerWarnings(cells, weatherForWarning, warning);
    const noiseCells = cells.filter((c) => c.layer === "noise");
    const exhaustCells = cells.filter((c) => c.layer === "exhaust");
    noiseLayer.setCells(allCellsUnknown(noiseCells) ? [] : noiseCells, 25);
    exhaustLayer.setCells(allCellsUnknown(exhaustCells) ? [] : exhaustCells, 25);
    genMarkers.update(buildGeneratorSources(hourIso), hourIso);
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
    renderSummary(date, placeCells);
  }

  sliderLabel.textContent = formatSlotLabel(hourSlotDate(0));
  const ticksEl = document.getElementById("slider-ticks");
  if (ticksEl) {
    const marks = [[0, "지금"]];
    for (let o = 1; o < NUM_HOURS; o++) {
      const lab = formatSlotLabel(hourSlotDate(o));
      if (lab.endsWith(" 00시") && (o - marks[marks.length - 1][0]) / (NUM_HOURS - 1) >= 0.1) marks.push([o, lab.replace(" 00시", "")]);
    }
    ticksEl.innerHTML = marks.map(([o, m]) => `<span style="left:${(o / (NUM_HOURS - 1)) * 100}%;${o === 0 ? "" : "transform:translateX(-50%)"}">${m}</span>`).join("");
  }
  slider.addEventListener("change", refresh);
  slider.addEventListener("input", (e) => { sliderLabel.textContent = formatSlotLabel(hourSlotDate(Number(e.target.value))); });

  refreshSliderBand();
  refresh();
}

main().catch((err) => {
  document.body.insertAdjacentHTML("beforeend", `<p style="color:red">초기화 실패: ${err.message}</p>`);
  console.error(err);
});
