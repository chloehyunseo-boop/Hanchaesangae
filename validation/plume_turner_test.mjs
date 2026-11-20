// Turner(1970) 워크북 예제와 배출가스 엔진 비교 (11/20 동결 전 점검)
// 출처: D. Bruce Turner, "Workbook of Atmospheric Dispersion Estimates", EPA AP-26 (Revised 1970),
//       https://nepis.epa.gov/Exe/ZyPURL.cgi?Dockey=9100JEIO.txt (2026-11-20 원문 텍스트에서 숫자 직접 확인)
// 실행: node validation/plume_turner_test.mjs
//
// 무엇을 보나
//  A. 농도 식: 문제 26(지면 배출·지면 수용점, 식 3.4)의 σy·σz·Q·u를 엔진 함수에 그대로 넣어 교재 답과 비교.
//     → 엔진의 "식"이 맞는지 봐요. 우리 엔진의 σ(도시형)는 교재 σ(시골형 P-G)와 다르므로 여기선 안 써요.
//  B. 안정도: 교재 문제의 "날씨 말 → 안정도" 판단을 엔진(하늘상태·시각·풍속)으로 다시 해 봐요.
//     교재엔 날짜·장소가 없어서 날짜는 우리가 고른 대표 시각(올림픽공원 좌표)이에요.
//  C. 참고: 같은 거리에서 교재 σ(시골형)와 엔진 σ(도시형) 비교 — 통과/실패 없이 기록만.

