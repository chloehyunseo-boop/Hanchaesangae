// engine/place_view.js — 장소별 보기 (하린 라인, 11/23)
// 로드맵 §1 "장소별 보기: 시설을 누르면 시간별 강·중·약". 로드맵 6번 표 11/23 하린 줄.
//
// 하는 일: 장소 하나를 골라, 시간마다 소음·배출가스가 어느 단계인지 표로 만들어요.
//   새 계산은 없어요 — 문장 예보와 같은 장소별 셀(forecast_text.js의 placeCellsForHour)과
//   같은 표시 규칙(cellState → common.js의 mapDisplayFor)을 그대로 읽어요.
//   그래서 지도·문장 예보·장소별 보기 셋이 항상 같은 답을 내요.
// 하지 않는 일(CLAUDE.md 규칙 4): 행동 권고("창문을 닫으세요" 등)는 쓰지 않아요.

import { cellState } from "./forecast_text.js";

const LEVEL_RANK = { 강: 3, 중: 2, 약: 1 };
const LAYERS = ["noise", "exhaust"];
const LAYER_NAME = { noise: "소음", exhaust: "배출가스" };

const pad = (n) => String(n).padStart(2, "0");
function kst(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const k = new Date(ms + 9 * 3600 * 1000);
  return { ms, date: `${k.getUTCFullYear()}-${pad(k.getUTCMonth() + 1)}-${pad(k.getUTCDate())}`, hour: k.getUTCHours() };
}

/** 칸 하나의 상태. forecast_text의 cellState에 '기준 미만'과 '해당 없음'을 나눠 더했어요. */
export function placeCellState(cell) {
  if (!cell) return { kind: "none", text: "해당 없음" }; // 그 시각 음원·발전차 입력 자체가 없음
  const st = cellState(cell);
  if (st.kind === "level") return { ...st, text: st.atLeast ? `${st.level} 이상` : st.level };
  if (st.kind === "unknown") {
    const text = { 약풍: "바람 약해 계산 못 함", 근거리: "발전차 바로 옆(불확실)", 시간미확인: "시간 모름", 일부제외: "일부 정보 빠짐", 계산불가: "계산 못 함" }[st.reason] ?? "계산 못 함";
    return { ...st, text };
  }
  // none: 숫자는 있는데 '약' 기준 미만이거나, 그 시각에 가동 중인 음원이 없음
  const hasValue = typeof cell.value === "number" && Number.isFinite(cell.value);
  return hasValue ? { kind: "below", text: "기준 미만" } : { kind: "none", text: "해당 없음" };
}

/** 지도에서 누른 위치와 가장 가까운 장소(maxM 안). 없으면 null */
export function nearestPlace(places, lat, lon, maxM = 200) {
  let best = null;
  for (const p of places ?? []) {
    const dy = (p.lat - lat) * 111320;
    const dx = (p.lon - lon) * 111320 * Math.cos((lat * Math.PI) / 180);
    const d = Math.hypot(dx, dy);
    if (d <= maxM && (!best || d < best.d)) best = { place: p, d };
  }
  return best ? best.place : null;
}

/**
 * 장소 하나의 시간표.
 * @param {{ series: {hour:string, weather?:any, cellsByPlace: Record<string,{noise:any, exhaust:any}>}[], placeName: string }} p
 *   series는 문장 예보에 넘기는 것과 같은 배열이에요.
 * @returns {{ place:string, rows:{hour:string, date:string, hh:number, noise:any, exhaust:any}[],
 *   summary: Record<"noise"|"exhaust", {worst:string|null, atLeast:boolean, hours:string[], unknownHours:string[], text:string}> }}
 */
export function buildPlaceTimeline({ series, placeName }) {
  const sorted = (series ?? []).filter((s) => kst(s.hour)).sort((a, b) => Date.parse(a.hour) - Date.parse(b.hour));
  const rows = sorted.map((s) => {
    const k = kst(s.hour);
    const c = s.cellsByPlace?.[placeName];
    return { hour: s.hour, date: k.date, hh: k.hour, noise: placeCellState(c?.noise), exhaust: placeCellState(c?.exhaust) };
  });

  const summary = {};
  for (const layer of LAYERS) {
    const lv = rows.filter((r) => r[layer].kind === "level");
    const worst = lv.reduce((w, r) => (!w || LEVEL_RANK[r[layer].level] > LEVEL_RANK[w] ? r[layer].level : w), null);
    const worstRows = worst ? lv.filter((r) => r[layer].level === worst) : [];
    const atLeast = worstRows.length > 0 && worstRows.every((r) => r[layer].atLeast); // 전부 '하한'일 때만 "이상"
    const unknownRows = rows.filter((r) => r[layer].kind === "unknown");
    const name = LAYER_NAME[layer];
    let text;
    if (rows.length === 0) text = `${name}: 예측 자료가 아직 없어요`;
    else if (worst) text = `${name}: 가장 높은 단계는 '${worst}${atLeast ? " 이상" : ""}'(${spanList(worstRows)})`;
    else text = `${name}: '약' 이상으로 예측된 시간이 없어요`;
    if (unknownRows.length) text += ` · 계산하지 못한 시간 ${spanList(unknownRows)}`;
    summary[layer] = { worst, atLeast, hours: worstRows.map((r) => r.hour), unknownHours: unknownRows.map((r) => r.hour), text };
  }
  return { place: placeName, rows, summary };
}

/**
 * 시각 칸 목록 → "11/26 19~22시·11/27 1시" (1시간 칸, 끝 시각은 마지막 칸의 끝).
 * 이어지는 칸(1시간 간격)은 묶고, 자정을 넘으면 "23시~다음 날 2시"로 써요.
 */
export function spanList(rowsOrIsos) {
  const ks = rowsOrIsos.map((r) => kst(typeof r === "string" ? r : r.hour)).filter(Boolean).sort((a, b) => a.ms - b.ms);
  if (!ks.length) return "";
  const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
  const parts = [];
  let start = ks[0], n = 1;
  const flush = () => {
    const end = start.hour + n;
    parts.push(end > 24 ? `${md(start.date)} ${start.hour}시~다음 날 ${end - 24}시` : `${md(start.date)} ${start.hour}~${end}시`);
  };
  for (let i = 1; i < ks.length; i++) {
    if (ks[i].ms - ks[i - 1].ms === 3600 * 1000 && n < 24) { n++; continue; }
    flush(); start = ks[i]; n = 1;
  }
  flush();
  return parts.join("·");
}
