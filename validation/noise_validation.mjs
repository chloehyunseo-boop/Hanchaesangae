// validation/noise_validation.mjs — 소음 엔진(noise.js, combine.js) 손계산 검증 (11/21, 친구 라인)
// 로드맵 M2 11/17·11/20 완료 기준을 확인해요: "거리 감쇠(Adiv)만 단독 검증 시 거리 2배마다
// −6dB", "공기 흡수", "물리 상식". 실행: node validation/noise_validation.mjs

import { calcAdiv, atmosphericAbsorptionDbPerM, calcNoiseIso9613Upper, timeWeightDb, logSumDb, calcNoiseIso9613UpperOctave } from "../engine/noise.js";
import { windComponentTowardReceiver, overlapMinutesInHour } from "../engine/common.js";
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
  const low = computeNoiseCell({ source: { ...source, lwDb: 100, allowApprox: true }, receiver, weather, hour });
  const high = computeNoiseCell({ source: { ...source, lwDb: 110, allowApprox: true }, receiver, weather, hour });
  check("LW +10dB → 결과도 +10dB", Math.abs(high.value - low.value - 10) < 1e-9, `${low.value.toFixed(2)} → ${high.value.toFixed(2)}`);
}

// 4) 물리 상식: 거리가 멀수록(같은 풍향선 상) 항상 더 작아져야 함(단조 감소)
{
  const weather = { windVecFromDeg: 332, wsd10m: 3, tempC: 10, rhPercent: 50 };
  const source = { lat: 37.5203, lon: 127.1268, lwDb: 110, allowApprox: true };
  const hour = "2026-11-21T19:00:00+09:00";
  const near = computeNoiseCell({ source, receiver: { lat: 37.5203 - 0.003, lon: 127.1268 + 0.0024 }, weather, hour });
  const mid = computeNoiseCell({ source, receiver: { lat: 37.5203 - 0.006, lon: 127.1268 + 0.0048 }, weather, hour });
  const far = computeNoiseCell({ source, receiver: { lat: 37.5203 - 0.012, lon: 127.1268 + 0.0096 }, weather, hour });
  check("거리가 멀수록 값이 단조 감소", near.value > mid.value && mid.value > far.value, `${near.value.toFixed(1)} > ${mid.value.toFixed(1)} > ${far.value.toFixed(1)}`);
}

// 5) 풍향 부채꼴 밖이면 계산 안 함(value:null) — "계산 안 함" vs "0" 구분 확인
{
  const weather = { windVecFromDeg: 332, wsd10m: 3, tempC: 10, rhPercent: 50 };
  const source = { lat: 37.5203, lon: 127.1268, lwDb: 110, allowApprox: true };
  // 바람 반대쪽(풍상측)
  const upwind = computeNoiseCell({ source, receiver: { lat: 37.5203 + 0.01, lon: 127.1268 - 0.008 }, weather, hour: "2026-11-21T19:00:00+09:00" });
  check("풍향 부채꼴 밖 → value:null(0 아님)", upwind.value === null && upwind.flags.includes("풍향부채꼴밖"), JSON.stringify(upwind.flags));
}

// 6) 실내 공연장 외벽 환산식(LW=Lp,실내−R+10log10(S)−6) 손계산 대조
{
  const { indoorFacadeSourcePowerLevel } = await import("../engine/noise.js");
  const got = indoorFacadeSourcePowerLevel(95, 45, 500);
  const expect = 95 - 45 + 10 * Math.log10(500) - 6;
  check("실내 외벽 환산식 손계산 대조", Math.abs(got - expect) < 1e-9, `${got.toFixed(4)} = ${expect.toFixed(4)}`);
}

// 7) 풍향 변환 8방향 단위 테스트 (로드맵 §7: "8방향 단위 테스트. 예: 북서풍이면 음원의
// 남동쪽 수음점이 순풍" — 8개 모두 통과해야 함)
{
  const compass = [0, 45, 90, 135, 180, 225, 270, 315]; // N, NE, E, SE, S, SW, W, NW
  let allOk = true;
  for (const vecFromDeg of compass) {
    const downwindBearing = (vecFromDeg + 180) % 360; // 바람이 불어가는 방향 = 음원→수음점 방위각
    const r = windComponentTowardReceiver(vecFromDeg, downwindBearing);
    const ok = Math.abs(r.diffDeg) < 1e-9 && Math.abs(r.alignment - 1) < 1e-9 && r.withinFan === true;
    if (!ok) allOk = false;
    console.log(`     VEC=${vecFromDeg}° → 정풍 방향 ${downwindBearing}°: diff=${r.diffDeg.toFixed(4)} align=${r.alignment.toFixed(4)} withinFan=${r.withinFan}`);
  }
  check("풍향 변환 8방향 단위 테스트(8개 모두 통과)", allOk);
}

