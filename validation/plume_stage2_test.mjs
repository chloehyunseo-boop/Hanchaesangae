// validation/plume_stage2_test.mjs — 배출가스 엔진 2차(확산·배출량) 구현 테스트
// 실행: node validation/plume_stage2_test.mjs
// 기대값은 엔진 코드와 따로, 가정값 문서(docs/발전차_배출가스_가정값과_근거.md)의 식으로
// 파이썬 손계산한 값이에요(2026-11-17). 허용 오차 0.5%.
import { calcExhaustGaussianPlume, no2EmissionRateGPerS, noxEmissionFactorGPerKWh, advectionWindSpeed, classifyExhaustLevel } from "../engine/plume.js";
import { haversineDistanceM } from "../engine/common.js";

let fails = 0;
const check = (name, ok, detail) => { if (!ok) fails++; console.log(`${ok ? "✅" : "❌"} ${name}  ${detail}`); };
const near = (a, b, tol = 0.005) => Math.abs(a - b) <= tol * Math.abs(b);

// 원점(KSPO DOME)에서 방위각·거리만큼 떨어진 지점 (구면 공식)
const DOME = { lat: 37.519163, lon: 127.127359 };
function dest(bearingDeg, dM) {
  const R = 6371000, d = dM / R, b = (bearingDeg * Math.PI) / 180;
  const la1 = (DOME.lat * Math.PI) / 180, lo1 = (DOME.lon * Math.PI) / 180;
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(b));
  const lo2 = lo1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return { lat: (la2 * 180) / Math.PI, lon: (lo2 * 180) / Math.PI };
}
const run = (kw, stab, ws, vec, rec, extra = {}) =>
  calcExhaustGaussianPlume({ sourceLat: DOME.lat, sourceLon: DOME.lon, receiverLat: rec.lat, receiverLon: rec.lon,
    enginePowerKW: kw, stability: stab, wsd10m: ws, windVecFromDeg: vec, ...extra });

// 1) 배출량
check("배출계수 300kW(402hp)", noxEmissionFactorGPerKWh(300) === 18.8, `${noxEmissionFactorGPerKWh(300)} g/kWh (600hp 이하)`);
check("배출계수 500kW(671hp)", noxEmissionFactorGPerKWh(500) === 14.6, `${noxEmissionFactorGPerKWh(500)} g/kWh (600hp 초과)`);
check("600hp 경계 447.4kW", noxEmissionFactorGPerKWh(447.4) === 18.8 && noxEmissionFactorGPerKWh(447.5) === 14.6, "447.4→18.8, 447.5→14.6");
check("NO2 배출률 500kW", near(no2EmissionRateGPerS(500), 1.825), `${no2EmissionRateGPerS(500).toFixed(4)} g/s (손계산 1.825)`);
check("NO2 배출률 300kW", near(no2EmissionRateGPerS(300), 1.41), `${no2EmissionRateGPerS(300).toFixed(4)} g/s (손계산 1.410)`);

// 2) 이류 풍속 (10m→2m, 최소 1m/s)
check("이류 풍속 D 3m/s", near(advectionWindSpeed(3, "D"), 2.0062), `${advectionWindSpeed(3, "D").toFixed(4)} (손계산 2.0062)`);
check("이류 풍속 F 2m/s", near(advectionWindSpeed(2, "F"), 1.2341), `${advectionWindSpeed(2, "F").toFixed(4)} (손계산 1.2341)`);
check("이류 풍속 최소 1m/s", advectionWindSpeed(1.1, "F") === 1.0, `F 1.1m/s → ${advectionWindSpeed(1.1, "F").toFixed(3)}`);

