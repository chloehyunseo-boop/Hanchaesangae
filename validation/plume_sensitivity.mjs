// 배출가스 엔진 민감도 분석 (로드맵 7번 ② "입력값 흔들기", 11/21)
// 실행: node validation/plume_sensitivity.mjs [격자간격m=25]
//
// 무엇을 보나: 기준 입력에서 값 하나만 바꿨을 때, 지도 격자칸의 단계(강·중·약·없음)가
// 얼마나 바뀌는지. 통과/실패는 정하지 않고 그대로 기록해요(CLAUDE.md 8번).
//
// 기준 입력(전부 시연용 — 실제 공연 사양 아님):
//  - 발전차 4대: KSPO DOME 최대 4~5대 제한(공단 답변 VB0000130509, 2026-03-03)의 아래쪽 값.
//    위치는 아직 미확인이라 DOME 중심점에서 동서로 10m 간격 한 줄로 둠(시연용 가정).
//  - 엔진 출력 500kW, 부하율 100%: 기존 손계산 테스트(stage2)와 같은 시험값. 실제 사양 아님.
//  - 기상 3가지: 11월 저녁 맑음 약풍 / 11월 저녁 흐림 / 7월 저녁 맑음. 바람은 서풍(270°).
//  - 엔진 함수 calcExhaustAtReceiver를 그대로 써요(부채꼴 ±22.5°, 2.5° 간격 포함).

import { calcExhaustAtReceiver, classifyExhaustLevel, stabilityFromForecast, advectionWindSpeed, noxEmissionFactorGPerKWh } from "../engine/plume.js";
import { generateGridPoints } from "../engine/combine.js";

const cell = Number(process.argv[2] || 25);
const grid = generateGridPoints(cell);
const DOME = { lat: 37.519163, lon: 127.127359 };
const M_PER_DEG_LAT = 111320;
const mLon = M_PER_DEG_LAT * Math.cos((DOME.lat * Math.PI) / 180);
const kst = (s) => new Date(s.replace(" ", "T") + ":00+09:00");

function trucks({ n = 4, kw = 500, load = 1.0, dxM = 0, dyM = 0 }) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const ex = (i - (n - 1) / 2) * 10 + dxM;
    out.push({ lat: DOME.lat + dyM / M_PER_DEG_LAT, lon: DOME.lon + ex / mLon, 엔진출력_kW: kw, 출력종류: "엔진", loadFactor: load, 정보출처: "시연용가정" });
  }
  return out;
}

function levelOf(r) {
  if (r.value === null) return r.flags.includes("약풍미표시") ? "약풍" : "계산불가";
  if (r.flags.includes("근거리불확실")) return "근거리";
  return classifyExhaustLevel(r.value) ?? "없음";
}

function runMap({ gens, sky, t, ws, vec = 270, scenario = "기본", adv10 = false }) {
  const st = stabilityFromForecast({ sky, wsd10m: ws, lat: DOME.lat, lon: DOME.lon, dateUtc: kst(t), scenario });
  // '이류 풍속 10m 그대로' 비교: 농도는 풍속에 반비례하므로, 엔진 코드는 그대로 두고
  // 배출량에 (2m 보정 풍속 ÷ 10m 풍속)을 곱해 같은 효과를 내요(가정값 문서가 지정한 민감도 항목).
  if (adv10 && ws >= 1) {
    const k = advectionWindSpeed(ws, st.stability) / ws;
    gens = gens.map((g) => ({ ...g, loadFactor: g.loadFactor * k }));
  }
  const levels = new Array(grid.length);
  for (let i = 0; i < grid.length; i++) {
    const p = grid[i];
    levels[i] = levelOf(calcExhaustAtReceiver({ generators: gens, receiverLat: p.lat, receiverLon: p.lon, stability: st.stability, wsd10m: ws, windVecFromDeg: vec }));
  }
  return { levels, stability: st.stability };
}

const RANK = { 없음: 0, 약: 1, 중: 2, 강: 3 };
function summarize(base, alt) {
  const count = (arr, lv) => arr.filter((x) => x === lv).length;
  let changed = 0, considered = 0, up = 0, down = 0;
  for (let i = 0; i < base.length; i++) {
    const a = base[i], b = alt[i];
    if (!(a in RANK) || !(b in RANK)) continue; // 근거리·약풍·계산불가 칸은 비교에서 뺌
    if (a === "없음" && b === "없음") continue; // 둘 다 영향 없음인 칸은 분모에서 뺌
    considered++;
    if (a !== b) { changed++; RANK[b] > RANK[a] ? up++ : down++; }
  }
  return {
    강: count(alt, "강"), 중: count(alt, "중"), 약: count(alt, "약"),
    changedPct: considered ? (100 * changed) / considered : 0, up, down, considered,
  };
}

const CASES = [
  { name: "11월 저녁 맑음 2m/s", sky: "맑음", t: "2026-11-21 19:00", ws: 2 },
  { name: "11월 저녁 흐림 4m/s", sky: "흐림", t: "2026-11-21 19:00", ws: 4 },
  { name: "7월 저녁 맑음 3m/s", sky: "맑음", t: "2026-07-15 19:00", ws: 3 },
];

