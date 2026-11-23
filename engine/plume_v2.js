// engine/plume_v2.js — 발전차 배출가스 v2 (하린 라인, 2026-11-23)
//
// v1(engine/plume.js)은 한 줄도 바꾸지 않았어요. v2는 v1의 계산(가우시안 플룸·ISC3 도시형 σ·
// Turner 안정도·Briggs·ARM2·부채꼴·근거리 하한값)을 그대로 부르고, "발전차 입력"만 국내 현실에
// 맞게 바꾸는 얇은 층이에요. 만약 v2에 문제가 생기면 화면에서 v1(calcExhaustAtReceiver)로
// 되돌리기만 하면 돼요.
//
// v2에서 바뀐 가정 (근거: docs/발전차_배출가스_v2_가정값.md)
//  1) 발전차 1대 = 200kW급 발전기 2대 (국내 렌탈 업체 9곳 조사 최대 구성, 2026-11-23)
//  2) 대표 모델: 인증 = Cat XQ230 (EPA Tier 4 Final), 비인증 = Cat DE200 GC (배출 인증 표기 없음)
//  3) 엔진 출력: Cat C7.1 320마력 = 238.6kW (중고 장비 판매 페이지 표기 — Cat 공식 사양서엔 엔진 출력 없음)
//  4) NOx 배출계수: 인증 0.40 g/kWh (40 CFR 1039.101 Tier 4 Final, 130~560kW 한도)
//                   비인증 18.8 g/kWh (AP-42 3.3 표 3.3-1, 비제어 600마력 이하 평균)
//  5) 배기 온도·배기량: 인증 533℃·38.3m³/min (같은 C7.1 엔진의 Cat D200 GC 사양서),
//                      비인증 485℃·39.4m³/min (Cat DE200 GC 사양서 60Hz)
//  그대로: 부하율 0.43(EPA), 배기구 높이 3.0m, 건물 옆이면 연기 상승 제외, ARM2, 부채꼴, 3단계 기준.
//
// 구현 메모 — 배출계수를 v1에 넘기는 방법:
//  v1은 배출률 = 엔진출력 × 부하율 × AP-42계수(출력으로 고름) 로 계산해요(EPA 식 Power×LF×EF).
//  v1 코드를 고치지 않으려고, v2는 v1에 "부하율 × (목표 배출계수 ÷ v1이 고를 AP-42 계수)"를 넘겨요.
//  곱(엔진출력×부하율×배출계수)이 같으니 배출률이 정확히 같아요. 이 값은 '실효 부하율'일 뿐
//  실제 부하율이 바뀐 게 아니에요 — 결과의 꼬리표에는 실제 부하율(0.43)과 배출계수를 따로 적어요.
//  (validation/plume_v2_test.mjs 1번이 배출률이 정확히 같은지 확인해요.)

import { calcExhaustAtReceiver, noxEmissionFactorGPerKWh, DEFAULT_LOAD_FACTOR_NONROAD } from "./plume.js";

const KW_PER_HP = 0.745699872;

/** v2 가정값 — 이 표에 없는 값은 v2에서 만들지 않아요. 출처는 docs/발전차_배출가스_v2_가정값.md */
export const V2_ASSUMPTIONS = Object.freeze({
  발전기_per_발전차: 2,
  엔진출력_kW: 320 * KW_PER_HP, // 238.6kW — Cat C7.1 "rated 320 HP at 1800 RPM" (중고 판매 페이지)
  부하율: DEFAULT_LOAD_FACTOR_NONROAD, // 0.43 (EPA NR-005c, 발전기 세트)
  배기구높이_m: 3.0,
  인증: Object.freeze({
    대표모델: "Cat XQ230 (EPA Tier 4 Final)",
    NOx_g_per_kWh: 0.40, // 40 CFR 1039.101 표 1, 130≤kW≤560
    배기온도_C: 533, // Cat D200 GC(같은 C7.1 엔진) 사양서 LEHE2668-02
    배기량_m3_per_min: 38.3,
  }),
  비인증: Object.freeze({
    대표모델: "Cat DE200 GC (배출 인증 표기 없음, 'Low BSFC')",
    NOx_g_per_kWh: 18.8, // AP-42 3.3 표 3.3-1 (0.031 lb/hp-hr), DE200 GC는 NOx 미공개라 비제어 평균 사용
    배기온도_C: 485, // Cat DE200 GC 사양서 60Hz
    배기량_m3_per_min: 39.4,
  }),
});

/** 배출 시나리오: 공단이 발전기 인증 등급을 모를 때 쓰는 기본값. 시민 지도 기본은 "인증"(하린 결정 11/23). */
export const EMISSION_SCENARIOS_V2 = ["인증", "비인증"];

const finite = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * v2 NOx 배출계수(g/kWh). 엔진 출력에 따라 구간이 달라요.
 *  인증: 40 CFR 1039.101 표 1 — 56≤kW≤560 0.40, 560 초과 발전기 세트 0.67 (assumptions.json Tier4 값과 같음). 56 미만은 v2 범위 밖(null).
 *  비인증: AP-42 비제어 평균 — v1의 noxEmissionFactorGPerKWh 그대로(600마력 이하 18.8, 초과 14.6).
 */
export function nox계수V2(grade, enginePowerKW) {
  if (grade === "비인증") return noxEmissionFactorGPerKWh(enginePowerKW);
  if (enginePowerKW < 56) return null;
  return enginePowerKW > 560 ? 0.67 : 0.40;
}

