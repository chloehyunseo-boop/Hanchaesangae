// validation/external_review_fixes.mjs — 외부 LLM 검토(2026-11-22)에서 찾은 버그들의
// 재현·수정 확인 테스트. 각 항목은 검토 보고서가 제시한 입력을 그대로 써요.
// 실행: node validation/external_review_fixes.mjs

import fs from "node:fs";
import {
  calcNoiseConcaweHourly, calcConcaweBand, indoorFacadeSourcePowerLevel,
  stageActiveMinutes, validateNoiseInput, validateSpectrum, CONCAWE_BANDS_HZ,
} from "../engine/noise.js";
import { computeNoiseCellConcawe, computeHourOutputCells, generateGridPoints } from "../engine/combine.js";

const concaweData = JSON.parse(fs.readFileSync(new URL("../data/concawe_4_81.json", import.meta.url), "utf8"));

let failCount = 0;
function check(name, condition, detail) {
  const ok = Boolean(condition);
  if (!ok) failCount++;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}

const BASE = {
  concaweData, lwDb: 120,
  sourceLat: 37.5203, sourceLon: 127.1268,
  receiverLat: 37.5203 - 0.0045, receiverLon: 127.1268, // 약 500m, 정풍
  windVecFromDeg: 0, wsd10m: 2, stability: "D",
  groundType: "soft", dSoftM: 500, tempC: 10, rhPercent: 75, hs: 1.5,
};
const FLAT_SPECTRUM = Object.fromEntries(CONCAWE_BANDS_HZ.map((f) => [f, 0])); // 7밴드에 같은 에너지 배분(근사)

// 1) 빈 스펙트럼 객체 {} → 밴드마다 전체 파워가 중복 배정되던 버그. 이제 계산 자체를 안 함(null).
{
  const r = calcNoiseConcaweHourly({ ...BASE, spectrumRatiosDb: {} });
  check("빈 스펙트럼 객체 → value:null(에너지 중복배정 안 됨)", r.value === null && r.flags.includes("옥타브스펙트럼필수_모양미확인"));
}

// 1-2) 밴드 일부만 빠진 스펙트럼도 막혀야 함
{
  const partial = { ...FLAT_SPECTRUM };
  delete partial[1000];
  const r = calcNoiseConcaweHourly({ ...BASE, spectrumRatiosDb: partial });
  check("밴드 일부 누락 스펙트럼 → value:null", r.value === null);
}

// 2) 연질 지면 구간 길이가 아주 짧으면(1m) K3가 폭주하던 버그. 이제 100m 미만은 계산 안 함.
{
  const band = calcConcaweBand({ concaweData, freqHz: 1000, lwDb: 120, d: 500, groundType: "soft", dSoftM: 1, tempC: 10, rhPercent: 75, stability: "D", v: 2, hs: 1.5 });
  check("연질구간 1m → value:null(K3 폭주 안 함)", band.value === null && band.flags.includes("연질구간100m미만_계산불가"));
}

// 3) 시작 시각이 파싱 안 되는 문자열이면 "한 시간 내내 가동"으로 둔갑하던 버그.
{
  const r = stageActiveMinutes({ time: { start: "이상한문자열", end: null, 출처: "공단API명시" } }, "2026-11-22T19:00:00+09:00");
  check("시작 시각 파싱 실패 → activeMinutes:0(가동 아님)", r.activeMinutes === 0 && r.flags.includes("시간파싱오류"));
}

// 4) 음원과 수음점이 같은 좌표(거리 0) → 로그값이 무한대로 튀던 위험. 이제 계산불가로 막힘.
{
  const bad = validateNoiseInput({ sourceLat: 37.5, sourceLon: 127.1, receiverLat: 37.5, receiverLon: 127.1 });
  check("음원=수음점(거리 0) → 검증 실패 문구 반환", typeof bad === "string");
}

// 5) 지면 유형 오타(예: "Soft")가 조용히 "soft"로 흘러가던 버그.
{
  const band = calcConcaweBand({ concaweData, freqHz: 1000, lwDb: 120, d: 500, groundType: "Soft", dSoftM: 500, tempC: 10, rhPercent: 75, stability: "D", v: 2, hs: 1.5 });
  check("지면 유형 오타('Soft') → value:null", band.value === null && band.flags.includes("지면유형미확인"));
}

// 6) 벽 차음량 R=null → 차음 0(벽이 소리를 안 막음)으로 조용히 계산되던 버그.
{
  const lw = indoorFacadeSourcePowerLevel(95, null, 500);
  check("벽 차음량 R=null → NaN 반환(음원세기미확인으로 이어짐)", Number.isNaN(lw));
}

// 7) computeHourOutputCells가 noiseScenario 없이 호출되면 조용히 ISO로 빠지던 문제 → 이제 에러.
{
  let threw = false;
  try {
    computeHourOutputCells({ stageSources: [], generatorSources: [], weather: {}, hour: "2026-11-22T19:00:00+09:00" });
  } catch (e) {
    threw = true;
  }
  check("noiseScenario 생략 → 에러(조용히 ISO로 안 바뀜)", threw);
}

// 8) generateGridPoints에 0 간격을 주면 무한 반복할 위험 → 이제 에러.
{
  let threw = false;
  try {
    generateGridPoints(0);
  } catch (e) {
    threw = true;
  }
  check("격자 간격 0 → 에러(무한반복 방지)", threw);
}

// 9) 풍향 결측(NaN)이 모든 비교를 통과해 조용히 범주 6이 되던 문제.
{
  const band = calcConcaweBand({ concaweData, freqHz: 1000, lwDb: 120, d: 500, groundType: "soft", dSoftM: 500, tempC: 10, rhPercent: 75, stability: "D", v: NaN, hs: 1.5 });
  check("벡터풍속 v=NaN → value:null(엉뚱한 범주로 안 빠짐)", band.value === null && band.flags.includes("계산불가"));
}

// 10) 정상 입력(검토 보고서의 "비교 기준" 케이스)은 여전히 정상적으로 계산돼야 함 — 회귀 확인
{
  const r = calcNoiseConcaweHourly({ ...BASE, spectrumRatiosDb: FLAT_SPECTRUM });
  check("정상 입력(7밴드 균등 배분)은 그대로 계산됨", typeof r.value === "number" && Number.isFinite(r.value), `${r.value?.toFixed(2)}dB(A)`);
}

// 11) combine.js의 computeNoiseCellConcawe 경로에서도 빈 스펙트럼이 막히는지 확인(통합 테스트)
{
  const weather = { windVecFromDeg: 0, wsd10m: 2, stability: "D", tempC: 10, rhPercent: 75 };
  const receiver = { lat: BASE.receiverLat, lon: BASE.receiverLon };
  const hour = "2026-11-22T19:00:00+09:00";
  const source = { lat: BASE.sourceLat, lon: BASE.sourceLon, lwDb: 120, groundType: "soft", dSoftM: 500, hs: 1.5, spectrumRatiosDb: {}, time: { start: hour, end: "2026-11-22T20:00:00+09:00", 출처: "공단API명시" } };
  const cell = computeNoiseCellConcawe({ stageSources: [source], receiver, weather, hour, concaweData });
  check("combine.js 통합: 빈 스펙트럼 음원은 값에 안 들어감(value:null)", cell.value === null && cell.flags.has ? true : cell.flags.includes("옥타브스펙트럼필수_모양미확인"));
}

console.log(failCount === 0 ? "\n전체 통과 (실패 0)" : `\n실패 ${failCount}건`);
process.exitCode = failCount === 0 ? 0 : 1;