import { gaussianGroundLevelConc, stabilityFromForecast } from "../engine/plume.js";

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? "✓" : "✗"} ${msg}`); if (!cond) fails++; };
const note = (msg) => console.log(`· ${msg}`);

// ---------------------------------------------------------------------------
console.log("\nA. 농도 식 — Turner 문제 26 (표 7-9). Q=1100 g/s, u=2 m/s, F 안정도, 풍하 중심선");
// [x km, σz m, σy m, 교재 χ g/m³] — 교재 표 그대로 (σy는 가상거리 x+xy 기준 값)
const P26 = [
  [0.1, 2.3, 5.5, 13.9],
  [0.3, 5.6, 12.5, 2.5],
  [0.6, 9.7, 22, 8.2e-1],
  [1, 14, 35, 3.6e-1],
  [3, 27, 93, 7.0e-2],
  [6, 37, 175, 2.7e-2],
  // 10 km: NEPIS 텍스트 변환본엔 "1.4 x 10-3"으로 나오지만, 원문 쪽 이미지(55쪽, 표 7-9)에는 1.4 x 10⁻²로
  // 인쇄돼 있어요(2026-11-20 직접 확인). 텍스트 변환(OCR) 오류였어요.
  [10, 47, 275, 1.4e-2],
];
// 교재 답은 1970년 손계산을 유효숫자 2~3자리로 적은 값이에요.
// 기준: 엔진 값이 교재가 적은 마지막 자릿수의 ±1 안에 들면 같은 값으로 봐요
// (예: 교재 1.4×10⁻²면 1.3~1.5×10⁻², 교재 13.9면 13.8~14.0).
const lastDigitUnit = (v) => {
  const [mant, exp] = v.toExponential().split("e");
  const decimals = (mant.split(".")[1] || "").length;
  const sig = Math.max(decimals, 1); // 교재는 최소 유효숫자 2자리로 적음(7.0×10⁻², 2.5). JS에선 7.0이 7로 줄어서 1자리 보정
  return 10 ** (Number(exp) - sig);
};
for (const [x, sz, sy, book] of P26) {
  const c = gaussianGroundLevelConc({ qGPerS: 1100, u: 2, sigmaY: sy, sigmaZ: sz });
  const unit = lastDigitUnit(book);
  const rel = Math.abs(c - book) / book;
  ok(Math.abs(c - book) <= unit * 1.0000001, `x=${x}km: 엔진 ${c.toPrecision(3)} / 교재 ${book} (차이 ${(rel * 100).toFixed(1)}%, 허용 ±${unit.toPrecision(1)})`);
}
{
  // 옆으로 벗어난 지점: 교재 식 (3.1)·(3.4)의 exp(−y²/2σy²) 항. σy만큼 벗어나면 중심의 e^−0.5배.
  const c0 = gaussianGroundLevelConc({ qGPerS: 1100, u: 2, sigmaY: 35, sigmaZ: 14 });
  const c1 = gaussianGroundLevelConc({ qGPerS: 1100, u: 2, sigmaY: 35, sigmaZ: 14, y: 35 });
  ok(Math.abs(c1 / c0 - Math.exp(-0.5)) < 1e-12, `y=σy에서 중심 대비 ${(c1 / c0).toFixed(4)} (= e^−0.5 = 0.6065)`);
}

// ---------------------------------------------------------------------------
console.log("\nB. 안정도 — 교재 문제의 판단과 엔진 비교 (올림픽공원 좌표, 대표 시각은 우리가 고름)");
const lat = 37.519163, lon = 127.127359;
const kst = (s) => new Date(s.replace(" ", "T") + ":00+09:00");
const run = (sky, t, ws, scenario = "기본") => stabilityFromForecast({ sky, wsd10m: ws, lat, lon, dateUtc: kst(t), scenario });

const CASES = [
  // [교재 문제, 교재 말, 하늘, 대표 시각(KST), 풍속, 교재 답]
  ["문제 1", "흐린 밤, 7 m/s", "흐림", "2026-11-20 02:00", 7, "D"],
  ["문제 5", "흐린 낮, 4 m/s", "흐림", "2026-11-20 12:00", 4, "D"],
  ["문제 21", "맑은 밤, 4 m/s", "맑음", "2026-11-20 03:00", 4, "E"],
  ["문제 26", "맑은 밤 03시, 2 m/s", "맑음", "2026-11-20 03:00", 2, "F"],
  ["선 배출원 문제(문제 21과 25 사이, 번호 쪽 누락)", "가을 맑은 오후 16시, 3 m/s(약한 일사)", "맑음", "2026-10-15 16:00", 3, "C"],
  ["문제 20", "맑은 여름 오후, 6 m/s", "맑음", "2026-07-15 14:00", 6, "C"],
];
for (const [p, words, sky, t, ws, book] of CASES) {
  const r = run(sky, t, ws);
  ok(r.stability === book, `${p} (${words}) → 엔진 ${r.stability} / 교재 ${book}  [${t}, 태양고도 ${r.solarElevation.toFixed(0)}°, 순복사지수 ${r.netRadiationIndex}]`);
}

console.log("\n  기록(판정 없음): 교재 말이 시각을 정확히 안 줘서 결과가 갈리는 경우");
for (const h of ["13:00", "14:00", "15:00", "16:00"]) {
  const r = run("맑음", `2026-07-15 ${h}`, 6);
  note(`맑은 여름 오후 6 m/s, ${h} → ${r.stability} (태양고도 ${r.solarElevation.toFixed(0)}°) — 교재 C`);
}
for (const sc of ["기본", "비교"]) {
  const r = run("흐림", "2026-07-15 12:00", 4, sc);
  note(`흐린 여름 낮 4 m/s, ${sc} 시나리오 → ${r.stability} — 교재 D (교재 '흐림'은 구름 10할)`);
}

// ---------------------------------------------------------------------------
console.log("\nC. 참고: 교재 σ(시골형 P-G, F) vs 엔진 σ(ISC3 도시형, F) — 판정 없음");
const urbanF = {
  sy: (x) => 0.11 * x * (1 + 0.0004 * x) ** -0.5,
  sz: (x) => 0.08 * x * (1 + 0.0015 * x) ** -0.5,
};
for (const [xkm, sz, sy] of P26.slice(1, 4)) {
  const x = xkm * 1000;
  note(`x=${xkm}km: σy 교재 ${sy} / 엔진 ${urbanF.sy(x).toFixed(0)} m, σz 교재 ${sz} / 엔진 ${urbanF.sz(x).toFixed(0)} m`);
}
note("도시형 σ가 더 넓어 같은 조건이면 엔진 농도가 교재(시골)보다 낮아요. 도시(건물·열) 확산을 반영한 ISC3 선택의 결과예요.");

console.log(fails ? `\n실패 ${fails}건` : "\n판정 항목 전부 일치");
if (fails) process.exitCode = 1;