// 3) 풍하 중심선 농도 (서풍 VEC=270 → 동쪽이 풍하)
const cases = [
  [500, "D", 3, 200, 0.183764],
  [500, "F", 2, 200, 0.842139],
  [300, "D", 3, 200, 0.141976],
  [300, "A", 2, 500, 0.007073],
  [500, "D", 3, 1000, 0.009268],
];
for (const [kw, st, ws, x, exp] of cases) {
  const r = run(kw, st, ws, 270, dest(90, x));
  check(`중심선 ${kw}kW ${st} ${ws}m/s ${x}m`, near(r.value, exp), `${r.value.toFixed(6)} ppm (손계산 ${exp}) → ${classifyExhaustLevel(r.value) ?? "미표시"}`);
}
// 4) 풍축에서 30m 벗어난 지점 (풍하 200m)
{
  const r = run(500, "D", 3, 270, dest(90 + (Math.atan2(30, 200) * 180) / Math.PI, Math.hypot(200, 30)));
  check("풍축 옆 30m", near(r.value, 0.114325, 0.01), `${r.value.toFixed(6)} ppm (손계산 0.114325, 허용 1%)`);
}
// 5) 성질 확인
{
  const down = run(500, "D", 3, 270, dest(90, 300)).value;
  const up = run(500, "D", 3, 270, dest(270, 300));
  check("풍상측(바람 오는 쪽)은 0", up.value === 0, `풍하 ${down.toFixed(4)} / 풍상 ${up.value}`);
  const left = run(500, "D", 3, 270, dest(80, 300)).value, right = run(500, "D", 3, 270, dest(100, 300)).value;
  check("풍축 좌우 대칭", near(left, right, 0.01), `${left.toFixed(5)} vs ${right.toFixed(5)}`);
  const vs = [200, 400, 800].map((d) => run(500, "D", 3, 270, dest(90, d)).value);
  check("멀수록 옅어짐", vs[0] > vs[1] && vs[1] > vs[2], vs.map((v) => v.toFixed(4)).join(" > "));
  const d = run(500, "D", 3, 0, dest(180, 300)).value; // 북풍 → 남쪽이 풍하
  check("북풍이면 남쪽으로", d > 0 && near(d, run(500, "D", 3, 270, dest(90, 300)).value, 0.01), `${d.toFixed(5)} ppm`);
  const half = run(500, "D", 3, 270, dest(90, 300), { loadFactor: 0.5 }).value;
  check("부하율 50%면 절반", near(half, down / 2), `${half.toFixed(5)} = ${(down / 2).toFixed(5)}`);
}
// 6) 표시 꼬리표
{
  const weak = run(500, "D", 0.8, 270, dest(90, 300));
  check("약풍 1m/s 미만 미표시", weak.value === 0 && weak.flags.includes("약풍미표시"), weak.flags.join(","));
  const nearF = run(500, "D", 3, 270, dest(90, 60));
  check("100m 이내 근거리불확실", nearF.flags.includes("근거리불확실"), nearF.flags.join(","));
  const demo = run(500, "D", 3, 270, dest(90, 300), { 정보출처: "시연용가정" });
  check("시연용가정 표시", demo.flags.includes("시연용가정"), demo.flags.join(","));
}
// 7) 외부 검토(11/17) 반영: 잘못된 입력·같은 좌표는 0이 아니라 계산 불가
{
  const bads = [
    ["풍속 −1", { wsd10m: -1 }], ["풍속 NaN", { wsd10m: NaN }], ["엔진 출력 음수", { kw: -500 }],
    ["부하율 1.5", { loadFactor: 1.5 }], ["안정도 G", { stab: "G" }], ["풍향 400", { vec: 400 }],
  ];
  for (const [name, o] of bads) {
    const r = run(o.kw ?? 500, o.stab ?? "D", o.wsd10m ?? 3, o.vec ?? 270, dest(90, 300), o.loadFactor !== undefined ? { loadFactor: o.loadFactor } : {});
    check(`잘못된 입력: ${name}`, r.value === null && r.flags.includes("계산불가"), `value=${r.value}, ${r.reason}`);
  }
  const nan = run(500, "D", 3, 270, { lat: NaN, lon: 127 });
  check("잘못된 입력: 좌표 NaN", nan.value === null, `value=${nan.value}, ${nan.reason}`);
  const same = run(500, "D", 3, 270, { lat: DOME.lat, lon: DOME.lon });
  check("음원과 같은 좌표", same.value === null && same.flags.includes("계산불가"), `value=${same.value}, ${same.reason}`);
  // 직선거리 150m지만 풍축에서 70° 벗어나 풍하 거리 x≈51m → 근거리불확실
  const off = run(500, "D", 3, 270, dest(90 + 70, 150));
  check("근거리 판정은 풍하 거리 x 기준", off.flags.includes("근거리불확실"), `x≈${(150 * Math.cos((70 * Math.PI) / 180)).toFixed(0)}m, ${off.flags.join(",")}`);
}
// 8) 단계 경계 (기준 0.10ppm 대비)
check("단계 경계", classifyExhaustLevel(0.05) === "강" && classifyExhaustLevel(0.0499) === "중" && classifyExhaustLevel(0.01) === "중" && classifyExhaustLevel(0.0099) === "약" && classifyExhaustLevel(0.002) === "약" && classifyExhaustLevel(0.0019) === null, "0.05 강 / 0.01 중 / 0.002 약 / 그 미만 미표시");
check("경계 바로 아래는 아래 단계", classifyExhaustLevel(0.04999999999) === "중" && classifyExhaustLevel(0.00999999999) === "약" && classifyExhaustLevel(0.00199999999) === null, "0.04999999999 중 / 0.00999999999 약 / 0.00199999999 미표시");

console.log(fails ? `\n기대와 다른 항목 ${fails}개 — 위 ❌ 확인` : "\n모든 항목이 기대값과 같아요");
