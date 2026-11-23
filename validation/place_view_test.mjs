// 장소별 보기 검증 (하린 라인, 11/23). 실행: node validation/place_view_test.mjs
import { readFileSync } from "node:fs";
import { buildPlaceTimeline, placeCellState, nearestPlace, spanList } from "../engine/place_view.js";
import { placeCellsForHour, buildForecastSentences, cellState, DEFAULT_PLACE_NAMES } from "../engine/forecast_text.js";

let fails = 0;
const ok = (c, m, extra = "") => { console.log(`${c ? "✓" : "✗"} ${m}${extra ? `  → ${extra}` : ""}`); if (!c) fails++; };

const t = (d, h) => `2026-11-${d}T${String(h).padStart(2, "0")}:00:00+09:00`;
const lvl = (level, value = 1) => ({ value, level, flags: [] });
const calm = { value: null, level: null, flags: ["약풍미표시"] };
const near강 = { value: 0.3, level: "강", flags: ["근거리불확실"], 하한값: 0.06, 하한등급: "강" };
const near없음 = { value: 0.3, level: "강", flags: ["근거리불확실"], 하한값: 0, 하한등급: null };
const below = { value: 0.0005, level: null, flags: [] };
const off = { value: null, level: null, flags: ["가동중발전차없음"] };

// 1) 칸 상태
ok(placeCellState(null).kind === "none", "입력 없음 → 해당 없음");
ok(placeCellState(below).kind === "below", "숫자 있고 기준 미만 → 기준 미만");
ok(placeCellState(off).kind === "none", "가동 중 발전차 없음(blank) → 해당 없음");
ok(placeCellState(calm).kind === "unknown" && placeCellState(calm).reason === "약풍", "약풍 → 계산 못 함(약풍)");
ok(placeCellState(near강).text === "강 이상", "근거리 + 하한등급 강 → '강 이상'");
ok(placeCellState(near없음).kind === "unknown" && placeCellState(near없음).reason === "근거리", "근거리 + 하한등급 없음 → 불확실");
ok(placeCellState(lvl("중")).text === "중", "보통 칸 → 단계 그대로");

// 2) 문장 예보와 같은 규칙인지: level/unknown은 cellState와 항상 같아야 해요
for (const c of [lvl("강"), lvl("약"), calm, near강, near없음, { value: 50, level: "중", flags: ["일부음원제외"] }]) {
  const a = placeCellState(c), b = cellState(c);
  ok(a.kind === b.kind && a.level === b.level && a.reason === b.reason, `cellState와 일치: ${JSON.stringify(c.flags)} ${c.level}`);
}

// 3) 시간표·요약
const series = [
  { hour: t(26, 18), cellsByPlace: { 수영장: { noise: lvl("약"), exhaust: null } } },
  { hour: t(26, 19), cellsByPlace: { 수영장: { noise: lvl("중"), exhaust: lvl("중") } } },
  { hour: t(26, 20), cellsByPlace: { 수영장: { noise: lvl("중"), exhaust: near강 } } },
  { hour: t(26, 21), cellsByPlace: { 수영장: { noise: lvl("약"), exhaust: calm } } },
  { hour: t(26, 23), cellsByPlace: { 수영장: { noise: below, exhaust: calm } } },
  { hour: t(27, 0), cellsByPlace: { 수영장: { noise: below, exhaust: calm } } },
];
const tl = buildPlaceTimeline({ series: [...series].reverse(), placeName: "수영장" });
ok(tl.rows.length === 6 && tl.rows[0].hh === 18 && tl.rows[5].date === "2026-11-27", "시각 순서로 정렬, 날짜 넘어감");
ok(tl.summary.noise.worst === "중" && tl.summary.noise.text.includes("11/26 19~21시"), "소음 요약: 가장 높은 단계 중, 19~21시", tl.summary.noise.text);
ok(tl.summary.exhaust.worst === "강" && tl.summary.exhaust.atLeast, "배출가스 요약: 강 이상(하한)", tl.summary.exhaust.text);
ok(tl.summary.exhaust.text.includes("21~22시·11/26 23시~다음 날 1시") && tl.summary.exhaust.text.includes("안전하다는 뜻은 아니에요"), "계산 못 한 시간도 요약에 적음(빈 시간 22시는 끊김)", tl.summary.exhaust.text);
ok(!/세요|하십시오|권장/.test(JSON.stringify(tl)), "행동 권고 문구 없음(규칙 4)");
const empty = buildPlaceTimeline({ series: [], placeName: "수영장" });
ok(empty.rows.length === 0 && empty.summary.noise.text.includes("예보 자료가 아직 없어요"), "자료 없음");
const quiet = buildPlaceTimeline({ series: [{ hour: t(26, 19), cellsByPlace: { 수영장: { noise: below, exhaust: off } } }], placeName: "수영장" });
ok(quiet.summary.noise.worst === null && quiet.summary.noise.text.includes("없어요"), "조용한 날: '약' 이상 없음");

