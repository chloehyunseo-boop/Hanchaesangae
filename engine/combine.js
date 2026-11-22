// engine/combine.js — 엔진 연결 (친구 라인, 11/19 작성, 11/21 plume.js 동결에 맞춰 수정)
// 소음(noise.js)·배출가스(plume.js) 두 엔진을 한 시각·한 격자에 대해 돌려서
// engine/common.js의 OutputCell[] 모양으로 합쳐요. 계산 자체는 두 엔진이 하고,
// 여기는 "격자 만들기 + 둘을 같은 모양으로 합치기"만 해요(로드맵 M2 11/19).
//
// 소음은 11/21 결정대로 ISO 9613-2 "상한" 시나리오(거리 감쇠+공기 흡수+무대 지향성+바람
// 부채꼴, 지면 효과 제외 — noise.js 상단 주석 참고)로 dB를 내요. 다만 음원 세기(LW)가
// 아직 확정 안 된 무대는 source.lwDb/source.indoor를 안 넣으면 value:null로 빠져요.
// 배출가스는 plume.js의 calcExhaustAtReceiver()로 실제 ppm 값을 내요 — 수음점마다
// 그 시각에 가동 중인 발전차를 전부 모아 한 번만 불러요(합산·풍향 부채꼴·ARM2는
// 그 함수 안에서 처리, 11/21 하린 지시).
//
// 좌표는 아직 EPSG:5186(미터)이 아니라 위경도 그대로 둬요(common.js 3.5절과 같은 이유,
// OutputCell.x/y 주석도 11/21에 맞춰 고쳤어요).

import { CALC_GRID, mapDisplayFor } from "./common.js";
import {
  calcNoiseIso9613UpperOctave, indoorFacadeSourcePowerLevel, classifyNoiseLevel,
  stageActiveMinutes, timeWeightDb, calcConcaweBand, CONCAWE_BANDS_HZ, logSumDb, A_WEIGHT_DB,
  sourceReceiverGeometry, validateSpectrum,
} from "./noise.js";

const finite = (v) => typeof v === "number" && Number.isFinite(v);
import { calcExhaustAtReceiver, classifyExhaustLevel } from "./plume.js";

const DEG_PER_M_LAT = 1 / 111320;

/**
 * CALC_GRID.bounds 안을 cellSizeM 간격의 격자점으로 채워요(위경도 근사).
 * @param {number} [cellSizeM]
 * @returns {{lat: number, lon: number}[]}
 */
export function generateGridPoints(cellSizeM = CALC_GRID.cellSizeM) {
  if (!(cellSizeM > 0)) throw new Error(`격자 간격은 0보다 커야 해요(무한 반복 방지, 외부 검토 지적): ${cellSizeM}`);
  const { minLat, maxLat, minLon, maxLon } = CALC_GRID.bounds;
  const midLat = (minLat + maxLat) / 2;
  const latStep = cellSizeM * DEG_PER_M_LAT;
  const lonStep = cellSizeM * DEG_PER_M_LAT / Math.cos((midLat * Math.PI) / 180);
  const points = [];
  for (let lat = minLat; lat <= maxLat; lat += latStep) {
    for (let lon = minLon; lon <= maxLon; lon += lonStep) {
      points.push({ lat, lon });
    }
  }
  return points;
}

/**
 * 발전차 하나가 그 시각에 가동 중인지 — 연결된 공연 시작 2시간 전부터 종료까지예요.
 * 시간 출처가 "미확인"이거나 시작 시각이 없으면 아예 빼요(하린 11/21 지시 2번).
 * @param {{time?: {start: string|null, end: string|null, 출처: string}}} generator
 * @param {string} hourIso
 * @returns {boolean}
 */
export function isGeneratorActiveAtHour(generator, hourIso) {
  const time = generator?.time;
  if (!time || time.출처 === "미확인" || !time.start) return false;
  const hourMs = new Date(hourIso).getTime();
  const activeFromMs = new Date(time.start).getTime() - 2 * 3600 * 1000;
  if (hourMs < activeFromMs) return false;
  if (time.end) {
    const endMs = new Date(time.end).getTime();
    if (hourMs >= endMs) return false;
  }
  return true;
}

