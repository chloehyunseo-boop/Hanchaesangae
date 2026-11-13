// engine/noise.js — 소음 엔진 (친구 라인)
// ISO 9613-2 상한 시나리오 + CONCAWE 시간별 추정. 로드맵 2번 "소음" 참고.
// 11/17~11/18(M2)에 실제 계산을 넣어요. 지금은 저장소 뼈대만 있어요.

import { CALC_GRID, KMA_GRID, latLonToKmaGrid } from "./common.js";

export function calcNoiseIso9613Upper(/* params */) {
  throw new Error("not implemented yet — 11/17 M2에서 작성");
}

export function calcNoiseConcaweHourly(/* params */) {
  throw new Error("not implemented yet — 11/17~11/18 M2에서 작성");
}
