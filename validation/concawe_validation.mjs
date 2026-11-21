// validation/concawe_validation.mjs — CONCAWE 전체(K1~K7) 손계산 검증 (11/21, 친구 라인)
// 숫자 출처: docs/CONCAWE_원문정리.md §9(원문 예제 1), §5(범주표). 실행: node validation/concawe_validation.mjs

import fs from "node:fs";
import {
  concaweK1, concaweK2, concaweK3, concaweK4, concaweK5, concaweCategory,
  calcConcaweBand, calcNoiseConcaweHourly, CONCAWE_BANDS_HZ, logSumDb, A_WEIGHT_DB,
} from "../engine/noise.js";

const concaweData = JSON.parse(fs.readFileSync(new URL("../data/concawe_4_81.json", import.meta.url), "utf8"));

let failCount = 0;
function check(name, condition, detail) {
  const ok = Boolean(condition);
  if (!ok) failCount++;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}

// 원문 예제 1(§9): d=500m, 10℃·75%, 음원→수음점 2m/s, 안정도 D(→범주5), hs=hr=1.5m
const EX = { d: 500, tempC: 10, rhPercent: 75, v: 2, stability: "D", hs: 1.5, hr: 1.5 };
const EXPECT_K1 = 64.97;
const EXPECT_K2 = { 63: 0.05, 125: 0.1, 250: 0.35, 500: 0.85, 1000: 1.5, 2000: 3.2, 4000: 9.4 };
const EXPECT_K3 = { 63: -1.35, 125: 4.91, 250: 10.01, 500: 8.45, 1000: 4.55, 2000: 2.45, 4000: 1.18 };
const EXPECT_K4 = { 63: -0.91, 125: -2.38, 250: -3.94, 500: -3.94, 1000: -5.02, 2000: -3.07, 4000: -4.15 };

check("범주 판정(안정도 D, v=+2 → 범주 5)", concaweCategory(EX.stability, EX.v) === 5);
check("K1(500m) ≈ 64.97dB(원문 예제)", Math.abs(concaweK1(EX.d) - EXPECT_K1) < 0.01);

let bandsOk = true;
for (const f of CONCAWE_BANDS_HZ) {
  const { k2 } = concaweK2(concaweData, f, EX.tempC, EX.rhPercent, EX.d);
  const k3 = concaweK3(concaweData, f, "soft", EX.d);
  const k4 = concaweK4(concaweData, f, 5, EX.d);
  const k5 = concaweK5(k3, k4, EX.hs, EX.hr, EX.d);
  if (Math.abs(k2 - EXPECT_K2[f]) > 0.01) bandsOk = false;
  if (Math.abs(k3 - EXPECT_K3[f]) > 0.02) bandsOk = false;
  if (Math.abs(k4 - EXPECT_K4[f]) > 0.02) bandsOk = false;
  if (k5 !== 0) bandsOk = false; // hs=1.5<=2m → 항상 0
}
check("원문 예제 1: K1·K2·K3·K4·K5(=0) 7밴드 전부 일치", bandsOk);

// 범주 경계값 — "4에 가까운 쪽" 규칙(추천안 7번) 확인
check("A,B열 v=-3.0 → 범주2(경계, 4쪽)", concaweCategory("A", -3.0) === 2);
check("A,B열 v=-0.5 → 범주3", concaweCategory("A", -0.5) === 3);
check("A,B열 v=+0.5 → 범주4", concaweCategory("B", 0.5) === 4);
check("A,B열 v=+3.0 → 범주4(경계, 4쪽)", concaweCategory("B", 3.0) === 4);
check("C,D,E열 v=-0.5 → 범주4", concaweCategory("D", -0.5) === 4);
check("C,D,E열 v=+0.5 → 범주4", concaweCategory("D", 0.5) === 4);
check("C,D,E열 v=+3.0 → 범주5(경계, 4쪽)", concaweCategory("D", 3.0) === 5);
check("F,G열 v=-0.5 → 범주4(경계, 4쪽)", concaweCategory("F", -0.5) === 4);
check("F,G열 v=+0.5 → 범주5", concaweCategory("G", 0.5) === 5);
check("F,G열 v=+5.0(원문 표 밖) → 범주6(추천안 8번)", concaweCategory("F", 5.0) === 6);
check("범주4 ⇒ K4=0", concaweK4(concaweData, 1000, 4, 500) === 0);

