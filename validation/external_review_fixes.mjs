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
// 2차 외부 검토 지적(11/22): 밴드마다 0dB를 준다고 "에너지를 7밴드에 균등 배분"하는 게
// 아니에요 — calcConcaweBand의 lwDb는 "그 밴드의 LW"를 직접 받고, 함수 계약상 전체 LW를
// 나누는 게 아니라 각 밴드가 "LW + 상대비율(dB)"을 그대로 받아요. 즉 0dB×7밴드는 7개
// 밴드 전부가 '전체 LW만큼' 독립적으로 소리를 내는 셈이라 실제보다 훨씬 커요. 아래 테스트는
// 이 테스트용 고정값일 뿐이고, 실제 음원 스펙트럼은 반드시 에너지 총합이 LW가 되도록
// (예: 로그합하면 LW로 돌아오는) 밴드별 상대비율을 넣어야 해요.
const FLAT_SPECTRUM = Object.fromEntries(CONCAWE_BANDS_HZ.map((f) => [f, 0]));

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
  // 2차 외부 검토 지적(11/22): 원래 `cell.flags.has`(배열엔 .has가 없어 항상 undefined) 때문에
  // 삼항 연산자 왼쪽이 늘 거짓이 되어 cell.value를 사실상 전혀 검사하지 않는 버그가 있었어요.
  // 검토자가 {value:58, flags:[...]} 같은 반례로 실제로 통과함을 보여줬어요 — 이제 둘 다 확인해요.
  check("combine.js 통합: 빈 스펙트럼 음원은 값에 안 들어감(value:null)", cell.value === null && cell.flags.includes("옥타브스펙트럼필수_모양미확인"));
}

// 12) 2차 외부 검토: combine.js가 실제로 쓰는 500m 정풍 케이스의 정확한 수치 회귀값
{
  const weather = { windVecFromDeg: 0, wsd10m: 2, stability: "D", tempC: 10, rhPercent: 75 };
  const receiver = { lat: BASE.receiverLat, lon: BASE.receiverLon };
  const makeSource = (startIso, endIso) => ({
    lat: BASE.sourceLat, lon: BASE.sourceLon, lwDb: 120,
    groundType: "soft", dSoftM: 500, hs: 1.5,
    spectrumRatiosDb: FLAT_SPECTRUM,
    time: { start: startIso, end: endIso, 출처: "공단API명시" },
  });
  const hour = "2026-11-22T19:00:00+09:00";

  // 아래 세 수치는 2026-11-22 수정 직후 이 코드로 실제 계산한 값을 그대로 고정한
  // 회귀값이에요(외부 검토가 제시한 숫자가 아니라, 이 시점 결과를 기준으로 앞으로의
  // 의도치 않은 변화를 잡기 위한 것 — FLAT_SPECTRUM은 "균등 배분"이 아니라 밴드마다
  // 전체 LW를 독립으로 받는다는 점, 위 주석 참고).
  const r60 = computeNoiseCellConcawe({ stageSources: [makeSource("2026-11-22T19:00:00+09:00", "2026-11-22T20:00:00+09:00")], receiver, weather, hour, concaweData });
  check("60분 가동 500m 회귀값", Math.abs(r60.value - 58.0117) < 0.001, `${r60.value?.toFixed(4)}dB(A)`);

  const r30 = computeNoiseCellConcawe({ stageSources: [makeSource("2026-11-22T19:30:00+09:00", "2026-11-22T20:00:00+09:00")], receiver, weather, hour, concaweData });
  check("30분 가동 500m 회귀값", Math.abs(r30.value - 55.0014) < 0.001, `${r30.value?.toFixed(4)}dB(A)`);

  const rDouble = computeNoiseCellConcawe({
    stageSources: [
      makeSource("2026-11-22T19:00:00+09:00", "2026-11-22T20:00:00+09:00"),
      makeSource("2026-11-22T19:00:00+09:00", "2026-11-22T20:00:00+09:00"),
    ],
    receiver, weather, hour, concaweData,
  });
  check("동일 음원 2개 동시 합산 회귀값", Math.abs(rDouble.value - 61.0220) < 0.001, `${rDouble.value?.toFixed(4)}dB(A)`);
}