/**
 * 한 수음점의 배출가스 OutputCell을 만들어요. 그 시각에 가동 중인 발전차를 전부 모아
 * plume.js의 calcExhaustAtReceiver를 한 번만 불러요(발전차별로 따로 안 부름 — 합산·풍향
 * 부채꼴·ARM2를 그 함수 안에서 다 처리해요. 하린 11/21 지시 1번).
 * @param {{ generators: any[], receiver: {lat:number, lon:number}, weather: {stability, wsd10m, windVecFromDeg, tmp?: number|null}, hour: string, 가정?: "기본추정"|"기존입력가정"|"연기상승제외"|"전량NO2" }} p
 * @returns {import("./common.js").OutputCell}
 */
export function computeExhaustCell({ generators, receiver, weather, hour, 가정 = "기본추정" }) {
  const activeGenerators = generators.filter((g) => isGeneratorActiveAtHour(g, hour));
  const baseCell = { x: receiver.lon, y: receiver.lat, hour, layer: "exhaust" };
  if (activeGenerators.length === 0) {
    return { ...baseCell, value: null, level: null, flags: ["가동중발전차없음"], scenario: `가우시안플룸_ISC3도시형확산계수_풍향부채꼴최대_${가정}` };
  }
  const result = calcExhaustAtReceiver({
    generators: activeGenerators,
    receiverLat: receiver.lat,
    receiverLon: receiver.lon,
    stability: weather.stability,
    wsd10m: weather.wsd10m,
    windVecFromDeg: weather.windVecFromDeg,
    가정,
    // 기상청 TMP. 없으면 undefined/null 그대로 — calcExhaustAtReceiver가 null을 undefined로
    // 받아들이고, 기온 없음은 연기 상승을 빼는 쪽으로 처리해요(하린 11/21 지시 3번).
    대기온도_C: weather.tmp,
  });
  return {
    ...baseCell,
    value: result.value,
    level: classifyExhaustLevel(result.value),
    flags: result.flags,
    scenario: result.scenario,
  };
}

/**
 * 무대 음원 하나 × 수음점 하나의 소음 OutputCell을 만들어요(ISO 9613-2 **상한 추정, 공단
 * 화면 비교용** — 로드맵 §2 표. 시민·공단 메인 지도는 computeNoiseCellConcawe()를 써요).
 * 실내 공연장은 source.indoor={lpIndoorDb, R, S}를 주면 indoorFacadeSourcePowerLevel로
 * LW를 구해요. 실외 무대나 아직 LW를 모르는 음원은 source.lwDb를 직접 주거나, 둘 다
 * 없으면 value:null("음원세기미확인")로 빠져요 — 지어낸 숫자를 넣지 않아요.
 * source.time이 있으면 그 시간 중 실제로 가동된 분만큼 에너지 가중(LAeq,1h)을 더해요
 * (30분만 가동 → 약 −3dB, 로드맵 2번 공통 조건·11/21 추가).
 * @returns {import("./common.js").OutputCell}
 */
