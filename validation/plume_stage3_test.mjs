// validation/plume_stage3_test.mjs — 한 수음점 최종값(여러 대 합산 + 풍향 부채꼴) 테스트
// 실행: node validation/plume_stage3_test.mjs
import { calcExhaustAtReceiver, calcExhaustGaussianPlume } from "../engine/plume.js";

let fails = 0;
const check = (name, ok, detail) => { if (!ok) fails++; console.log(`${ok ? "✅" : "❌"} ${name}  ${detail}`); };
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
const DOME = { lat: 37.519163, lon: 127.127359 };
function dest(from, bearingDeg, dM) {
  const R = 6371000, d = dM / R, b = (bearingDeg * Math.PI) / 180, la1 = (from.lat * Math.PI) / 180, lo1 = (from.lon * Math.PI) / 180;
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(b));
  const lo2 = lo1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return { lat: (la2 * 180) / Math.PI, lon: (lo2 * 180) / Math.PI };
}
const gen = (p, kw = 500) => ({ lat: p.lat, lon: p.lon, 엔진출력_kW: kw });
const single = (src, rec, vec, st = "D", ws = 3) =>
  calcExhaustGaussianPlume({ sourceLat: src.lat, sourceLon: src.lon, receiverLat: rec.lat, receiverLon: rec.lon, enginePowerKW: 500, stability: st, wsd10m: ws, windVecFromDeg: vec }).value;