// 4) 보조 함수
ok(spanList([t(26, 19)]) === "11/26 19~20시", "한 시간 칸 → 19~20시");
const places = [{ name: "A", lat: 37.5, lon: 127.1 }, { name: "B", lat: 37.501, lon: 127.1 }];
ok(nearestPlace(places, 37.5002, 127.1)?.name === "A", "누른 곳에서 가장 가까운 장소");
ok(nearestPlace(places, 37.52, 127.1) === null, "200m 밖이면 null");

// 5) 실제 엔진으로: 장소별 보기의 최고 단계가 문장 예보와 맞는지 (시연용 가정 공연, 바람 고정)
{
  const site = JSON.parse(readFileSync(new URL("../data/site.geojson", import.meta.url)));
  const concaweData = JSON.parse(readFileSync(new URL("../data/concawe_4_81.json", import.meta.url)));
  const byName = new Map(site.features.map((f) => [f.properties.name, f]));
  const pt = (n) => { const [lon, lat] = byName.get(n).geometry.coordinates; return { lat, lon }; };
  const pls = DEFAULT_PLACE_NAMES.map((name) => ({ name, ...pt(name) }));
  const DOME = pt("KSPO DOME"), STAGE = pt("88잔디마당 무대");
  const EQ = -10 * Math.log10(7);
  const spectrum = Object.fromEntries([63, 125, 250, 500, 1000, 2000, 4000].map((f) => [f, EQ]));
  const show = { start: t(26, 19), end: t(26, 22), 출처: "시연용가정" };
  const generators = [0, 1, 2, 3, 4].map((i) => ({ lat: DOME.lat - 0.0006, lon: DOME.lon + (i - 2) * 0.00011, 엔진출력_kW: 500, 출력종류: "엔진", 정보출처: "시연용가정", time: show }));
  const stages = [{ ...STAGE, lwDb: 120, groundType: "soft", dSoftM: 300, hs: 1.5, spectrumRatiosDb: spectrum, time: { start: t(26, 18), end: t(26, 21), 출처: "시연용가정" } }];
  const weather = { tempC: 5, tmp: 5, rhPercent: 60, windVecFromDeg: 315, wsd10m: 3, stability: "D" };
  const real = [];
  for (let h = 17; h <= 23; h++) real.push({ hour: t(26, h), weather, cellsByPlace: placeCellsForHour({ places: pls, stageSources: stages, generatorSources: generators, weather, hour: t(26, h), concaweData }) });
  const lines = buildForecastSentences({ series: real, now: t(26, 15) });
  let agree = true;
  for (const p of pls) {
    const v = buildPlaceTimeline({ series: real, placeName: p.name });
    for (const r of v.rows) for (const layer of ["noise", "exhaust"]) {
      const a = r[layer], b = cellState(real.find((s) => s.hour === r.hour).cellsByPlace[p.name][layer]);
      if (a.kind !== "below" && a.kind !== "none" && (a.kind !== b.kind || a.level !== b.level)) agree = false;
    }
    if (p.name === "올림픽수영장") console.log(`· 수영장 (북서풍 3m/s D): ${v.summary.noise.text} / ${v.summary.exhaust.text}`);
  }
  ok(agree, "실제 엔진 결과: 장소 8곳 × 7시간 × 2레이어 모두 문장 예보 규칙과 같은 상태");
  console.log(`· 같은 입력 문장 예보 1줄: ${lines[0]}`);
}

console.log(fails ? `\n실패 ${fails}건` : "\n전부 통과");
if (fails) process.exitCode = 1;
