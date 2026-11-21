// validation/noise_validation.mjs — 소음 엔진(noise.js, combine.js) 손계산 검증 (11/21, 친구 라인)
// 로드맵 M2 11/17·11/20 완료 기준을 확인해요: "거리 감쇠(Adiv)만 단독 검증 시 거리 2배마다
// −6dB", "공기 흡수", "물리 상식". 실행: node validation/noise_validation.mjs

import { calcAdiv, atmosphericAbsorptionDbPerM, calcNoiseIso9613Upper } from "../engine/noise.js";
import { computeNoiseCell } from "../engine/combine.js";

let failCount = 0;
function check(name, condition, detail) {
  const ok = Boolean(condition);
  if (!ok) failCount++;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}

// 1) Adiv 단독: 거리 2배마다 정확히 20*log10(2) = 6.0206dB
{
  const d1 = calcAdiv(100);
  const d2 = calcAdiv(200);
  const diff = d2 - d1;
  check("Adiv 거리 2배 → 6.02dB", Math.abs(diff - 20 * Math.log10(2)) < 1e-9, `100m→200m 차이=${diff.toFixed(4)}dB`);
}

// 2) 공기 흡수(Aatm 계수): ISO 9613-1과 같은 식(Bass et al. 1995) 공개 검증표 13개 케이스 재확인
{
  const cases = [
    [20, 50, 101.325, 100, 0.294], [20, 50, 101.325, 1000, 4.66], [20, 50, 101.325, 10000, 158.8],
    [20, 70, 101.325, 1000, 4.98], [20, 70, 101.325, 10000, 117.5], [0, 50, 101.325, 1000, 6.83],
    [0, 50, 101.325, 10000, 172.1], [30, 80, 101.325, 1000, 7.41], [30, 80, 101.325, 10000, 80.7],
    [20, 50, 80.0, 1000, 4.62], [20, 5, 101.325, 1000, 26.51], [20, 5, 101.325, 4000, 64.48], [-20, 50, 101.325, 1000, 9.14],
  ];
  let allOk = true;
  for (const [T, RH, p, f, expectedDbPerKm] of cases) {
    const dbPerKm = atmosphericAbsorptionDbPerM(f, T, RH, p) * 1000;
    const errPct = (Math.abs(dbPerKm - expectedDbPerKm) / expectedDbPerKm) * 100;
    if (errPct >= 1.5) allOk = false;
  }
  check("Aatm 공개 검증표 13개 케이스 모두 오차 1.5% 미만", allOk);
}

// 3) 물리 상식: 음원 세기(LW)가 10dB 세지면 결과도 정확히 10dB 세져야 함(선형 가산)
{
  const weather = { windVecFromDeg: 332, wsd10m: 3, tempC: 10, rhPercent: 50 };
  const source = { lat: 37.5203, lon: 127.1268 };
  const receiver = { lat: 37.5203 - 0.005, lon: 127.1268 + 0.004 }; // 풍향 부채꼴 안
  const hour = "2026-11-21T19:00:00+09:00";
  const low = computeNoiseCell({ source: { ...source, lwDb: 100 }, receiver, weather, hour });
  const high = computeNoiseCell({ source: { ...source, lwDb: 110 }, receiver, weather, hour });
  check("LW +10dB → 결과도 +10dB", Math.abs(high.value - low.value - 10) < 1e-9, `${low.value.toFixed(2)} → ${high.value.toFixed(2)}`);
}

// 4) 물리 상식: 거리가 멀수록(같은 풍향선 상) 항상 더 작아져야 함(단조 감소)
{
  const weather = { windVecFromDeg: 332, wsd10m: 3, tempC: 10, rhPercent: 50 };
  const source = { lat: 37.5203, lon: 127.1268, lwDb: 110 };
  const hour = "2026-11-21T19:00:00+09:00";
  const near = computeNoiseCell({ source, receiver: { lat: 37.5203 - 0.003, lon: 127.1268 + 0.0024 }, weather, hour });
  const mid = computeNoiseCell({ source, receiver: { lat: 37.5203 - 0.006, lon: 127.1268 + 0.0048 }, weather, hour });
  const far = computeNoiseCell({ source, receiver: { lat: 37.5203 - 0.012, lon: 127.1268 + 0.0096 }, weather, hour });
  check("거리가 멀수록 값이 단조 감소", near.value > mid.value && mid.value > far.value, `${near.value.toFixed(1)} > ${mid.value.toFixed(1)} > ${far.value.toFixed(1)}`);
}

// 5) 풍향 부채꼴 밖이면 계산 안 함(value:null) — "계산 안 함" vs "0" 구분 확인
{
  const weather = { windVecFromDeg: 332, wsd10m: 3, tempC: 10, rhPercent: 50 };
  const source = { lat: 37.5203, lon: 127.1268, lwDb: 110 };
  // 바람 반대쪽(풍상측)
  const upwind = computeNoiseCell({ source, receiver: { lat: 37.5203 + 0.01, lon: 127.1268 - 0.008 }, weather, hour: "2026-11-21T19:00:00+09:00" });
  check("풍향 부채꼴 밖 → value:null(0 아님)", upwind.value === null, JSON.stringify(upwind.flags));
}

// 6) 실내 공연장 외벽 환산식(LW=Lp,실내−R+10log10(S)−6) 손계산 대조
{
  const { indoorFacadeSourcePowerLevel } = await import("../engine/noise.js");
  const got = indoorFacadeSourcePowerLevel(95, 45, 500);
  const expect = 95 - 45 + 10 * Math.log10(500) - 6;
  check("실내 외벽 환산식 손계산 대조", Math.abs(got - expect) < 1e-9, `${got.toFixed(4)} = ${expect.toFixed(4)}`);
}

console.log(failCount === 0 ? "\n전체 통과 (실패 0)" : `\n실패 ${failCount}건`);
process.exitCode = failCount === 0 ? 0 : 1;
