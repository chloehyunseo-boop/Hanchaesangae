// app/grid-worker.js — 격자 전체 계산을 메인 화면이 멈추지 않게 Web Worker에서 돌려요.
// 로드맵 "출품 시 적용 범위와 검토 근거" 권고표: 한 시각 계산이 0.3초를 넘으면
// Web Worker를 추가하라고 돼 있었고, 2026-11-22에 직접 재서 462ms가 나와서(기본
// 음원 1개·발전차 0대 기준) 조건을 충족해 추가했어요. 엔진 코드(engine/)는 그대로
// 두고, 이 파일은 그 엔진을 별도 스레드에서 부르는 얇은 래퍼예요.

import { computeHourOutputCells, generateGridPoints } from "../engine/combine.js";

let fallbackGrid = null; // grid를 안 보내준 옛 호출(없음)에 대비한 안전망

self.onmessage = (ev) => {
  const { requestId, stageSources, generatorSources, weather, hour, noiseScenario, concaweData, cellSizeM, 배출시나리오, grid } = ev.data;
  try {
    // 11/26: 이제 메인 스레드(shared.js createGridWorker)가 격자를 Worker 개수만큼 미리
    // 나눠서 보내요(병렬 계산) — grid가 오면 그 조각만, 안 오면(옛 호출 호환) 전체를 써요.
    if (!grid && !fallbackGrid) fallbackGrid = generateGridPoints(cellSizeM);
    const cells = computeHourOutputCells({
      stageSources, generatorSources, weather, hour, grid: grid ?? fallbackGrid, noiseScenario, concaweData, 배출시나리오,
    });
    self.postMessage({ requestId, ok: true, cells });
  } catch (err) {
    self.postMessage({ requestId, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