// 1) 부채꼴 0°면 단일 계산과 같음
{
  const rec = dest(DOME, 100, 300);
  const r = calcExhaustAtReceiver({ 가정: "기존입력가정", generators: [gen(DOME)], receiverLat: rec.lat, receiverLon: rec.lon, stability: "D", wsd10m: 3, windVecFromDeg: 270, fanHalfWidthDeg: 0 });
  check("부채꼴 0° = 예보 방향 단일 계산", near(r.value, single(DOME, rec, 270)), `${r.value.toFixed(6)} = ${single(DOME, rec, 270).toFixed(6)}`);
}
// 2) 예보 방향에서 20° 벗어난 지점: 부채꼴을 켜면 그 방향으로 돌린 값(중심선 값)을 얻음
{
  const rec = dest(DOME, 110, 400); // 서풍(→90°)에서 20° 벗어남
  const r = calcExhaustAtReceiver({ 가정: "기존입력가정", generators: [gen(DOME)], receiverLat: rec.lat, receiverLon: rec.lon, stability: "F", wsd10m: 2, windVecFromDeg: 270 });
  const axis = single(DOME, rec, 290, "F", 2); // 바람을 20° 돌리면 이 지점이 풍축 위
  check("부채꼴 안 off-axis 지점은 최대값을 찾음", near(r.value, axis, 1e-6) && Math.abs(r.maxAtOffsetDeg - 20) < 1e-9, `부채꼴 최대 ${r.value.toFixed(4)} (오프셋 ${r.maxAtOffsetDeg}°) / 예보 방향만 ${r.centerValue.toExponential(2)}`);
  check("'풍향부채꼴최대' 표시", r.flags.includes("풍향부채꼴최대"), r.flags.join(","));
}
// 3) 부채꼴 밖(40° 벗어남)은 F 안정도에서 거의 0
{
  // 40° 벗어난 지점은 부채꼴 끝(22.5°)에서도 17.5° 떨어져 있어요: y=400·sin17.5°≈120m, σy(F,400m)≈41m
  // → 중심선 대비 exp(−120²/(2·41²)) ≈ 1.4%. 손계산으로 그 값과 같은지 봐요.
  const rec = dest(DOME, 130, 400);
  const r = calcExhaustAtReceiver({ 가정: "기존입력가정", generators: [gen(DOME)], receiverLat: rec.lat, receiverLon: rec.lon, stability: "F", wsd10m: 2, windVecFromDeg: 270 });
  const edge = single(DOME, rec, 270 + 22.5, "F", 2);
  const inFan = single(dest(DOME, 0, 0), dest(DOME, 90, 400), 270, "F", 2);
  check("부채꼴 밖은 부채꼴 끝 방향 값", near(r.value, edge, 1e-9) && r.maxAtOffsetDeg === 22.5, `${r.value.toExponential(2)} ppm (부채꼴 안 중심선 ${inFan.toFixed(3)}의 ${((r.value / inFan) * 100).toFixed(1)}%)`);
}
// 4) 두 대 합산 = 한 대씩 계산한 값의 합 (부채꼴 0°)
{
  const g2 = dest(DOME, 180, 60); // 남쪽 60m에 한 대 더
  const rec = dest(DOME, 95, 350);
  const r = calcExhaustAtReceiver({ 가정: "기존입력가정", generators: [gen(DOME), gen(g2)], receiverLat: rec.lat, receiverLon: rec.lon, stability: "D", wsd10m: 3, windVecFromDeg: 270, fanHalfWidthDeg: 0 });
  const sum = single(DOME, rec, 270) + single(g2, rec, 270);
  check("두 대 합산", near(r.value, sum, 1e-9), `${r.value.toFixed(6)} = ${sum.toFixed(6)}`);
}
// 5) 약풍·계산불가는 null 유지
{
  const rec = dest(DOME, 90, 300);
  const w = calcExhaustAtReceiver({ 가정: "기존입력가정", generators: [gen(DOME)], receiverLat: rec.lat, receiverLon: rec.lon, stability: "D", wsd10m: 0.5, windVecFromDeg: 270 });
  check("약풍은 null", w.value === null && w.flags.includes("약풍미표시"), w.flags.join(","));
  const e = calcExhaustAtReceiver({ 가정: "기존입력가정", generators: [], receiverLat: rec.lat, receiverLon: rec.lon, stability: "D", wsd10m: 3, windVecFromDeg: 270 });
  check("발전차 없음은 계산불가", e.value === null, e.reason);
}
// 6) 풍상측은 부채꼴을 켜도 0
{
  const rec = dest(DOME, 270, 300);
  const r = calcExhaustAtReceiver({ 가정: "기존입력가정", generators: [gen(DOME)], receiverLat: rec.lat, receiverLon: rec.lon, stability: "D", wsd10m: 3, windVecFromDeg: 270 });
  check("풍상측 0", r.value === 0, `${r.value}`);
}
// 7) 외부 검토(11/19) 반영
{
  const rec = dest(DOME, 90, 300);
  const base = { generators: [gen(DOME)], receiverLat: rec.lat, receiverLon: rec.lon, stability: "D", wsd10m: 3 };
  const bad = [
    ["풍향 361°", { windVecFromDeg: 361 }], ["반폭 −22.5°", { windVecFromDeg: 270, fanHalfWidthDeg: -22.5 }],
    ["반폭 NaN", { windVecFromDeg: 270, fanHalfWidthDeg: NaN }], ["간격 0°", { windVecFromDeg: 270, fanHalfWidthDeg: 1, fanStepDeg: 0 }],
    ["발전차 배열에 null", { windVecFromDeg: 270, generators: [null] }], ["발전차 좌표 빠짐", { windVecFromDeg: 270, generators: [{ 엔진출력_kW: 500 }] }],
  ];
  for (const [name, o] of bad) {
    const r = calcExhaustAtReceiver({ 가정: "기존입력가정", ...base, ...o });
    check(`잘못된 입력: ${name}`, r.value === null && r.flags.includes("계산불가"), r.reason);
  }
  // 반폭 1°·간격 2.5°: 중심만이 아니라 ±1° 끝도 계산해야 함 → 1° 돌린 값이 중심보다 크면 그걸 골라야 함
  const rec2 = dest(DOME, 91, 400);
  const r1 = calcExhaustAtReceiver({ 가정: "기존입력가정", ...base, receiverLat: rec2.lat, receiverLon: rec2.lon, windVecFromDeg: 270, fanHalfWidthDeg: 1, fanStepDeg: 2.5 });
  check("반폭 1°도 끝 방향까지 탐색", r1.maxAtOffsetDeg === 1, `최대 오프셋 ${r1.maxAtOffsetDeg}°`);
  // 반폭 10°·간격 3°: 요청한 간격 유지(−10, −7, −4, −1, 0, 2, 5, 8, 10)
  const r3 = calcExhaustAtReceiver({ 가정: "기존입력가정", ...base, receiverLat: dest(DOME, 98, 400).lat, receiverLon: dest(DOME, 98, 400).lon, windVecFromDeg: 270, fanHalfWidthDeg: 10, fanStepDeg: 3 });
  check("간격 3° 유지", r3.maxAtOffsetDeg === 8, `최대 오프셋 ${r3.maxAtOffsetDeg}° (8°에서 최대여야 함)`);
  // 꼬리표 누적: 시연용가정 발전차 + 약풍 → null이어도 시연용가정이 남아야 함
  const w = calcExhaustAtReceiver({ 가정: "기존입력가정", ...base, windVecFromDeg: 270, wsd10m: 0.5, generators: [{ ...gen(DOME), 정보출처: "시연용가정" }] });
  check("null이어도 꼬리표 유지", w.value === null && w.flags.includes("시연용가정") && w.flags.includes("약풍미표시"), w.flags.join(","));
  // 출력종류
  const e = calcExhaustAtReceiver({ 가정: "기존입력가정", ...base, windVecFromDeg: 270, generators: [{ ...gen(DOME), 출력종류: "엔진" }] });
  const k = calcExhaustAtReceiver({ 가정: "기존입력가정", ...base, windVecFromDeg: 270, generators: [{ ...gen(DOME), 출력종류: "전기" }] });
  check("출력종류 엔진이면 꼬리표 없음, 전기면 '엔진출력미확인'", !e.flags.includes("엔진출력미확인") && k.flags.includes("엔진출력미확인"), `엔진: ${e.flags.join(",")} / 전기: ${k.flags.join(",")}`);
}
// 8) 두 대 + 부채꼴: 합계의 최대 방향을 고르는지 (대별 최대의 합이 아님)
{
  const g2 = dest(DOME, 0, 150); // 북쪽 150m
  const rec = dest(DOME, 100, 400);
  const gens = [gen(DOME), gen(g2)];
  const r = calcExhaustAtReceiver({ 가정: "기존입력가정", generators: gens, receiverLat: rec.lat, receiverLon: rec.lon, stability: "F", wsd10m: 2, windVecFromDeg: 270 });
  let bestSum = -1, bestOff = null, sumOfMax = 0;
  const offs = []; for (let o = -22.5; o <= 22.5 + 1e-9; o += 2.5) offs.push(o);
  for (const o of offs) { const s = single(DOME, rec, 270 + o, "F", 2) + single(g2, rec, 270 + o, "F", 2); if (s > bestSum) { bestSum = s; bestOff = o; } }
  sumOfMax = Math.max(...offs.map((o) => single(DOME, rec, 270 + o, "F", 2))) + Math.max(...offs.map((o) => single(g2, rec, 270 + o, "F", 2)));
  check("두 대 + 부채꼴 = 같은 방향 합계의 최대", near(r.value, bestSum, 1e-9) && r.maxAtOffsetDeg === bestOff, `${r.value.toFixed(5)} (오프셋 ${r.maxAtOffsetDeg}°) · 대별 최대의 합이었다면 ${sumOfMax.toFixed(5)}`);
}
// 9) 외부 검토(11/19 2차) 반영
{
  const rec = dest(DOME, 90, 300);
  const base = { generators: [gen(DOME)], receiverLat: rec.lat, receiverLon: rec.lon, stability: "D", wsd10m: 3, windVecFromDeg: 270 };
  const t0 = Date.now();
  const tiny = calcExhaustAtReceiver({ 가정: "기존입력가정", ...base, fanHalfWidthDeg: 1, fanStepDeg: 1e-20 });
  check("아주 작은 간격(1e-20°)은 바로 계산불가", tiny.value === null && Date.now() - t0 < 1000, `${tiny.reason} (${Date.now() - t0}ms)`);
  const lf = calcExhaustAtReceiver({ 가정: "기존입력가정", ...base, generators: [{ ...gen(DOME), loadFactor: null }] });
  check("부하율 null은 계산불가", lf.value === null && lf.flags.includes("계산불가"), lf.reason);
  const keep = calcExhaustAtReceiver({ 가정: "기존입력가정", ...base, generators: [{ ...gen(DOME), 정보출처: "시연용가정" }, { lat: NaN, lon: 127, 엔진출력_kW: 500 }] });
  check("검증 실패여도 다른 발전차 꼬리표 유지", keep.value === null && keep.flags.includes("시연용가정") && keep.flags.includes("계산불가"), `${keep.flags.join(",")} / ${keep.reason}`);
}
console.log(fails ? `\n기대와 다른 항목 ${fails}개 — 위 ❌ 확인` : "\n모든 항목이 기대값과 같아요");
if (fails) process.exitCode = 1; // 자동화 환경에서 실패를 실패로 알리기
