// app/grid-worker.js — 격자 전체 계산을 메인 화면이 멈추지 않게 Web Worker에서 돌려요.
// 로드맵 "출품 시 적용 범위와 검토 근거" 권고표: 한 시각 계산이 0.3초를 넘으면
// Web Worker를 추가하라고 돼 있었고, 2026-11-22에 직접 재서 462ms가 나와서(기본
// 음원 1개·발전차 0대 기준) 조건을 충족해 추가했어요. 엔진 코드(engine/)는 그대로
// 두고, 이 파일은 그 엔진을 별도 스레드에서 부르는 얇은 래퍼예요.

import { computeHourOutputCells, generateGridPoints } from "../engine/combine.js";

let grid = null;

self.onmessage = (ev) => {
  const { requestId, stageSources, generatorSources, weather, hour, noiseScenario, concaweData, cellSizeM, 배출시나리오 } = ev.data;
  try {
    if (!grid) grid = generateGridPoints(cellSizeM);
    const cells = computeHourOutputCells({
      stageSources, generatorSources, weather, hour, grid, noiseScenario, concaweData, 배출시나리오,
    });
    self.postMessage({ requestId, ok: true, cells });
  } catch (err) {
    self.postMessage({ requestId, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