/**
 * 발전차(트럭) 목록 → v1이 받는 발전기 목록으로 펼쳐요.
 * @param {{lat:number, lon:number, 발전기수?:number, 인증등급?:"인증"|"비인증", 엔진출력_kW?:number, 건물옆?:boolean,
 *   배기구높이_m?:number, 정보출처?:string}[]} trucks
 * @param {"인증"|"비인증"} 배출시나리오  인증등급을 입력하지 않은 발전차에 쓰는 값
 * @returns {{generators:any[], flags:string[]}|{error:string}}
 */
export function expandTrucksV2(trucks, 배출시나리오 = "인증") {
  if (!EMISSION_SCENARIOS_V2.includes(배출시나리오)) return { error: `배출시나리오는 ${EMISSION_SCENARIOS_V2.join("·")} 중 하나: ${배출시나리오}` };
  if (!Array.isArray(trucks) || trucks.length === 0) return { error: "발전차 없음" };
  const generators = [];
  const flags = new Set();
  for (let i = 0; i < trucks.length; i++) {
    const t = trucks[i];
    if (!t || typeof t !== "object") return { error: `발전차 ${i + 1}번 정보가 비어 있어요` };
    const n = t.발전기수 ?? V2_ASSUMPTIONS.발전기_per_발전차;
    if (!Number.isInteger(n) || n < 1 || n > 4) return { error: `발전차 ${i + 1}번: 발전기 수는 1~4 정수: ${t.발전기수}` };
    if (t.발전기수 === undefined) flags.add("발전기수_가정(2대)");
    const grade = t.인증등급 ?? 배출시나리오;
    if (!EMISSION_SCENARIOS_V2.includes(grade)) return { error: `발전차 ${i + 1}번: 인증등급은 ${EMISSION_SCENARIOS_V2.join("·")} 중 하나: ${t.인증등급}` };
    if (t.인증등급 === undefined) flags.add(`인증등급미입력_${배출시나리오}가정`);
    flags.add(grade === "인증" ? "배출계수_Tier4F한도" : "배출계수_AP42비제어평균");
    const kw = t.엔진출력_kW ?? V2_ASSUMPTIONS.엔진출력_kW;
    if (!finite(kw) || kw <= 0 || kw > 2000) return { error: `발전차 ${i + 1}번: 엔진출력 0~2000kW: ${t.엔진출력_kW}` };
    if (t.엔진출력_kW === undefined) flags.add("엔진출력_대표모델가정(320마력)");
    const spec = V2_ASSUMPTIONS[grade];
    const ef = nox계수V2(grade, kw);
    if (ef === null) return { error: `발전차 ${i + 1}번: 인증 엔진 한도표는 56kW 이상만 있어요(40 CFR 1039.101 표 1 중 v2가 옮긴 구간): ${kw}kW` };
    // v1이 고를 AP-42 계수에 대한 비율로 '실효 부하율'을 만들어요(위 구현 메모).
    const effLoad = V2_ASSUMPTIONS.부하율 * (ef / noxEmissionFactorGPerKWh(kw));
    for (let k = 0; k < n; k++) {
      generators.push({
        lat: t.lat, lon: t.lon,
        엔진출력_kW: kw, 출력종류: "엔진",
        loadFactor: effLoad,
        배기구높이_m: t.배기구높이_m ?? V2_ASSUMPTIONS.배기구높이_m,
        배기온도_C: spec.배기온도_C,
        배기량_m3_per_min: spec.배기량_m3_per_min,
        ...(t.건물옆 === undefined ? {} : { 건물옆: t.건물옆 }),
        ...(t.정보출처 === undefined ? {} : { 정보출처: t.정보출처 }),
      });
    }
  }
  flags.add("v2_대표모델사양");
  return { generators, flags: [...flags] };
}

/**
 * v2 배출가스 농도. 입력이 발전차(트럭) 단위라는 것만 다르고, 나머지 인자·결과 모양은 v1과 같아요.
 * @param {{trucks:any[], receiverLat:number, receiverLon:number, stability:string, wsd10m:number,
 *   windVecFromDeg:number, 대기온도_C?:number, 배출시나리오?:"인증"|"비인증", fanHalfWidthDeg?:number, fanStepDeg?:number}} p
 * @returns {{value:number|null, flags:string[], scenario:string, reason?:string, centerValue?:number|null,
 *   maxAtOffsetDeg?:number|null, no2NoxRatio?:number, 하한값?:number|null}}
 */
export function calcExhaustAtReceiverV2({ trucks, 배출시나리오 = "인증", ...rest }) {
  const scenario = `v2_${배출시나리오}_가우시안플룸_ISC3도시형_풍향부채꼴최대`;
  const ex = expandTrucksV2(trucks, 배출시나리오);
  if (ex.error) return { value: null, flags: ["계산불가"], scenario, reason: ex.error };
  const r = calcExhaustAtReceiver({ ...rest, generators: ex.generators, 가정: "기본추정" });
  // v1이 붙이는 '부하율EPA기본값'은 실효 부하율을 넘겨서 안 붙어요. v2에선 실제 부하율이 EPA 기본값이라 다시 붙여요.
  const flags = [...new Set([...r.flags, ...ex.flags, "부하율EPA기본값"])];
  return { ...r, flags, scenario };
}