// 8) 시간 가중: 30분 가동 → 약 -3dB (로드맵 예시 그대로)
{
  const w = timeWeightDb(30);
  check("시간 가중 30분 → 약 -3dB", Math.abs(w - 10 * Math.log10(30 / 60)) < 1e-9, `${w.toFixed(4)}dB`);
  check("시간 가중 0분 → null(계산 안 함)", timeWeightDb(0) === null);
  check("시간 가중 60분(꽉 참) → 0dB(보정 없음)", timeWeightDb(60) === 0);
}

// 9) overlapMinutesInHour: 19:30~21:00 공연이 19시~20시 구간과 겹치는 분 = 30분
{
  const minutes = overlapMinutesInHour("2026-11-21T19:30:00+09:00", "2026-11-21T21:00:00+09:00", "2026-11-21T19:00:00+09:00");
  check("공연시간 겹침 계산(19:30 시작 → 19시대엔 30분)", Math.abs(minutes - 30) < 1e-9, `${minutes}분`);
}

// 10) 옥타브 8밴드: 스펙트럼을 "전부 1000Hz에 몰아둔" 경우, 단일주파수 근사와 거의 같아야 함(교차검증)
{
  const common = {
    sourceLat: 37.5203, sourceLon: 127.1268,
    receiverLat: 37.5203 - 0.005, receiverLon: 127.1268 + 0.004,
    windVecFromDeg: 332, lwDb: 110, tempC: 10, rhPercent: 50,
  };
  const flat = calcNoiseIso9613Upper(common);
  // 1000Hz에 전부 몰아주면(다른 밴드는 사실상 무에너지) logSumDb가 1000Hz 밴드값(A가중 0)으로 수렴해야 함
  const spectrumRatiosDb = { 63: -99, 125: -99, 250: -99, 500: -99, 1000: 0, 2000: -99, 4000: -99, 8000: -99 };
  const octave = calcNoiseIso9613UpperOctave({ ...common, spectrumRatiosDb });
  check("옥타브 분해(1000Hz 집중) ≈ 단일주파수 근사", Math.abs(octave.value - flat.value) < 0.01, `${flat.value.toFixed(3)} vs ${octave.value.toFixed(3)}`);

  check("logSumDb: 같은 레벨 2개 합치면 +3.01dB", Math.abs(logSumDb([70, 70]) - 73.0103) < 1e-3);

  // 11/21(이어서): 스펙트럼 없으면 기본은 계산 안 함(로드맵 §2 "옥타브 필수" 규칙),
  // allowApprox:true로 명시해야만 예전처럼 1kHz 근사로 내려감
  const strict = calcNoiseIso9613UpperOctave({ ...common, spectrumRatiosDb: undefined });
  check("스펙트럼 없음(기본) → value:null, '옥타브스펙트럼필수' 플래그", strict.value === null && strict.flags.includes("옥타브스펙트럼필수_모양미확인"));
  const approx = calcNoiseIso9613UpperOctave({ ...common, spectrumRatiosDb: undefined, allowApprox: true });
  check("스펙트럼 없음+allowApprox:true → 1kHz 근사로 계산됨", approx.value !== null && approx.flags.includes("비공식근사_명시요청"));
}

// 11) combine.js 통합: source.time으로 30분만 가동된 공연은 전체시간(60분) 대비 약 3dB 낮게 나와야 함
{
  const weather = { windVecFromDeg: 332, wsd10m: 3, tempC: 10, rhPercent: 50 };
  const receiver = { lat: 37.5203 - 0.005, lon: 127.1268 + 0.004 };
  const full = computeNoiseCell({
    source: { lat: 37.5203, lon: 127.1268, lwDb: 110, allowApprox: true, time: { start: "2026-11-21T19:00:00+09:00", end: "2026-11-21T20:00:00+09:00", 출처: "공단API명시" } },
    receiver, weather, hour: "2026-11-21T19:00:00+09:00",
  });
  const half = computeNoiseCell({
    source: { lat: 37.5203, lon: 127.1268, lwDb: 110, allowApprox: true, time: { start: "2026-11-21T19:30:00+09:00", end: "2026-11-21T20:00:00+09:00", 출처: "공단API명시" } },
    receiver, weather, hour: "2026-11-21T19:00:00+09:00",
  });
  check("combine.js: 30분만 가동 → 전체 가동보다 약 3dB 낮음", Math.abs(full.value - half.value - 3.01) < 0.01, `${full.value.toFixed(2)} vs ${half.value.toFixed(2)}`);

  const notYet = computeNoiseCell({
    source: { lat: 37.5203, lon: 127.1268, lwDb: 110, allowApprox: true, time: { start: "2026-11-21T20:00:00+09:00", end: "2026-11-21T21:00:00+09:00", 출처: "공단API명시" } },
    receiver, weather, hour: "2026-11-21T19:00:00+09:00",
  });
  check("combine.js: 아직 시작 전 공연 → value:null", notYet.value === null, JSON.stringify(notYet.flags));
}

console.log(failCount === 0 ? "\n전체 통과 (실패 0)" : `\n실패 ${failCount}건`);
process.exitCode = failCount === 0 ? 0 : 1;
