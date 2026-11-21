// engine/combine.js — 엔진 연결 (친구 라인, 11/19 작성, 11/21 plume.js 동결에 맞춰 수정)
// 소음(noise.js)·배출가스(plume.js) 두 엔진을 한 시각·한 격자에 대해 돌려서
// engine/common.js의 OutputCell[] 모양으로 합쳐요. 계산 자체는 두 엔진이 하고,
// 여기는 "격자 만들기 + 둘을 같은 모양으로 합치기"만 해요(로드맵 M2 11/19).
//
// ⚠️ 소음은 아직 미완성이에요 — ISO 9613-2의 Aground(지면 효과)를 못 구해서
// (noise.js 참고), 숫자(dB)까지는 못 내고 value:null + 플래그로만 표시해요.
// 배출가스는 plume.js의 calcExhaustAtReceiver()로 실제 ppm 값을 내요 — 수음점마다
// 그 시각에 가동 중인 발전차를 전부 모아 한 번만 불러요(합산·풍향 부채꼴·ARM2는
// 그 함수 안에서 처리, 11/21 하린 지시).
//
// 좌표는 아직 EPSG:5186(미터)이 아니라 위경도 그대로 둬요(common.js 3.5절과 같은 이유,
// OutputCell.x/y 주석도 11/21에 맞춰 고쳤어요).

import { CALC_GRID, mapDisplayFor } from "./common.js";
import { sourceReceiverGeometry, windGateFor, stageDirectivityDb, calcAdiv, calcAatm, classifyNoiseLevel } from "./noise.js";
import { calcExhaustAtReceiver, classifyExhaustLevel } from "./plume.js";

const DEG_PER_M_LAT = 1 / 111320;

/**
 * CALC_GRID.bounds 안을 cellSizeM 간격의 격자점으로 채워요(위경도 근사).
 * @param {number} [cellSizeM]
 * @returns {{lat: number, lon: number}[]}
 */
export function generateGridPoints(cellSizeM = CALC_GRID.cellSizeM) {
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
 * 무대 음원 하나 × 수음점 하나의 소음 OutputCell을 만들어요.
 * 지금은 Aground가 없어서 최종 dB를 못 내요 — value는 null, 어느 항까지 계산했는지는
 * flags/scenario로 남겨요(Adiv·Aatm은 실제로 계산해서 넣어둬요, 나중에 Aground만 더하면 됨).
 * @returns {import("./common.js").OutputCell}
 */
export function computeNoiseCell({ source, receiver, weather, hour, freqHz = 1000 }) {
  const geometry = sourceReceiverGeometry({
    sourceLat: source.lat,
    sourceLon: source.lon,
    receiverLat: receiver.lat,
    receiverLon: receiver.lon,
    windVecFromDeg: weather.windVecFromDeg,
  });
  const gate = windGateFor(geometry);
  const flags = [...gate.flags, "ISO9613_지면효과미적용"];
  if (!gate.include) {
    return { x: receiver.lon, y: receiver.lat, hour, layer: "noise", value: null, level: null, flags, scenario: "ISO9613-2_상한_부분구현" };
  }
  const adiv = calcAdiv(geometry.distanceM);
  const aatm = calcAatm(geometry.distanceM, freqHz, weather.tempC, weather.rhPercent);
  const dc = stageDirectivityDb();
  return {
    x: receiver.lon,
    y: receiver.lat,
    hour,
    layer: "noise",
    value: null, // LW 없이는 최종 dB를 못 냄 — Adiv/Aatm은 계산해서 flags에 참고용으로 남김
    level: null,
    flags: [...flags, `Adiv=${adiv.toFixed(1)}dB`, `Aatm=${aatm.toFixed(2)}dB`, `Dc=${dc}dB`],
    scenario: "ISO9613-2_상한_부분구현",
  };
}

/**
 * 한 시각의 지도 데이터를 만들어요 — 격자 전체에 대해 두 엔진을 돌려 OutputCell[]로
 * 합쳐요(로드맵 M2 11/19 완료 기준). 배출가스는 수음점마다 가동 중인 발전차를 전부
 * 모아 한 번만 계산해요(발전차별로 셀을 따로 안 만듦 — 11/21 바뀐 방식).
 * @param {{ stageSources: any[], generatorSources: any[], weather: any, hour: string, grid?: {lat:number, lon:number}[], 가정?: string }} p
 * @returns {import("./common.js").OutputCell[]}
 */
export function computeHourOutputCells({ stageSources, generatorSources, weather, hour, grid = generateGridPoints(), 가정 = "기본추정" }) {
  const cells = [];
  for (const receiver of grid) {
    for (const source of stageSources) {
      cells.push(computeNoiseCell({ source, receiver, weather, hour }));
    }
    cells.push(computeExhaustCell({ generators: generatorSources, receiver, weather, hour, 가정 }));
  }
  return cells;
}

export { mapDisplayFor, classifyNoiseLevel, classifyExhaustLevel };
