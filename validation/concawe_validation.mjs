// validation/concawe_validation.mjs — CONCAWE 전체(K1~K7) 손계산 검증 (11/21, 친구 라인)
// 숫자 출처: docs/CONCAWE_원문정리.md §9(원문 예제 1), §5(범주표). 실행: node validation/concawe_validation.mjs

import fs from "node:fs";
import {
  concaweK1, concaweK2, concaweK3, concaweK4, concaweK5, concaweCategory,
  calcConcaweBand, calcNoiseConcaweHourly, lwFromTargetDb, lwFromTargetDbConcawe, CONCAWE_BANDS_HZ, logSumDb, A_WEIGHT_DB,
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

// 4차 외부 검토 지적(11/22): "bandsOk = true로 시작, 틀리면 false로 떨어뜨림" 패턴은 diff가
// NaN이면 "diff > 임계값" 비교가 항상 false가 돼서 절대 안 떨어져요(NaN은 모든 비교에서
// false) — 계산이 NaN으로 깨져도 이 테스트가 "일치"로 통과하던 버그. 유한수인지부터 확인해요.
let bandsOk = true;
for (const f of CONCAWE_BANDS_HZ) {
  const { k2 } = concaweK2(concaweData, f, EX.tempC, EX.rhPercent, EX.d);
  const k3 = concaweK3(concaweData, f, "soft", EX.d);
  const k4 = concaweK4(concaweData, f, 5, EX.d);
  const k5 = concaweK5(k3, k4, EX.hs, EX.hr, EX.d);
  if (![k2, k3, k4, k5].every(Number.isFinite)) bandsOk = false;
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
  // 5차 외부 검토 지적(11/22, 하린): K3·K4·K5(원문 다항식, 100~2000m에서만 검증됨)만
  // 2000m로 고정하고, K1(거리감쇠)·K2(공기흡수)는 실제 거리를 그대로 써야 해요 — 전에는
  // K1·K2까지 고정해서 2000m 밖에서 소리가 전혀 안 줄어드는(2km·4km 똑같이 30.89dB(A))
  // 버그가 있었어요. 이제 2000m 넘어도 계속 줄어드는지, 플래그는 그대로 붙는지 확인해요.
  const far2000 = calcConcaweBand({ concaweData, freqHz: 1000, lwDb: 110, d: 2000, groundType: "soft", dSoftM: 2000, tempC: 10, rhPercent: 75, stability: "D", v: 2, hs: 1.5 });
  const far3000 = calcConcaweBand({ concaweData, freqHz: 1000, lwDb: 110, d: 3000, groundType: "soft", dSoftM: 2000, tempC: 10, rhPercent: 75, stability: "D", v: 2, hs: 1.5 });
  const far4000 = calcConcaweBand({ concaweData, freqHz: 1000, lwDb: 110, d: 4000, groundType: "soft", dSoftM: 2000, tempC: 10, rhPercent: 75, stability: "D", v: 2, hs: 1.5 });
  check(
    "2000m 초과해도 K1·K2는 실제 거리로 계속 줄어듦(외삽 플래그는 그대로)",
    far3000.value < far2000.value && far4000.value < far3000.value && far3000.flags.includes("거리2000m초과_외삽") && far4000.flags.includes("거리2000m초과_외삽"),
    `2000m=${far2000.value?.toFixed(2)} > 3000m=${far3000.value?.toFixed(2)} > 4000m=${far4000.value?.toFixed(2)}`,
  );
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

// lwFromTargetDbConcawe — 11/24 외부 검토 지적(docs/외부검토_1122_최종_분류.md): 기존
// lwFromTargetDb(ISO 역산)로 구한 LW를 CONCAWE로 다시 계산하면 목표보다 낮게 나오는 걸
// 재현하고, 새 함수로는 왕복이 정확히 맞는지 확인해요.
{
  const spectrumRatiosDb = Object.fromEntries(CONCAWE_BANDS_HZ.map((f) => [f, -10 * Math.log10(7)]));
  const common = {
    concaweData, spectrumRatiosDb,
    sourceLat: 37.5203, sourceLon: 127.1268,
    receiverLat: 37.5203 - 0.0054, receiverLon: 127.1268, // 약 600m 남쪽
    windVecFromDeg: 0, wsd10m: 2, stability: "D", // 음원→수음점 정풍
    groundType: "soft", dSoftM: 500, tempC: 10, rhPercent: 75, hs: 1.5,
  };

  // 재현: ISO 역산 LW를 CONCAWE에 넣으면 목표(65)보다 낮게 나와요(외부 검토가 실측한
  // 65→58과 같은 종류의 과소추정 — 거리·스펙트럼이 달라 숫자 자체는 다를 수 있어요).
  const isoLw = lwFromTargetDb({
    sourceLat: common.sourceLat, sourceLon: common.sourceLon,
    measureLat: common.receiverLat, measureLon: common.receiverLon,
    targetDb: 65, tempC: common.tempC, rhPercent: common.rhPercent,
  });
  const concaweWithIsoLw = calcNoiseConcaweHourly({ ...common, lwDb: isoLw.lwDb });
  check(
    "재현: ISO 역산 LW를 CONCAWE로 계산하면 목표(65)보다 낮게 나옴(엔진이 달라서 생기는 과소추정)",
    concaweWithIsoLw.value !== null && concaweWithIsoLw.value < 65,
    `ISO역산 LW=${isoLw.lwDb.toFixed(2)} → CONCAWE=${concaweWithIsoLw.value?.toFixed(2)}dB(A)`,
  );

  // 고침: 같은 모델(CONCAWE)로 역산하면 왕복이 정확히 맞아요(선형 구조 — 반복 계산 불필요).
  const targetDb = 65;
  const result = lwFromTargetDbConcawe({ targetDb, ...common });
  const roundTrip = calcNoiseConcaweHourly({ ...common, lwDb: result.lwDb });
  check(
    "CONCAWE 역산 왕복: 65 목표 → 역산 LW → 같은 조건으로 재계산하면 65.0000",
    result.lwDb !== null && Math.abs(roundTrip.value - targetDb) < 0.0001,
    `역산 LW=${result.lwDb?.toFixed(4)} → 재계산=${roundTrip.value?.toFixed(4)}dB(A)`,
  );

  // 다른 거리·날씨에서도 똑같이 왕복이 맞는지(선형 가정이 특정 조건에서만 우연히 맞는 게 아닌지)
  const common2 = { ...common, receiverLat: common.sourceLat - 0.009, wsd10m: 5, stability: "F", tempC: 25, rhPercent: 40 };
  const result2 = lwFromTargetDbConcawe({ targetDb: 55, ...common2 });
  const roundTrip2 = calcNoiseConcaweHourly({ ...common2, lwDb: result2.lwDb });
  check(
    "다른 거리·풍속·안정도·기온·습도에서도 왕복 정확 (55 목표)",
    result2.lwDb !== null && Math.abs(roundTrip2.value - 55) < 0.0001,
    `역산 LW=${result2.lwDb?.toFixed(4)} → 재계산=${roundTrip2.value?.toFixed(4)}dB(A)`,
  );

  // 계산 불가 조건(100m 미만)은 조용히 숫자를 내지 않고 명확히 실패로 알려줘요.
  const tooClose = lwFromTargetDbConcawe({ targetDb: 65, ...common, receiverLat: common.sourceLat - 0.0003 });
  check("100m 미만이면 역산도 계산 불가(null)", tooClose.lwDb === null && tooClose.flags.includes("근거리100m미만_계산안함"));
}

console.log(failCount === 0 ? "\n전체 통과 (실패 0)" : `\n실패 ${failCount}건`);
process.exitCode = failCount === 0 ? 0 : 1;