// 흔들 항목: 로드맵 7번 표 중 배출가스에 해당하는 것 + 가정값 문서가 민감도로 지정한 것
const VARIANTS = [
  { name: "엔진 출력 300kW (소형 시험값)", g: { kw: 300 } },
  { name: "엔진 출력 800kW (대형 시험값)", g: { kw: 800 } },
  { name: "부하율 75%", g: { load: 0.75 } },
  { name: "부하율 50%", g: { load: 0.5 } },
  { name: "대수 5대 (제한 상한)", g: { n: 5 } },
  { name: "대수 8대 (2026년 2월 이전 상한)", g: { n: 8 } },
  { name: "위치 북쪽 50m", g: { dyM: 50 } },
  { name: "위치 남쪽 50m", g: { dyM: -50 } },
  { name: "위치 동쪽 50m", g: { dxM: 50 } },
  { name: "위치 서쪽 50m", g: { dxM: -50 } },
  { name: "풍속 +1m/s", w: (c) => ({ ws: c.ws + 1 }) },
  { name: "풍속 −1m/s", w: (c) => ({ ws: c.ws - 1 }) },
  { name: "하늘상태 한 단계 흐리게", w: (c) => ({ sky: c.sky === "맑음" ? "구름많음" : c.sky === "구름많음" ? "흐림" : "흐림" }), skipIf: (c) => c.sky === "흐림" },
  { name: "하늘상태 한 단계 맑게", w: (c) => ({ sky: c.sky === "흐림" ? "구름많음" : "맑음" }), skipIf: (c) => c.sky === "맑음" },
  { name: "이류 풍속 10m 그대로(2m 보정 안 함)", w: () => ({ adv10: true }) },
  // 참고: 공단 화면 비교 시나리오. 500kW(=670hp, 600hp 초과)의 비제어 계수 14.6 → Tier 4 기준 0.40 g/kWh
  { name: "참고: Tier 4 인증 기준 배출계수", g: { load: 0.4 / noxEmissionFactorGPerKWh(500) } },
  { name: "안정도 비교 시나리오(흐림=0)", w: () => ({ scenario: "비교" }), skipIf: (c) => c.sky !== "흐림" },
];

const t0 = Date.now();
console.log(`격자 ${cell}m, ${grid.length}칸. 기준: 발전차 4대·500kW·부하율 100%·DOME 중심(시연용), 서풍.`);
console.log("변화율 = (기준 또는 변경 후 '약' 이상인 칸 중 단계가 달라진 칸) ÷ (그 칸 수). 근거리(풍하 100m 이내)·약풍 칸은 제외.\n");
const rows = [];
for (const c of CASES) {
  const base = runMap({ gens: trucks({}), ...c });
  const bs = summarize(base.levels, base.levels);
  console.log(`## ${c.name} — 안정도 ${base.stability} | 기준 강 ${bs.강} · 중 ${bs.중} · 약 ${bs.약}칸`);
  rows.push({ case: c.name, variant: "기준", stab: base.stability, ...bs, changedPct: 0 });
  for (const v of VARIANTS) {
    if (v.skipIf && v.skipIf(c)) continue;
    const w = { ...c, ...(v.w ? v.w(c) : {}) };
    if (w.ws < 0) continue;
    const alt = runMap({ gens: trucks(v.g || {}), ...w });
    const s = summarize(base.levels, alt.levels);
    const note = alt.levels.every((x) => x === "약풍") ? " (전부 약풍 — 지도에 안 그림)" : "";
    console.log(`  ${v.name.padEnd(26)} 안정도 ${alt.stability} | 강 ${s.강} 중 ${s.중} 약 ${s.약} | 변화 ${s.changedPct.toFixed(1)}% (↑${s.up} ↓${s.down})${note}`);
    rows.push({ case: c.name, variant: v.name, stab: alt.stability, ...s, note });
  }
  console.log("");
}
console.log(`(계산 ${((Date.now() - t0) / 1000).toFixed(0)}초)`);

// 결과 표를 파일로도 남겨요
import { writeFileSync } from "node:fs";
const md = ["| 기상 | 바꾼 값 | 안정도 | 강 | 중 | 약 | 단계 변화율 | 올라감/내려감 |", "| --- | --- | --- | --- | --- | --- | --- | --- |"];
for (const r of rows) md.push(`| ${r.case} | ${r.variant}${r.note || ""} | ${r.stab} | ${r.강} | ${r.중} | ${r.약} | ${r.variant === "기준" ? "—" : r.changedPct.toFixed(1) + "%"} | ${r.variant === "기준" ? "—" : `${r.up}/${r.down}`} |`);
writeFileSync(new URL(`./plume_sensitivity_result_${cell}m.md`, import.meta.url), `# 배출가스 민감도 결과 (격자 ${cell}m, ${grid.length}칸)\n\n` + md.join("\n") + "\n");
