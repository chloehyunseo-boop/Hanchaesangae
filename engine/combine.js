// engine/combine.js — 엔진 연결 (친구 라인, 11/19)
// 소음(noise.js)·배출가스(plume.js) 두 엔진을 한 시각·한 격자에 대해 돌려서
// engine/common.js의 OutputCell[] 모양으로 합쳐요. 계산 자체는 두 엔진이 하고,
// 여기는 "격자 만들기 + 둘을 같은 모양으로 합치기"만 해요(로드맵 M2 11/19).
//
// ⚠️ 소음은 아직 미완성이에요 — ISO 9613-2의 Aground(지면 효과)를 못 구해서
// (noise.js 참고), 숫자(dB)까지는 못 내고 value:null + 플래그로만 표시해요.
// 배출가스는 하린의 가정값으로 실제 ppm 값을 내요.
//
// 좌표는 아직 EPSG:5186(미터)이 아니라 위경도 그대로 둬요(common.js 3.5절과 같은 이유).

import { CALC_GRID, mapDisplayFor } from "./common.js";
import { sourceReceiverGeometry, windGateFor, stageDirectivityDb, calcAdiv, calcAatm, classifyNoiseLevel } from "./noise.js";
import { calcExhaustGaussianPlume, classifyExhaustLevel } from "./plume.js";

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
 * 발전차 음원 하나 × 수음점 하나의 배출가스 OutputCell을 만들어요.
 * @returns {import("./common.js").OutputCell}
 */
export function computeExhaustCell({ source, receiver, weather, hour }) {
  const result = calcExhaustGaussianPlume({
    sourceLat: source.lat,
    sourceLon: source.lon,
    receiverLat: receiver.lat,
    receiverLon: receiver.lon,
    enginePowerKW: source.엔진출력_kW,
    loadFactor: source.loadFactor ?? 1.0,
    stability: weather.stability,
    wsd10m: weather.wsd10m,
    windVecFromDeg: weather.windVecFromDeg,
    정보출처: source.정보출처,
  });
  return {
    x: receiver.lon,
    y: receiver.lat,
    hour,
    layer: "exhaust",
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
 * 한 시각의 지도 데이터를 만들어요 — 격자 전체 × 음원 전체에 대해 두 엔진을 돌려
 * OutputCell[]로 합쳐요(로드맵 M2 11/19 완료 기준).
 * @param {{ stageSources: any[], generatorSources: any[], weather: any, hour: string, grid?: {lat:number, lon:number}[] }} p
 * @returns {import("./common.js").OutputCell[]}
 */
export function computeHourOutputCells({ stageSources, generatorSources, weather, hour, grid = generateGridPoints() }) {
  const cells = [];
  for (const receiver of grid) {
    for (const source of stageSources) {
      cells.push(computeNoiseCell({ source, receiver, weather, hour }));
    }
    for (const source of generatorSources) {
      cells.push(computeExhaustCell({ source, receiver, weather, hour }));
    }
  }
  return cells;
}

export { mapDisplayFor, classifyNoiseLevel, classifyExhaustLevel };
