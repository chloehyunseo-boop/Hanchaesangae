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

// ---------------------------------------------------------------------------
// ISO 9613-2 감쇠항 — 1차: 거리 감쇠(Adiv) + 공기 흡수(Aatm)
// ---------------------------------------------------------------------------
// Aground(지면 효과)·Abar(차폐)는 아직 원문(ISO 9613-2 7.3절)을 못 봐서(유료) 비워 뒀어요.

/**
 * 거리 감쇠(Adiv, dB) — 점음원 구면 확산. ISO 9613-2의 잘 알려진 식이에요.
 * Adiv = 20·log10(d/d0) + 11, d0 = 1m.
 * @param {number} distanceM 음원-수음점 거리(m)
 */
export function calcAdiv(distanceM) {
  return 20 * Math.log10(distanceM / 1) + 11;
}

// ISO 9613-1(=ANSI/ASA S1.26)의 공기 흡수 계수 식. 표준 원문 자체는 이번에 못 열어봤고,
// Bass·Sutherland·Zuckerwar·Blackstock·Hester(1995, JASA 97(1), 680-683,
// doi:10.1121/1.412989)의 공개식을 따랐어요 — python-acoustics 등 여러 공개 구현이 같은 식을
// 써요. 상수는 그 논문 기준이에요.
const T0 = 293.15; // 기준 온도(K)
const T01 = 273.16; // 물의 삼중점(K)
const P_REF_KPA = 101.325; // 기준 기압(kPa)

/**
 * 공기 흡수 감쇠 계수(alpha, dB/m)를 계산해요.
 * @param {number} freqHz 주파수(Hz)
 * @param {number} tempC 기온(℃)
 * @param {number} rhPercent 상대습도(%)
 * @param {number} [pressureKPa] 기압(kPa, 기본 표준대기압)
 * @returns {number} dB/m
 */
export function atmosphericAbsorptionDbPerM(freqHz, tempC, rhPercent, pressureKPa = P_REF_KPA) {
  const T = tempC + 273.15;
  const pr = pressureKPa / P_REF_KPA;

  const psatOverPref = 10.0 ** (-6.8346 * (T01 / T) ** 1.261 + 4.6151);
  const h = (rhPercent * psatOverPref) / pr;

  const frO = pr * (24.0 + (4.04e4 * h * (0.02 + h)) / (0.391 + h));
  const frN =
    pr *
    (T / T0) ** -0.5 *
    (9.0 + 280.0 * h * Math.exp(-4.17 * ((T / T0) ** (-1.0 / 3.0) - 1.0)));

  const classical = 1.84e-11 * (1 / pr) * Math.sqrt(T / T0);
  const aO = 0.01275 * Math.exp(-2239.1 / T) * (frO / (frO ** 2 + freqHz ** 2));
  const aN = 0.1068 * Math.exp(-3352.0 / T) * (frN / (frN ** 2 + freqHz ** 2));

  return 8.686 * freqHz ** 2 * (classical + (T / T0) ** -2.5 * (aO + aN));
}

/** Aatm(dB) = alpha(dB/m) × 거리(m) */
export function calcAatm(distanceM, freqHz, tempC, rhPercent, pressureKPa = P_REF_KPA) {
  return atmosphericAbsorptionDbPerM(freqHz, tempC, rhPercent, pressureKPa) * distanceM;
}

// ---------------------------------------------------------------------------
// 2차: 무대 지향성(Dc) + 바람 보정 + 실내 공연장 외벽(LW 환산)
// ---------------------------------------------------------------------------

/**
 * 무대 지향성 보정(Dc, dB). 로드맵·올팍_좌표.md 결정대로 항상 0이에요 — 무대 방향(스피커가
 * 어디를 보는지)은 계산에 안 넣어요. 무대 뒤·옆이 실제보다 시끄럽게 나오는 쪽(안전측 가정).
 * @returns {0}
 */
export function stageDirectivityDb() {
  return 0;
}

/**
 * 바람 보정 — CLAUDE.md 공통 조건의 "풍향 불확실성 부채꼴"을 그대로 적용해요. 부채꼴
 * 밖이면 이 음원은 그 수음점에 안 들린다고 보고 계산에서 빼요(지어낸 K4 보정 없이,
 * 이미 합의된 부채꼴 규칙만 씀).
 * @param {ReturnType<typeof sourceReceiverGeometry>} geometry
 * @returns {{ include: boolean, flags: string[] }}
 */
export function windGateFor(geometry) {
  if (!geometry.withinFan) {
    return { include: false, flags: ["풍향부채꼴밖"] };
  }
  return { include: true, flags: [] };
}

/**
 * 실내 공연장의 실내 음량(Lp,실내)을 외벽을 거쳐 나가는 음원 파워레벨(LW)로 바꿔요.
 * CLAUDE.md 6번에 이미 정해진 식이에요: LW = Lp,실내 − R + 10·log10(S) − 6.
 * @param {number} lpIndoorDb 실내 음압레벨(dB)
 * @param {number} transmissionLossDb 외벽 투과손실(R, dB) — data/assumptions.json의 소음_가정값.외벽_차음량
 * @param {number} wallAreaM2 외벽 면적(S, m²)
 * @returns {number} LW(dB)
 */
export function indoorFacadeSourcePowerLevel(lpIndoorDb, transmissionLossDb, wallAreaM2) {
  return lpIndoorDb - transmissionLossDb + 10 * Math.log10(wallAreaM2) - 6;
}

/**
 * ISO 9613-2 상한 시나리오 (Lp = LW + Dc − A, A = Adiv+Aatm+Aground+Abar).
 * @throws {Error} Aground(지면 효과) 원문 수식을 아직 확인 못해서 전체 합산은 미구현이에요.
 *   거리 감쇠·공기 흡수만 쓰려면 calcAdiv()/calcAatm()을 따로 부르세요.
 */
export function calcNoiseIso9613Upper(/* { sourceLat, sourceLon, receiverLat, receiverLon, LW, windVecFromDeg, ... } */) {
  throw new Error(
    "미구현 — Aground(지면 효과, ISO 9613-2 7.3절) 수식을 아직 확인 못했어요(원문 유료). " +
      "Adiv·Aatm은 calcAdiv()/calcAatm()으로 따로 쓸 수 있어요. 원문 확인 후 여기에 채워요(CLAUDE.md 규칙 2·5)."
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
