// validation/plume_stage4_test.mjs — 11/21 변경(시나리오 4종·ARM2·배기구 높이·연기 상승) 손계산 테스트
// 실행: node validation/plume_stage4_test.mjs
// 기대값은 엔진과 따로 파이썬으로 계산했어요(2026-11-21). 근거: docs/배출가스_기본추정_변경_적용본.md
import {
  calcExhaustAtReceiver, buoyancyFlux, briggsBuoyantRise, windSpeedAtHeight, arm2Ratio, isBuoyancyDominated,
  stabilityFromForecast, DEFAULT_EXHAUST, DEFAULT_LOAD_FACTOR_NONROAD,
} from "../engine/plume.js";

let fails = 0;
const check = (name, ok, detail = "") => { if (!ok) fails++; console.log(`${ok ? "✅" : "❌"} ${name}  ${detail}`); };
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
const DOME = { lat: 37.519163, lon: 127.127359 };
const east = (dM) => ({ lat: DOME.lat, lon: DOME.lon + dM / (111320 * Math.cos((DOME.lat * Math.PI) / 180)) });

// 1) 부력 플럭스 (ISC3 식 1-8)
const Fb = buoyancyFlux({ ...DEFAULT_EXHAUST, 대기온도_C: 10 });
check("부력 플럭스 F_b", near(Fb, 2.7975976310273842, 1e-12), `${Fb.toFixed(4)} m⁴/s³ (기대 2.7976)`);
check("배기가 대기보다 차가우면 F_b = 0", buoyancyFlux({ 배기온도_C: 5, 배기량_m3_per_min: 80, 대기온도_C: 10 }) === 0);

// 2) 배출 높이 풍속 (식 1-6, 도시형 p, 최소 1 m/s)
const usF = windSpeedAtHeight(2, "F", 3);
check("3m 풍속(F, 10m 2m/s)", near(usF, 1.393690603871898, 1e-12), usF.toFixed(4));
check("3m 풍속 최소 1m/s", windSpeedAtHeight(1, "F", 3) === 1.0);
check("높이 0이면 2m 기준(기존과 같음)", near(windSpeedAtHeight(3, "D", 0), Math.max(3 * 0.2 ** 0.25, 1)));

// 3) Briggs 상승 — 안정(F)·중립(D), 최종 상승 거리 전후
{
  const r50 = briggsBuoyantRise({ Fb, us: usF, stability: "F", 대기온도_C: 10, x: 50 });
  const r300 = briggsBuoyantRise({ Fb, us: usF, stability: "F", 대기온도_C: 10, x: 300 });
  check("F 최종 상승(식 1-20)", near(r300.final, 30.75668177339722, 1e-10), `${r300.final.toFixed(2)} m`);
  check("F 최종 상승 거리(식 1-19)", near(r300.xf, 82.90697449577233, 1e-10), `${r300.xf.toFixed(1)} m`);
  check("F x=50m < x_f → 점진 상승(식 1-22)", near(r50.dh, 21.954760170343302, 1e-10), `${r50.dh.toFixed(2)} m`);
  check("F x=300m > x_f → 최종 상승", near(r300.dh, r300.final));
  const usD = windSpeedAtHeight(4, "D", 3);
  const d = briggsBuoyantRise({ Fb, us: usD, stability: "D", 대기온도_C: 10, x: 100 });
  check("D 최종 상승(식 1-14)", near(d.final, 15.655590903670436, 1e-10), `${d.final.toFixed(2)} m`);
  check("D 최종 상승 거리(식 1-12)", near(d.xf, 93.20449597448658, 1e-10), `${d.xf.toFixed(1)} m`);
  check("F_b = 0이면 상승 0", briggsBuoyantRise({ Fb: 0, us: 2, stability: "D", 대기온도_C: 10, x: 100 }).dh === 0);
  // 기상 조건마다 최종 상승 거리와 수용점 거리 비교(검토 2회차 요청)
  for (const [st, u10] of [["D", 2], ["D", 6], ["E", 3], ["F", 1], ["F", 3]]) {
    const us = windSpeedAtHeight(u10, st, 3);
    const a = briggsBuoyantRise({ Fb, us, stability: st, 대기온도_C: 10, x: 100 });
    const pass = (100 < a.xf ? a.dh <= a.final + 1e-12 : near(a.dh, a.final));
    check(`x_f 비교 ${st} ${u10}m/s`, pass, `x_f ${a.xf.toFixed(0)}m, x=100m에서 ${100 < a.xf ? "점진" : "최종"} 상승 ${a.dh.toFixed(1)}m`);
  }

  // 점진 상승 값 자체도 독립 손계산과 대조(코드 검토 11/21: 부등식만으로는 식 오류를 못 잡음)
  const e3 = briggsBuoyantRise({ Fb, us: windSpeedAtHeight(3, "E", 3), stability: "E", 대기온도_C: 10, x: 100 });
  check("E 3m/s x=100m 점진 상승 값(식 1-22)", near(e3.dh, 23.234006260074985, 1e-10), `${e3.dh.toFixed(3)} m (기대 23.234)`);
}