// K2 범위 밖 → ISO 9613-1 대체 (추천안 1번)
{
  const inRange = concaweK2(concaweData, 1000, 10, 75, 500);
  const outOfRangeTemp = concaweK2(concaweData, 1000, -10, 75, 500); // 0℃ 미만
  const outOfRangeRh = concaweK2(concaweData, 1000, 10, 30, 500); // 55% 미만
  check("K2 범위 안은 플래그 없음", inRange.flags.length === 0);
  check("K2 범위 밖(기온) → ISO 대체 플래그", outOfRangeTemp.flags.includes("K2범위밖_ISO9613대체") && Number.isFinite(outOfRangeTemp.k2));
  check("K2 범위 밖(습도) → ISO 대체 플래그", outOfRangeRh.flags.includes("K2범위밖_ISO9613대체") && Number.isFinite(outOfRangeRh.k2));
}

// K2 보간: 표에 없는 온도·습도 사이 값(12℃, 77%)이 이웃 두 값 사이에 있는지
{
  const lo = concaweK2(concaweData, 1000, 10, 75, 500).k2;
  const hi = concaweK2(concaweData, 1000, 15, 80, 500).k2;
  const mid = concaweK2(concaweData, 1000, 12, 77, 500).k2;
  check("K2 보간값이 이웃 표값 사이에 있음", mid > Math.min(lo, hi) - 0.01 && mid < Math.max(lo, hi) + 0.01, `${lo.toFixed(3)} ~ ${mid.toFixed(3)} ~ ${hi.toFixed(3)}`);
}

// 0℃·4000Hz·RH65% 인쇄 오류 보정(25.7→35.7) 확인
{
  const { k2 } = concaweK2(concaweData, 4000, 0, 65, 1000); // d=1000m → ×1.0
  check("0℃·4000Hz·RH65% 보정값 35.7 dB/km 적용", Math.abs(k2 - 35.7) < 0.01, `${k2}`);
}

// d<100m 계산 안 함 / d>2000m 외삽 고정
{
  const near = calcConcaweBand({ concaweData, freqHz: 1000, lwDb: 110, d: 50, groundType: "soft", dSoftM: 50, tempC: 10, rhPercent: 75, stability: "D", v: 2, hs: 1.5 });
  check("100m 미만 → value:null", near.value === null && near.flags.includes("근거리100m미만_계산안함"));
  const far2000 = calcConcaweBand({ concaweData, freqHz: 1000, lwDb: 110, d: 2000, groundType: "soft", dSoftM: 2000, tempC: 10, rhPercent: 75, stability: "D", v: 2, hs: 1.5 });
  const far3000 = calcConcaweBand({ concaweData, freqHz: 1000, lwDb: 110, d: 3000, groundType: "soft", dSoftM: 2000, tempC: 10, rhPercent: 75, stability: "D", v: 2, hs: 1.5 });
  check("2000m 초과 → 2000m 값으로 고정(외삽 플래그)", far3000.value === far2000.value && far3000.flags.includes("거리2000m초과_외삽"));
}

// calcNoiseConcaweHourly 통합: 스펙트럼 없으면 계산 안 함(ISO 쪽과 달리 폴백 없음 — 로드맵 규칙)
{
  const common = {
    concaweData, lwDb: 118,
    sourceLat: 37.5203, sourceLon: 127.1268,
    receiverLat: 37.5203 - 0.0045, receiverLon: 127.1268,
    windVecFromDeg: 0, wsd10m: 2, stability: "D",
    groundType: "soft", dSoftM: 500, tempC: 10, rhPercent: 75, hs: 1.5,
  };
  const noSpectrum = calcNoiseConcaweHourly(common);
  check("스펙트럼 없으면 value:null(단일주파수 폴백 금지)", noSpectrum.value === null && noSpectrum.flags.includes("옥타브스펙트럼필수_모양미확인"));

  // 에너지를 1000Hz 밴드에 몰아두면, 그 밴드 하나만 계산한 값(+A가중 0)과 같아야 함
  const spectrumRatiosDb = { 63: -99, 125: -99, 250: -99, 500: -99, 1000: 0, 2000: -99, 4000: -99 };
  const withSpectrum = calcNoiseConcaweHourly({ ...common, spectrumRatiosDb });
  const bandOnly = calcConcaweBand({ concaweData, freqHz: 1000, lwDb: 118, d: 500, groundType: "soft", dSoftM: 500, tempC: 10, rhPercent: 75, stability: "D", v: 2, hs: 1.5 });
  check("1000Hz 집중 스펙트럼 ≈ 그 밴드 단독 계산(A가중 0)", Math.abs(withSpectrum.value - bandOnly.value) < 0.01, `${withSpectrum.value?.toFixed(3)} vs ${bandOnly.value?.toFixed(3)}`);
}

console.log(failCount === 0 ? "\n전체 통과 (실패 0)" : `\n실패 ${failCount}건`);
process.exitCode = failCount === 0 ? 0 : 1;