export function computeNoiseCell({ source, receiver, weather, hour }) {
  const { activeMinutes, flags: timeFlags } = stageActiveMinutes(source, hour);
  if (activeMinutes <= 0) {
    return { x: receiver.lon, y: receiver.lat, hour, layer: "noise", value: null, level: null, flags: [...timeFlags, "지면효과미적용"], scenario: "ISO9613-2_상한추정_지면효과미적용" };
  }
  const lwDb = source.indoor
    ? indoorFacadeSourcePowerLevel(source.indoor.lpIndoorDb, source.indoor.R, source.indoor.S)
    : source.lwDb;
  const result = calcNoiseIso9613UpperOctave({
    sourceLat: source.lat,
    sourceLon: source.lon,
    receiverLat: receiver.lat,
    receiverLon: receiver.lon,
    windVecFromDeg: weather.windVecFromDeg,
    lwDb,
    tempC: weather.tempC,
    rhPercent: weather.rhPercent,
    spectrumRatiosDb: source.spectrumRatiosDb,
    allowApprox: source.allowApprox === true, // 기본 false — 스펙트럼 없으면 계산 안 함(로드맵 §2 규칙)
  });
  let value = result.value;
  const flags = [...timeFlags, ...result.flags];
  if (value !== null) {
    const weight = timeWeightDb(activeMinutes);
    value += weight;
    if (activeMinutes < 60) flags.push(`시간가중_${Math.round(activeMinutes)}분`);
  }
  return {
    x: receiver.lon,
    y: receiver.lat,
    hour,
    layer: "noise",
    value,
    level: classifyNoiseLevel(value),
    flags,
    scenario: result.scenario,
  };
}

/**
 * 수음점 하나의 소음 OutputCell을 CONCAWE 전체(K1~K7)로 계산해요 — **시민·공단 메인
 * 지도**(로드맵 §2 표, 11/21에 ISO9613과 역할이 바뀐 걸 확인함). 동시에 여러 공연이
 * 있으면 로드맵 계산 순서(①시간가중 → ②같은 밴드 음원 합산 → ③A가중 → ④밴드 합산)
 * 그대로, 밴드마다 활성 음원들을 먼저 에너지 합산한 뒤 A가중·밴드합을 해요.
 * @param {{ stageSources: any[], receiver: {lat:number, lon:number}, weather: { windVecFromDeg: number,
 *   wsd10m: number, stability: string, tempC: number, rhPercent: number }, hour: string, concaweData: object }} p
 *   각 stageSources 항목은 lat/lon/time 외에 lwDb(또는 indoor), spectrumRatiosDb(필수 — 없으면
 *   그 음원은 '옥타브스펙트럼필수_모양미확인'으로 빠짐), groundType("hard"|"soft"), dSoftM, hs(음원 높이), hr?.
 * @returns {import("./common.js").OutputCell}
 */
