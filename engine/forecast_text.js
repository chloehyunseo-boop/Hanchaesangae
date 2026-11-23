// engine/forecast_text.js — 문장 예보 (하린 라인, 11/22)
// 로드맵 §1 "시민 문장 예보: 지도 아래 최대 5줄. 예: '20~21시 북서풍으로 발전차 배출가스가
// 수영장 쪽으로 퍼질 가능성이 커요'".
//
// 하는 일: 주요 장소(수영장·테니스장·광장·주변 아파트)마다 시간별 엔진 결과(OutputCell)를 보고,
// 같은 단계가 이어지는 시간대를 묶어 쉬운 문장으로 바꿔요.
// 하지 않는 일(CLAUDE.md 규칙 4): 해결책·행동 권고("창문을 닫으세요", "발전차를 옮기세요")는 쓰지 않아요.
// 새 계산은 없어요 — 엔진 결과(level, flags, 하한등급)와 common.js의 표시 규칙(mapDisplayFor)만 읽어요.

import { computeExhaustCell, computeNoiseCellConcawe } from "./combine.js";
import { mapDisplayFor } from "./common.js";

export const MAX_LINES = 5;

/** 문장에 쓰는 장소 기본 목록(data/site.geojson의 이름). 공연장 자체·음원 지점은 넣지 않아요. */
export const DEFAULT_PLACE_NAMES = [
  "올림픽수영장",
  "올림픽공원 테니스경기장",
  "장미광장",
  "평화의광장",
  "올림픽선수기자촌",
  "풍납극동아파트",
  "잠실파크리오아파트",
  "올림픽파크센트레빌아파트",
];

/** 문장에 쓰는 짧은 이름 */
const SHORT_NAME = {
  올림픽수영장: "수영장",
  "올림픽공원 테니스경기장": "테니스장",
  올림픽선수기자촌: "선수기자촌 아파트",
  풍납극동아파트: "풍납극동아파트",
  잠실파크리오아파트: "파크리오아파트",
  올림픽파크센트레빌아파트: "센트레빌아파트",
};
const shortName = (n) => SHORT_NAME[n] ?? n.replace(/^올림픽공원\s*/, "");

const LAYER_SUBJECT = { exhaust: "발전차 배출가스가", noise: "공연 소음이" };
const LAYER_TOPIC = { exhaust: "배출가스", noise: "소음" };
const LAYER_TOPIC_SUBJ = { exhaust: "배출가스가", noise: "소음이" };
const LEVEL_RANK = { 강: 3, 중: 2, 약: 1 };

/** 기상청 VEC(바람이 불어오는 방향, 도) → 16방위 한글 이름. 범위 밖·숫자 아님이면 null */
export function windName(vecFromDeg) {
  if (typeof vecFromDeg !== "number" || !Number.isFinite(vecFromDeg)) return null;
  const names = ["북", "북북동", "북동", "동북동", "동", "동남동", "남동", "남남동", "남", "남남서", "남서", "서남서", "서", "서북서", "북서", "북북서"];
  const i = Math.round((((vecFromDeg % 360) + 360) % 360) / 22.5) % 16;
  return `${names[i]}풍`;
}

/**
 * 셀 하나를 문장용 상태로 바꿔요. 지도와 같은 규칙(mapDisplayFor)을 따라요.
 * @returns {{kind:"level", level:"강"|"중"|"약", atLeast:boolean} | {kind:"unknown", reason:string} | {kind:"none"}}
 */
export function cellState(cell) {
  if (!cell) return { kind: "none" };
  const d = mapDisplayFor(cell);
  if (d.mode === "unknown") {
    const f = cell.flags ?? [];
    const reason = f.includes("약풍미표시") ? "약풍" : f.some((x) => x.includes("시간")) ? "시간미확인" : "계산불가";
    return { kind: "unknown", reason };
  }
  if (d.mode === "hatch") {
    // 근거리: 하한등급이 있으면 "그 단계 이상", 없으면 등급 보류(문장에선 근거리로 따로 말해요)
    if (cell.하한등급) return { kind: "level", level: cell.하한등급, atLeast: true };
    return { kind: "unknown", reason: "근거리" };
  }
  if (d.mode === "value" && !d.hideLevel && cell.level && LEVEL_RANK[cell.level]) {
    return { kind: "level", level: cell.level, atLeast: false };
  }
  if (d.mode === "value" && d.hideLevel) return { kind: "unknown", reason: "일부제외" };
  return { kind: "none" };
}