// 3-1) 부력 지배 판정 (ISC3 식 1-10·1-11·1-18) — 코드 검토 P1
{
  const Dd = isBuoyancyDominated({ ...DEFAULT_EXHAUST, 배기구지름_m: 0.2, 대기온도_C: 10, stability: "D", Fb });
  check("기본 배기·지름 0.2m·D → 부력 지배(ΔT 462K ≥ (ΔT)c 231.9K)", Dd === true);
  const low = { 배기온도_C: 150, 배기량_m3_per_min: 86.7, 배기구지름_m: 0.1, 대기온도_C: 10 };
  const Fb2 = buoyancyFlux(low);
  check("150℃·지름 0.1m·D → 부력 지배 아님(ΔT 140K < 331.8K)", isBuoyancyDominated({ ...low, stability: "D", Fb: Fb2 }) === false);
  check("150℃·지름 0.1m·F → 부력 지배((ΔT)c 53.1K)", isBuoyancyDominated({ ...low, stability: "F", Fb: Fb2 }) === true);
  check("지름 없으면 판정 불가(null)", isBuoyancyDominated({ ...DEFAULT_EXHAUST, 대기온도_C: 10, stability: "D", Fb }) === null);
}
{
// 4) ARM2 (다항식 + 0.5~0.9)
for (const [x, y] of [[50, 0.9], [150, 0.797417681765625], [200, 0.668224128], [300, 0.5], [1000, 0.5]]) {
  check(`ARM2(${x} µg/m³)`, near(arm2Ratio(x), y, 1e-9), arm2Ratio(x).toFixed(4));
}
}

// 5) 전체 손계산: 1대 500kW, F, 10m 2m/s, 동쪽 약 300m(엔진 거리 299.663m, 방위 89.999°), 기온 10℃
//    파이썬 기대값도 같은 거리·방위로 계산했어요.
const one = (extra = {}) => ({ lat: DOME.lat, lon: DOME.lon, 엔진출력_kW: 500, 출력종류: "엔진", ...extra });
const rec300 = east(300);
const base = { receiverLat: rec300.lat, receiverLon: rec300.lon, stability: "F", wsd10m: 2, windVecFromDeg: 270, fanHalfWidthDeg: 0, 대기온도_C: 10 };
{
  const open = calcExhaustAtReceiver({ ...base, generators: [one({ 건물옆: false })] });
  check("개방된 곳: 부하율 0.43 + 배기구 3m + 상승 + ARM2", near(open.value, 0.036495620955338835, 1e-9),
    `${open.value.toFixed(5)} ppm (기대 0.03650), 비율 ${open.no2NoxRatio}`);
  check("개방된 곳 꼬리표", open.flags.includes("연기상승적용") && open.flags.includes("배기사양가정") && open.flags.includes("부하율EPA기본값") && open.flags.includes("ARM2"), open.flags.join(","));

  const bld = calcExhaustAtReceiver({ ...base, generators: [one()] }); // 건물옆 기본값(undefined) → 상승 제외
  check("건물옆(기본): 상승 제외, 배기구 3m 유지", near(bld.value, 0.08435775029537829, 1e-9), `${bld.value.toFixed(5)} ppm (기대 0.08436), 비율 ${bld.no2NoxRatio}`);
  check("건물옆 꼬리표", bld.flags.includes("건물옆_연기상승제외"), bld.flags.join(","));

  const noRise = calcExhaustAtReceiver({ ...base, 가정: "연기상승제외", generators: [one({ 건물옆: false })] });
  check("연기상승제외 시나리오 = 건물옆 결과", near(noRise.value, bld.value) && noRise.flags.includes("연기상승제외"));

  const noTemp = calcExhaustAtReceiver({ ...base, 대기온도_C: undefined, generators: [one({ 건물옆: false })] });
  check("기온 없으면 상승 제외 + 꼬리표", near(noTemp.value, bld.value) && noTemp.flags.includes("기온없음_연기상승제외"));

  const all = calcExhaustAtReceiver({ ...base, 가정: "전량NO2", generators: [one()] });
  check("전량NO2 = NOx 전부 NO2", near(all.value, bld.value / bld.no2NoxRatio, 1e-9) && all.no2NoxRatio === 1, `${all.value.toFixed(4)} ppm`);

  const legacy = calcExhaustAtReceiver({ ...base, 가정: "기존입력가정", generators: [one()] });
  const h0 = calcExhaustAtReceiver({ ...base, generators: [one({ 배기구높이_m: 0, loadFactor: 1.0 })] });
  check("배기구 0m·부하율 1.0이면 기존 식에 ARM2만 다름", near(h0.value, (legacy.value / 0.9) * h0.no2NoxRatio, 1e-9),
    `기존 ${legacy.value.toFixed(4)} → ${h0.value.toFixed(4)} (비율 ${h0.no2NoxRatio})`);
  check("기존입력가정엔 새 꼬리표 없음", !legacy.flags.some((f) => /ARM2|배기|부하율EPA|연기/.test(f)), legacy.flags.join(",") || "(없음)");

  const lf = calcExhaustAtReceiver({ ...base, generators: [one({ loadFactor: DEFAULT_LOAD_FACTOR_NONROAD })] });
  check("부하율 0.43 명시 = 기본값", near(lf.value, bld.value) && !lf.flags.includes("부하율EPA기본값"));
}