export function computeNoiseCellConcawe({ stageSources, receiver, weather, hour, concaweData }) {
  const scenario = "CONCAWE_전체_시간별추정";
  const baseCell = { x: receiver.lon, y: receiver.lat, hour, layer: "noise" };

  // 2차 외부 검토 지적(11/22): 이 함수가 geometry·v를 raw weather/receiver로 직접 계산해서
  // noise.js의 validateNoiseInput을 전혀 거치지 않고 있었어요(leaf 함수만 검증되고 실제
  // 메인 지도가 부르는 이 함수는 뚫려 있던 구멍). null*숫자=0으로 조용히 무풍 처리되거나,
  // 범위 밖 각도가 모듈로 연산을 그냥 통과하는 일을 막기 위해 공통 입력을 맨 앞에서 한 번에
  // 검사해요 — 하나라도 틀리면 셀 전체를 계산 안 함(null)으로 둬요.
  if (!finite(receiver.lat) || receiver.lat < -90 || receiver.lat > 90) return { ...baseCell, value: null, level: null, flags: ["계산불가_수음점좌표"], scenario };
  if (!finite(receiver.lon) || receiver.lon < -180 || receiver.lon > 180) return { ...baseCell, value: null, level: null, flags: ["계산불가_수음점좌표"], scenario };
  if (!finite(weather.wsd10m) || weather.wsd10m < 0) return { ...baseCell, value: null, level: null, flags: ["계산불가_풍속"], scenario };
  if (!finite(weather.windVecFromDeg) || weather.windVecFromDeg < 0 || weather.windVecFromDeg > 360) return { ...baseCell, value: null, level: null, flags: ["계산불가_풍향"], scenario };
  if (!finite(weather.tempC) || weather.tempC < -50 || weather.tempC > 60) return { ...baseCell, value: null, level: null, flags: ["계산불가_기온"], scenario };
  if (!finite(weather.rhPercent) || weather.rhPercent < 0 || weather.rhPercent > 100) return { ...baseCell, value: null, level: null, flags: ["계산불가_습도"], scenario };

  const allFlags = new Set();
  const perBandLevels = Object.fromEntries(CONCAWE_BANDS_HZ.map((f) => [f, []]));
  let anyActive = false;
  let excludedCount = 0; // 가동은 했는데 데이터 문제로 합산에서 빠진 음원 수(부분 합계 표시, 외부 검토 지적)

  for (const source of stageSources) {
    const { activeMinutes, flags: timeFlags } = stageActiveMinutes(source, hour);
    timeFlags.forEach((f) => allFlags.add(f));
    if (activeMinutes <= 0) continue;
    anyActive = true;

    if (!finite(source.lat) || source.lat < -90 || source.lat > 90 || !finite(source.lon) || source.lon < -180 || source.lon > 180) {
      allFlags.add("음원좌표미확인");
      excludedCount++;
      continue;
    }

    const lwDb = source.indoor
      ? indoorFacadeSourcePowerLevel(source.indoor.lpIndoorDb, source.indoor.R, source.indoor.S)
      : source.lwDb;
    if (typeof lwDb !== "number" || !Number.isFinite(lwDb)) { allFlags.add("음원세기미확인"); excludedCount++; continue; }
    const specBad = validateSpectrum(source.spectrumRatiosDb, CONCAWE_BANDS_HZ);
    if (specBad) { allFlags.add("옥타브스펙트럼필수_모양미확인"); excludedCount++; continue; } // 밴드 누락·빈 객체도 여기서 막힘(외부 검토 지적)

    const weightDb = timeWeightDb(activeMinutes) ?? 0; // ①시간가중: 음원별·밴드별 LW에 미리 더함
    if (activeMinutes < 60) allFlags.add(`시간가중_${Math.round(activeMinutes)}분`);

    const geometry = sourceReceiverGeometry({
      sourceLat: source.lat, sourceLon: source.lon,
      receiverLat: receiver.lat, receiverLon: receiver.lon,
      windVecFromDeg: weather.windVecFromDeg,
    });
    const v = weather.wsd10m * geometry.alignment; // 음원→수음점 쪽 벡터 풍속(+)

    let sourceContributed = false;
    for (const freqHz of CONCAWE_BANDS_HZ) {
      const bandLw = lwDb + source.spectrumRatiosDb[freqHz] + weightDb; // validateSpectrum이 이미 확인함
      const band = calcConcaweBand({
        concaweData, freqHz, lwDb: bandLw, d: geometry.distanceM,
        groundType: source.groundType, dSoftM: source.dSoftM,
        tempC: weather.tempC, rhPercent: weather.rhPercent,
        stability: weather.stability, v, hs: source.hs, hr: source.hr,
      });
      band.flags.forEach((f) => allFlags.add(f));
      if (band.value !== null && Number.isFinite(band.value)) { // NaN 방어(외부 검토 지적)
        perBandLevels[freqHz].push(band.value);
        sourceContributed = true;
      }
    }
    // 3차 외부 검토 지적(11/22): 음원이 "가동 중"으로 셈해졌는데도(anyActive=true) 7밴드
    // 전부 거리<100m 등의 이유로 null이면 — 예를 들어 30m 앞 큰 무대가 100m 제한에 걸려
    // 전부 빠지고 먼 무대만 남는 경우 — 그동안 excludedCount에 안 잡혔어요. 그 결과
    // "일부음원제외" 없이 "전부 합산된 정상 결과"처럼 등급까지 그대로 나왔습니다. 음원이
    // 활성인데 밴드를 하나도 못 채웠으면 이것도 제외로 셈해요.
    if (!sourceContributed) excludedCount++;
  }

  if (excludedCount > 0) allFlags.add("일부음원제외"); // 전부 합산된 것과 구분 — 몇 개가 빠졌는지는 다른 flags로 알 수 있음
  if (!anyActive) return { ...baseCell, value: null, level: null, flags: [...allFlags], scenario };

  // ②같은 밴드끼리 음원 에너지 합산 → ③A가중 → ④밴드 로그합
  const bandLevelsDbA = CONCAWE_BANDS_HZ.map((freqHz) => {
    const levels = perBandLevels[freqHz];
    if (levels.length === 0) return null;
    return logSumDb(levels) + A_WEIGHT_DB[freqHz];
  });
  const value = logSumDb(bandLevelsDbA);
  return { ...baseCell, value, level: classifyNoiseLevel(value), flags: [...allFlags], scenario };
}

