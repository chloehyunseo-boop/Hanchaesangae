// 하한값(근거리불확실 B안, 11/22) 검증
// 실행: node validation/plume_lowerbound_test.mjs
import { calcExhaustAtReceiver, arm2Ratio } from "../engine/plume.js";

let fails = 0;
const ok = (c, m) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) fails++; };

// 1) 하한의 전제: NO2 = ARM2비율(NOx)·NOx 가 NOx에 대해 줄어드는 구간이 없음 (0~100,000 µg/m³, 0.5 간격)
let prev = -1, mono = true, worst = null;
for (let x = 0; x <= 100000; x += 0.5) {
  const no2 = arm2Ratio(x) * x;
  if (no2 < prev - 1e-9) { mono = false; worst = x; break; }
  prev = no2;
}
ok(mono, `ARM2 환산 NO2가 NOx에 대해 단조 증가 (0~100,000 µg/m³)${worst ? ` — ${worst}에서 감소` : ""}`);

const DOME = { lat: 37.519163, lon: 127.127359 };
const mLat = 111320, mLon = 111320 * Math.cos((DOME.lat * Math.PI) / 180);
const at = (dx, dy) => ({ lat: DOME.lat + dy / mLat, lon: DOME.lon + dx / mLon });
const truck = (dx, dy) => ({ ...at(dx, dy), 엔진출력_kW: 500, 출력종류: "엔진", 정보출처: "시연용가정" });
const base = { stability: "D", wsd10m: 3, windVecFromDeg: 270, 대기온도_C: 10 }; // 서풍 → 동쪽이 풍하
const recv = at(400, 0);

// 2) 근거리 없음 → 하한값 null
{
  const gens = [0, 10, 20, 30].map((y) => truck(0, y));
  const r = calcExhaustAtReceiver({ generators: gens, receiverLat: recv.lat, receiverLon: recv.lon, ...base });
  ok(!r.flags.includes("근거리불확실") && r.하한값 === null, `근거리 없음 → 하한값 null (value ${r.value.toFixed(4)})`);
}

// 3) 4대는 400m 풍상, 1대는 수음점 서쪽 60m(모든 부채꼴 방향에서 x<100) → 하한값 = 그 1대를 뺀 계산값
{
  const far = [0, 10, 20, 30].map((y) => truck(0, y));
  const near = truck(340, 0);
  const all = calcExhaustAtReceiver({ generators: [...far, near], receiverLat: recv.lat, receiverLon: recv.lon, ...base });
  const farOnly = calcExhaustAtReceiver({ generators: far, receiverLat: recv.lat, receiverLon: recv.lon, ...base });
  ok(all.flags.includes("근거리불확실"), "가까운 1대 포함 → 근거리불확실");
  ok(typeof all.하한값 === "number" && all.하한값 <= all.value + 1e-15, `하한값 ${all.하한값?.toFixed(5)} ≤ value ${all.value.toFixed(5)}`);
  ok(Math.abs(all.하한값 - farOnly.value) < 1e-12, `하한값 = 가까운 1대를 빼고 따로 계산한 값 (${farOnly.value.toFixed(5)})`);
}

// 4) 가까운 1대만 있음 → 하한값 0
{
  const r = calcExhaustAtReceiver({ generators: [truck(340, 0)], receiverLat: recv.lat, receiverLon: recv.lon, ...base });
  ok(r.flags.includes("근거리불확실") && r.하한값 === 0, `가까운 1대만 → 하한값 0 (value ${r.value.toFixed(4)})`);
}

// 5) 계산 실패(발전차 정보 이상) → value null, 하한값 없음
{
  const r = calcExhaustAtReceiver({ generators: [truck(0, 0), { ...truck(340, 0), 엔진출력_kW: NaN }], receiverLat: recv.lat, receiverLon: recv.lon, ...base });
  ok(r.value === null && (r.하한값 === undefined || r.하한값 === null), "계산 실패 → value null, 하한값 없음");
}

// 6) 기존입력가정·전량NO2에서도 하한 ≤ value
for (const 가정 of ["기존입력가정", "전량NO2", "연기상승제외"]) {
  const r = calcExhaustAtReceiver({ generators: [truck(0, 0), truck(0, 10), truck(340, 0)], receiverLat: recv.lat, receiverLon: recv.lon, ...base, 가정 });
  ok(typeof r.하한값 === "number" && r.하한값 <= r.value + 1e-15, `${가정}: 하한값 ${r.하한값?.toFixed(5)} ≤ value ${r.value.toFixed(5)}`);
}

console.log(fails ? `\n실패 ${fails}건` : "\n전부 통과");
if (fails) process.exitCode = 1;