// 6) 여러 대: NOx를 더한 뒤 ARM2 (대별 NO2 합과 다름)
{
  const g2 = [one(), one({ lat: DOME.lat + 0.00005 })];
  const two = calcExhaustAtReceiver({ ...base, generators: g2 });
  const a = calcExhaustAtReceiver({ ...base, 가정: "전량NO2", generators: [g2[0]] }).value;
  const b = calcExhaustAtReceiver({ ...base, 가정: "전량NO2", generators: [g2[1]] }).value;
  const noxSumPpm = a + b; // NOx(ppm, NO2 환산 계수)
  check("두 대: 합계 NOx에 ARM2 한 번", near(two.value, noxSumPpm * two.no2NoxRatio, 1e-9), `비율 ${two.no2NoxRatio}`);
  // 대별 NOx까지 엔진과 따로 파이썬으로 계산한 값(같은 하버사인·방위각 식, 코드 검토 11/21)
  check("두 대 전체 독립 손계산", near(two.value, 0.1673849685350485, 1e-9), `${two.value.toFixed(5)} ppm (기대 0.16738)`);
}

// 6-1) 부력 지배 판정이 전체 계산에 반영되는지
{
  const lowT = calcExhaustAtReceiver({ ...base, stability: "D", wsd10m: 4, generators: [one({ 건물옆: false, 배기온도_C: 150, 배기구지름_m: 0.1 })] });
  check("개방된 곳이라도 부력 지배 아니면 상승 제외", lowT.flags.includes("부력지배아님_연기상승제외") && !lowT.flags.includes("연기상승적용"), lowT.flags.join(","));
  const noD = calcExhaustAtReceiver({ ...base, generators: [one({ 건물옆: false, 배기온도_C: 400 })] });
  check("사용자 배기 온도만 있고 지름 없으면 상승 제외", noD.flags.includes("지름없음_연기상승제외"), noD.flags.join(","));
  const withD = calcExhaustAtReceiver({ ...base, generators: [one({ 건물옆: false, 배기구지름_m: 0.2 })] });
  const noDdef = calcExhaustAtReceiver({ ...base, generators: [one({ 건물옆: false })] });
  check("기본 배기 + 지름 0.2m → 상승 적용, 지름 없을 때와 같은 값", withD.flags.includes("연기상승적용") && near(withD.value, noDdef.value));
}
// 6-2) 안정도 좌표 검증(코드 검토 P2)
{
  const t = new Date("2026-11-21T19:00:00+09:00");
  const throws = (f) => { try { f(); return false; } catch { return true; } };
  check("위도 NaN → 오류", throws(() => stabilityFromForecast({ sky: "맑음", wsd10m: 2, lat: NaN, lon: 127, dateUtc: t })));
  check("경도 200 → 오류", throws(() => stabilityFromForecast({ sky: "맑음", wsd10m: 2, lat: 37.5, lon: 200, dateUtc: t })));
  check("위도 문자열 → 오류", throws(() => stabilityFromForecast({ sky: "맑음", wsd10m: 2, lat: "37.5", lon: 127, dateUtc: t })));
}

// 7) 입력 검증
const bad = (o, gx = {}) => calcExhaustAtReceiver({ ...base, ...o, generators: [one(gx)] });
check("가정 이름 오류 → 계산불가", bad({ 가정: "최악" }).value === null);
check("대기온도 범위 밖 → 계산불가", bad({ 대기온도_C: 99 }).value === null);
check("배기 온도 이상 → 계산불가", bad({}, { 배기온도_C: 5000 }).value === null);
check("배기량 0 → 계산불가", bad({}, { 배기량_m3_per_min: 0 }).value === null);
check("배기구 높이 음수 → 계산불가", bad({}, { 배기구높이_m: -1 }).value === null);
check("건물옆 문자열 → 계산불가", bad({}, { 건물옆: "예" }).value === null);
check("배기구 지름 0 → 계산불가", bad({}, { 배기구지름_m: 0 }).value === null);
check("약풍 → null + 약풍미표시", (() => { const r = bad({ wsd10m: 0.5 }); return r.value === null && r.flags.includes("약풍미표시"); })());
check("풍상측 → 0", bad({ windVecFromDeg: 90 }).value === 0);

console.log(fails ? `\n실패 ${fails}건` : "\n전부 통과");
if (fails) process.exitCode = 1;