// 13) 2차 외부 검토: combine.js 최상위 입력 검증 — leaf 함수가 아니라 실제 메인 지도 경로에서 검사되는지
{
  const okWeather = { windVecFromDeg: 0, wsd10m: 2, stability: "D", tempC: 10, rhPercent: 75 };
  const receiver = { lat: BASE.receiverLat, lon: BASE.receiverLon };
  const source = { lat: BASE.sourceLat, lon: BASE.sourceLon, lwDb: 120, groundType: "soft", dSoftM: 500, hs: 1.5, spectrumRatiosDb: FLAT_SPECTRUM, time: { start: "2026-11-22T19:00:00+09:00", end: "2026-11-22T20:00:00+09:00", 출처: "공단API명시" } };
  const hour = "2026-11-22T19:00:00+09:00";

  const badWsd = computeNoiseCellConcawe({ stageSources: [source], receiver, weather: { ...okWeather, wsd10m: null }, hour, concaweData });
  check("wsd10m=null → 계산불가_풍속(무풍으로 조용히 안 바뀜)", badWsd.value === null && badWsd.flags.includes("계산불가_풍속"));

  const negWsd = computeNoiseCellConcawe({ stageSources: [source], receiver, weather: { ...okWeather, wsd10m: -2 }, hour, concaweData });
  check("wsd10m=-2 → 계산불가_풍속", negWsd.value === null && negWsd.flags.includes("계산불가_풍속"));

  const badWindDeg = computeNoiseCellConcawe({ stageSources: [source], receiver, weather: { ...okWeather, windVecFromDeg: null }, hour, concaweData });
  check("windVecFromDeg=null → 계산불가_풍향", badWindDeg.value === null && badWindDeg.flags.includes("계산불가_풍향"));

  const overWindDeg = computeNoiseCellConcawe({ stageSources: [source], receiver, weather: { ...okWeather, windVecFromDeg: 540 }, hour, concaweData });
  check("windVecFromDeg=540(범위 밖) → 계산불가_풍향(모듈로로 조용히 안 고쳐짐)", overWindDeg.value === null && overWindDeg.flags.includes("계산불가_풍향"));

  const badLon = computeNoiseCellConcawe({ stageSources: [{ ...source, lon: 487 }], receiver, weather: okWeather, hour, concaweData });
  check("음원 경도=487(범위 밖) → 음원좌표미확인+일부음원제외(haversine이 그냥 넘기지 않음)", badLon.value === null && badLon.flags.includes("음원좌표미확인") && badLon.flags.includes("일부음원제외"));

  const badReceiverLon = computeNoiseCellConcawe({ stageSources: [source], receiver: { lat: receiver.lat, lon: 487 }, weather: okWeather, hour, concaweData });
  check("수음점 경도=487(범위 밖) → 계산불가_수음점좌표", badReceiverLon.value === null && badReceiverLon.flags.includes("계산불가_수음점좌표"));
}

// 14) 2차 외부 검토: noiseScenario/grid 오류가 "일단 던지긴 하는지"가 아니라 구체적인 이유로 던지는지
{
  let message = "";
  try {
    computeHourOutputCells({ stageSources: [], generatorSources: [], weather: {}, hour: "2026-11-22T19:00:00+09:00" });
  } catch (e) { message = e.message; }
  check("noiseScenario 생략 → 에러 메시지에 'noiseScenario' 언급", message.includes("noiseScenario"));

  let message2 = "";
  try {
    computeHourOutputCells({ stageSources: [], generatorSources: [], weather: {}, hour: "2026-11-22T19:00:00+09:00", noiseScenario: "concawe", concaweData: {} });
  } catch (e) { message2 = e.message; }
  check("concaweData={}(빈 객체, truthy) → TypeError 아니라 명확한 '필수 키' 에러", message2.includes("필수 키"));

  let message3 = "";
  try {
    generateGridPoints(0);
  } catch (e) { message3 = e.message; }
  check("격자 간격 0 → 에러 메시지에 '0보다 커야' 언급", message3.includes("0보다 커야"));
}

// 15) 2차 외부 검토: 일부 음원만 데이터 문제로 빠졌을 때 "전부 합산"과 구분되는 flag가 붙는지
{
  const weather = { windVecFromDeg: 0, wsd10m: 2, stability: "D", tempC: 10, rhPercent: 75 };
  const receiver = { lat: BASE.receiverLat, lon: BASE.receiverLon };
  const hour = "2026-11-22T19:00:00+09:00";
  const goodSource = { lat: BASE.sourceLat, lon: BASE.sourceLon, lwDb: 120, groundType: "soft", dSoftM: 500, hs: 1.5, spectrumRatiosDb: FLAT_SPECTRUM, time: { start: hour, end: "2026-11-22T20:00:00+09:00", 출처: "공단API명시" } };
  const badSpectrumSource = { ...goodSource, spectrumRatiosDb: {} };

  const fullSum = computeNoiseCellConcawe({ stageSources: [goodSource, goodSource], receiver, weather, hour, concaweData });
  check("전부 합산되면 일부음원제외 flag 없음", !fullSum.flags.includes("일부음원제외"));

  const partialSum = computeNoiseCellConcawe({ stageSources: [goodSource, badSpectrumSource], receiver, weather, hour, concaweData });
  check("일부만 데이터 문제로 빠지면 일부음원제외 flag 붙음(값은 살아있음)", typeof partialSum.value === "number" && partialSum.flags.includes("일부음원제외"));
}

console.log(failCount === 0 ? "\n전체 통과 (실패 0)" : `\n실패 ${failCount}건`);
process.exitCode = failCount === 0 ? 0 : 1;
