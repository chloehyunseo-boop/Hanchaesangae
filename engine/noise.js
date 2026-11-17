// engine/noise.js — 소음 엔진 (친구 라인)
// ISO 9613-2 상한 시나리오 + CONCAWE 시간별 추정. 로드맵 2번 "소음" 참고.
// 11/17 기준: 두 시나리오 다 실제 감쇠항 수식을 아직 원문에서 확인 못했어요
// (ISO 9613-2는 이번 세션에서 원문 대조 안 함, CONCAWE K1~K7은 원문이 스캔본이라
// 사용자가 PDF를 직접 열어 확인해야 해요 — data/assumptions.json의 CONCAWE_원문 참고).
// CLAUDE.md 규칙 2(확인 안 된 수식을 지어내지 않음) · 5(공개 표준만) 때문에, 지금은
// 음원·수음점 기하(거리·방위각)와 출력 모양만 자리를 잡아요. 실제 감쇠항은 원문 확인 후
// calcNoiseIso9613Upper / calcNoiseConcaweHourly 안에 채워요.

import { haversineDistanceM, bearingDeg, windComponentTowardReceiver } from "./common.js";

/**
 * 소음 음원→수음점의 거리·방위각·풍향 정렬을 구해요. 두 시나리오가 공통으로 쓰는 기하 계산이에요.
 * @param {{sourceLat: number, sourceLon: number, receiverLat: number, receiverLon: number, windVecFromDeg: number}} p
 */
export function sourceReceiverGeometry({ sourceLat, sourceLon, receiverLat, receiverLon, windVecFromDeg }) {
  const distanceM = haversineDistanceM(sourceLat, sourceLon, receiverLat, receiverLon);
  const bearingDegSR = bearingDeg(sourceLat, sourceLon, receiverLat, receiverLon);
  const wind = windComponentTowardReceiver(windVecFromDeg, bearingDegSR);
  return { distanceM, bearingDegSR, ...wind };
}

/** CLAUDE.md 6번: 강 65dB↑ · 중 55~65 · 약 45~55 (기준 미만이면 null) */
export function classifyNoiseLevel(dBA) {
  if (dBA >= 65) return "강";
  if (dBA >= 55) return "중";
  if (dBA >= 45) return "약";
  return null;
}

/**
 * ISO 9613-2 상한 시나리오 (Lp = LW + Dc − A, A = Adiv+Aatm+Aground+Abar).
 * @throws {Error} ISO 9613-2 원문 감쇠항 수식을 아직 확인 못해서 미구현이에요.
 */
export function calcNoiseIso9613Upper(/* { sourceLat, sourceLon, receiverLat, receiverLon, LW, windVecFromDeg, ... } */) {
  throw new Error(
    "미구현 — ISO 9613-2 원문의 감쇠항(Adiv/Aatm/Aground/Abar) 수식을 아직 확인 못했어요. " +
      "원문 확인 후 여기에 채워요(CLAUDE.md 규칙 2·5)."
  );
}

/**
 * CONCAWE 전체(K1~K7) 시간별 추정 시나리오.
 * @throws {Error} CONCAWE 원문(K1~K7, 기상 범주표)을 아직 확인 못해서 미구현이에요.
 */
export function calcNoiseConcaweHourly(/* { sourceLat, sourceLon, receiverLat, receiverLon, LW, windVecFromDeg, tmp, ... } */) {
  throw new Error(
    "미구현 — CONCAWE 원문(data/assumptions.json의 CONCAWE_원문.원문_PDF, 101쪽)의 K1~K7 수식과 " +
      "기상 범주표를 아직 확인 못했어요. 원문 확인 후 여기에 채워요(CLAUDE.md 규칙 2·5)."
  );
}