/**
 * 한 시각의 지도 데이터를 만들어요 — 격자 전체에 대해 두 엔진을 돌려 OutputCell[]로
 * 합쳐요(로드맵 M2 11/19 완료 기준). 배출가스는 수음점마다 가동 중인 발전차를 전부
 * 모아 한 번만 계산해요(발전차별로 셀을 따로 안 만듦 — 11/21 바뀐 방식).
 *
 * `noiseScenario`를 **반드시** "concawe"(시민·공단 메인 지도, 로드맵 §2 표 — 수음점당 셀
 * 하나, 동시 음원 전부 합산) 또는 "iso"(공단 비교용 — 음원마다 셀을 따로 만듦)로 명시해야
 * 해요. 11/21엔 concaweData 유무로 조용히 자동 분기했는데, 표를 빠뜨리면 메인 지도가
 * 아무 경고 없이 비교용 엔진으로 바뀌는 문제가 있었어요(외부 검토 지적, 11/22 수정).
 * @param {{ stageSources: any[], generatorSources: any[], weather: any, hour: string,
 *   grid?: {lat:number, lon:number}[], 가정?: string, noiseScenario: "concawe"|"iso", concaweData?: object }} p
 * @returns {import("./common.js").OutputCell[]}
 */
export function computeHourOutputCells({ stageSources, generatorSources, weather, hour, grid = generateGridPoints(), 가정 = "기본추정", noiseScenario, concaweData }) {
  if (noiseScenario !== "concawe" && noiseScenario !== "iso") {
    throw new Error(`noiseScenario은 "concawe" 또는 "iso" 중 하나를 꼭 넘겨야 해요(받은 값: ${noiseScenario}) — 메인 지도/공단 비교용이 조용히 안 바뀌게 11/22에 필수로 바꿨어요.`);
  }
  if (noiseScenario === "concawe" && !concaweData) {
    throw new Error("noiseScenario이 'concawe'면 concaweData(data/concawe_4_81.json)를 꼭 같이 넘겨야 해요.");
  }
  // 2차 외부 검토 지적(11/22): concaweData가 참(truthy)이기만 하면 통과시켰던 걸, {}같은
  // 빈 객체도 참이라 통과한 뒤 calcConcaweBand 안에서 없는 키를 읽다가 TypeError로 터지는
  // 문제가 있었어요 — 필수 최상위 키가 다 있는지 여기서 미리 확인해요.
  if (noiseScenario === "concawe") {
    const requiredKeys = ["K2_대기흡음_dB_per_km", "K3_지면효과_soft", "K4_기상보정", "K5_높이보정_gamma"];
    const missing = requiredKeys.filter((k) => !(k in concaweData));
    if (missing.length > 0) {
      throw new Error(`concaweData에 필수 키가 없어요(data/concawe_4_81.json 형식이 아닌 것 같아요): ${missing.join(", ")}`);
    }
  }
  const cells = [];
  for (const receiver of grid) {
    if (noiseScenario === "concawe") {
      cells.push(computeNoiseCellConcawe({ stageSources, receiver, weather, hour, concaweData }));
    } else {
      for (const source of stageSources) {
        cells.push(computeNoiseCell({ source, receiver, weather, hour }));
      }
    }
    cells.push(computeExhaustCell({ generators: generatorSources, receiver, weather, hour, 가정 }));
  }
  return cells;
}

export { mapDisplayFor, classifyNoiseLevel, classifyExhaustLevel };