/**
 * 장소별 셀을 한 시각에 대해 계산해요(장소 좌표를 수음점으로 엔진을 그대로 불러요).
 * @param {{places:{name:string, lat:number, lon:number}[], stageSources:any[], generatorSources:any[], weather:any, hour:string, concaweData:object, 가정?:string, 배출시나리오?:"인증"|"비인증"}} p
 * @returns {Record<string, {noise: any, exhaust: any}>}
 */
export function placeCellsForHour({ places, stageSources, generatorSources, weather, hour, concaweData, 가정 = "기본추정", 배출시나리오 = "인증" }) {
  const out = {};
  for (const pl of places) {
    const receiver = { lat: pl.lat, lon: pl.lon };
    out[pl.name] = {
      noise: stageSources?.length ? computeNoiseCellConcawe({ stageSources, receiver, weather, hour, concaweData }) : null,
      exhaust: generatorSources?.length ? computeExhaustCell({ generators: generatorSources, receiver, weather, hour, 가정, 배출시나리오 }) : null,
    };
  }
  return out;
}

const pad = (n) => String(n).padStart(2, "0");
/** KST 기준 시(0~23)와 날짜 문자열 */
function kstParts(iso) {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  const k = new Date(ms + 9 * 3600 * 1000);
  return { date: `${k.getUTCFullYear()}-${pad(k.getUTCMonth() + 1)}-${pad(k.getUTCDate())}`, hour: k.getUTCHours(), ms };
}
function dayLabel(date, nowIso) {
  const n = kstParts(nowIso);
  if (!n) return "";
  const diff = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${n.date}T00:00:00Z`)) / 86400000);
  return diff === 0 ? "" : diff === 1 ? "내일 " : diff === 2 ? "모레 " : `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))} `;
}
function spanText(startIso, hoursLong, nowIso) {
  const s = kstParts(startIso);
  const endHour = s.hour + hoursLong; // 24를 넘으면 다음 날 시각
  if (endHour > 24) return `${dayLabel(s.date, nowIso)}${s.hour}시~다음 날 ${endHour - 24}시`;
  return `${dayLabel(s.date, nowIso)}${s.hour}~${endHour}시`;
}
const hasJong = (word) => {
  const c = word.charCodeAt(word.length - 1);
  if (c < 0xac00 || c > 0xd7a3) return false;
  return (c - 0xac00) % 28 !== 0;
};
const eunNeun = (word) => `${word}${hasJong(word) ? "은" : "는"}`;
const josaRo = (word) => {
  // 받침 없거나 ㄹ받침이면 "로", 그 외 "으로"
  const c = word.charCodeAt(word.length - 1);
  if (c < 0xac00 || c > 0xd7a3) return `${word}으로`;
  const jong = (c - 0xac00) % 28;
  return jong === 0 || jong === 8 ? `${word}로` : `${word}으로`;
};

/**
 * 문장 예보 (최대 5줄).
 * @param {{ series: {hour:string, weather:{windVecFromDeg?:number}, cellsByPlace: Record<string,{noise:any, exhaust:any}>}[],
 *   now: string, maxLines?: number }} p
 *   series는 시각 순서대로(1시간 간격). now는 "오늘/내일" 표기 기준 시각(ISO).
 * @returns {string[]}
 */
export function buildForecastSentences({ series, now, maxLines = MAX_LINES }) {
  if (!Array.isArray(series) || series.length === 0) return ["예보 자료가 아직 없어요."];
  const sorted = [...series].filter((s) => kstParts(s.hour)).sort((a, b) => Date.parse(a.hour) - Date.parse(b.hour));

  // 1) 장소·레이어별로 같은 상태가 이어지는 시간대를 묶어요
  const runs = []; // {layer, place, key, state, startIdx, len, winds:Set}
  const open = new Map();
  sorted.forEach((s, idx) => {
    const places = Object.keys(s.cellsByPlace ?? {});
    const seen = new Set();
    for (const place of places) {
      for (const layer of ["exhaust", "noise"]) {
        const st = cellState(s.cellsByPlace[place]?.[layer]);
        if (st.kind === "none") continue;
        const key = st.kind === "level" ? `L:${st.level}:${st.atLeast}` : `U:${st.reason}`;
        const id = `${layer}|${place}`;
        seen.add(id);
        const prev = open.get(id);
        const contiguous = prev && prev.key === key && prev.startIdx + prev.len === idx &&
          Date.parse(s.hour) - Date.parse(sorted[idx - 1].hour) === 3600 * 1000;
        if (contiguous) {
          prev.len++;
          prev.winds.add(windName(s.weather?.windVecFromDeg));
        } else {
          const r = { layer, place, key, state: st, startIdx: idx, len: 1, winds: new Set([windName(s.weather?.windVecFromDeg)]) };
          runs.push(r);
          open.set(id, r);
        }
      }
    }
    for (const id of [...open.keys()]) if (!seen.has(id)) open.delete(id);
  });

  // 2) 같은 레이어·상태·시간대·바람이면 장소를 합쳐요
  const groups = new Map();
  for (const r of runs) {
    const wind = r.winds.size === 1 ? [...r.winds][0] : null;
    const gk = `${r.layer}|${r.key}|${r.startIdx}|${r.len}|${wind}`;
    if (!groups.has(gk)) groups.set(gk, { ...r, wind, places: [] });
    groups.get(gk).places.push(r.place);
  }

  // 3) 문장으로
  const lines = [];
  for (const g of groups.values()) {
    const when = spanText(sorted[g.startIdx].hour, g.len, now);
    const allPlaces = Object.keys(sorted[g.startIdx].cellsByPlace ?? {}).length;
    const where = g.places.length >= 4 && g.places.length === allPlaces ? "주요 장소 전체" : g.places.map(shortName).join("·");
    if (g.state.kind === "level") {
      const lv = g.state.level;
      const windPart = g.wind ? `${josaRo(g.wind)} ` : "";
      let text;
      if (g.state.atLeast) {
        text = `${when} ${windPart}${LAYER_SUBJECT[g.layer]} ${where} 쪽으로 '${lv}' 이상 퍼질 것으로 보여요(발전차 바로 옆이라 정확한 값은 불확실해요)`;
      } else if (lv === "강") {
        text = `${when} ${windPart}${LAYER_SUBJECT[g.layer]} ${where} 쪽으로 퍼질 가능성이 커요('강')`;
      } else if (lv === "중") {
        text = `${when} ${windPart}${LAYER_SUBJECT[g.layer]} ${where} 쪽으로 퍼질 수 있어요('중')`;
      } else {
        text = `${when} ${where}에도 ${LAYER_TOPIC_SUBJ[g.layer]} 약하게 닿을 수 있어요('약')`;
      }
      lines.push({ text, rank: LEVEL_RANK[lv] * 10, start: g.startIdx });
    } else {
      const r = g.state.reason;
      const text =
        r === "약풍" ? (where === "주요 장소 전체" ? `${eunNeun(when)} 바람이 너무 약해 ${LAYER_TOPIC_SUBJ[g.layer]} 어디로 퍼질지 계산하지 못했어요. 안전하다는 뜻은 아니에요(지도 회색)` : `${eunNeun(when)} 바람이 너무 약해 ${where} 쪽 ${LAYER_TOPIC[g.layer]} 퍼짐을 계산하지 못했어요. 안전하다는 뜻은 아니에요(지도 회색)`) :
        r === "근거리" ? `${when} ${eunNeun(where)} 발전차 바로 옆이라 단계를 정하지 않았어요(지도 빗금)` :
        r === "시간미확인" ? `${when} 가동 시간을 모르는 ${g.layer === "exhaust" ? "발전차가" : "공연이"} 있어 ${where} 쪽 ${LAYER_TOPIC[g.layer]}${hasJong(LAYER_TOPIC[g.layer]) ? "을" : "를"} 계산하지 않았어요` :
        r === "일부제외" ? `${when} ${where} 쪽 ${eunNeun(LAYER_TOPIC[g.layer])} 일부 공연 정보가 빠져 단계를 정하지 않았어요` :
        `${when} ${where} 쪽 ${eunNeun(LAYER_TOPIC[g.layer])} 입력 정보가 부족해 계산하지 못했어요`;
      lines.push({ text, rank: 15, start: g.startIdx }); // 모름은 '중'과 '약' 사이 우선순위
    }
  }

  if (lines.length === 0) {
    const s0 = sorted[0].hour, n = sorted.length;
    return [`${spanText(s0, n, now)} 주요 장소에 '약' 이상으로 예보된 소음·배출가스가 없어요.`];
  }
  // 강 → 이상 등급 → 중 → 모름 → 약, 같은 순위면 이른 시각 먼저
  lines.sort((a, b) => b.rank - a.rank || a.start - b.start);
  const out = lines.slice(0, maxLines).map((l) => `${l.text}.`.replace(/\)\.$/, ").").replace(/요\.$/, "요."));
  if (lines.length > maxLines) {
    out[maxLines - 1] = `그 밖에 ${lines.length - maxLines + 1}건은 지도와 장소별 보기에 있어요.`;
  }
  return out;
}
