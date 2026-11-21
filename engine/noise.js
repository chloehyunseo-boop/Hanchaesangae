// engine/noise.js — 소음 엔진 (친구 라인)
// ISO 9613-2 상한 시나리오(공단 비교용) + CONCAWE 전체 시간별 추정(시민·공단 메인 지도).
// 로드맵 §2 "모델 설계"의 표(①=공단 화면 비교용, ②=시민·공단 지도) 참고 — 11/21에 두
// 시나리오의 실제 쓰임이 바뀐 걸 뒤늦게 확인했어요(decisions.md 11/21 기록).
// ① ISO 9613-2 상한: 거리 감쇠(Adiv)+공기 흡수(Aatm)+무대 지향성(Dc)+바람 부채꼴로 동결.
// 지면 효과(Aground)·차폐(Abar)는 원문(ISO 9613-2 7.3절, 유료)을 못 구해서 안 넣었어요.
// ② CONCAWE 전체(K1~K7): 하린이 원문(CONCAWE Report 4/81)을 1차+2차 독립 대조해 옮긴
// data/concawe_4_81.json·docs/CONCAWE_원문정리.md를 그대로 따라 구현했어요(11/21).
// CLAUDE.md 규칙 2(확인 안 된 수식을 지어내지 않음) · 5(공개 표준만) 반영.

import { haversineDistanceM, bearingDeg, windComponentTowardReceiver, overlapMinutesInHour } from "./common.js";

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
 * ISO 9613-2 상한 시나리오: Lp = LW + Dc − Adiv − Aatm.
 * 11/21 결정(사용자·하린 확인): Aground(지면 효과)·Abar(차폐) 원문은 여전히 못 구했지만
 * (유료 표준, noise.js 상단 주석 참고), 이 시나리오 이름 자체가 "상한"이고 지면 효과는
 * 보통 소리를 깎아주는 쪽이라 빼면 더 보수적(높은) 값이 나와요 — 그래서 지금은 이 둘을
 * 빼고 "거리 감쇠+공기 흡수+무대 지향성+바람 부채꼴"만으로 상한을 추정해요. 나중에 원문을
 * 구하면 Aground 항만 추가하면 돼요(구조는 안 바뀜).
 * @param {{ sourceLat: number, sourceLon: number, receiverLat: number, receiverLon: number,
 *   windVecFromDeg: number, lwDb: number, freqHz?: number, tempC: number, rhPercent: number }} p
 *   lwDb: 음원 파워레벨(dB) — 실외 무대는 아직 확정 안 됨(로드맵 2번 '음원 세기'),
 *   실내는 indoorFacadeSourcePowerLevel()로 구해서 넣어요.
 * @returns {{ value: number|null, flags: string[], scenario: string }}
 */
export function calcNoiseIso9613Upper({ sourceLat, sourceLon, receiverLat, receiverLon, windVecFromDeg, lwDb, freqHz = 1000, tempC, rhPercent }) {
  const scenario = "ISO9613-2_상한추정_지면효과미적용";
  const geometry = sourceReceiverGeometry({ sourceLat, sourceLon, receiverLat, receiverLon, windVecFromDeg });
  const gate = windGateFor(geometry);
  const flags = [...gate.flags, "지면효과미적용"];
  if (!gate.include) {
    return { value: null, flags, scenario };
  }
  if (typeof lwDb !== "number" || !Number.isFinite(lwDb)) {
    return { value: null, flags: [...flags, "음원세기미확인"], scenario };
  }
  const adiv = calcAdiv(geometry.distanceM);
  const aatm = calcAatm(geometry.distanceM, freqHz, tempC, rhPercent);
  const dc = stageDirectivityDb();
  return { value: lwDb + dc - adiv - aatm, flags, scenario };
}

// ---------------------------------------------------------------------------
// 시간 가중 — 11/21 추가 (로드맵 2번 공통 조건, §7 검증표 "시간 가중")
// ---------------------------------------------------------------------------
/**
 * 공연이 그 1시간 중 일부만 가동됐을 때의 에너지 보정(dB). 예: 30분 가동 → 10·log10(30/60) ≈ −3dB.
 * 이 처리는 소음(LAeq,1h)에만 써요(로드맵 2번). 배경(무음)까지 1시간 평균에 섞는 단순화라,
 * 실제보다 낮게 나올 수 있어요 — 그래도 "0분(안 들림)"과는 분명히 달라야 해서 넣어요.
 * @param {number} activeMinutes 그 시간 안에서 공연이 실제로 가동된 분(0~60)
 * @returns {number|null} dB 보정값. activeMinutes가 0 이하면 null(계산 자체를 안 함)
 */
export function timeWeightDb(activeMinutes) {
  if (!(activeMinutes > 0)) return null;
  const clamped = Math.min(activeMinutes, 60);
  return 10 * Math.log10(clamped / 60);
}

/**
 * 무대 음원의 SourceSpec.time과 그 시각(hourIso)으로, 그 시간 안에 실제로 가동된 분을 구해요.
 * time.출처가 "미확인"이면 계산에 넣지 않아요(로드맵 2번 공통 조건, common.js SourceSpec 참고).
 * @param {{time?: {start: string|null, end: string|null, 출처: string}}} source
 * @param {string} hourIso
 * @returns {{activeMinutes: number, flags: string[]}}
 */
export function stageActiveMinutes(source, hourIso) {
  const time = source?.time;
  if (!time) return { activeMinutes: 60, flags: [] }; // time을 안 준 음원은 이전처럼 상시 가동 취급(하위호환)
  if (time.출처 === "미확인" || !time.start) return { activeMinutes: 0, flags: ["공연시간미확인"] };
  return { activeMinutes: overlapMinutesInHour(time.start, time.end, hourIso), flags: [] };
}

// ---------------------------------------------------------------------------
// 옥타브 8밴드 + A특성 — 11/21 추가 (로드맵 '옥타브 8밴드, A특성은 맨 마지막에', §7 검증표)
// ---------------------------------------------------------------------------
/** 계산에 쓰는 옥타브밴드 중심주파수(Hz) 8개. */
export const OCTAVE_BANDS_HZ = [63, 125, 250, 500, 1000, 2000, 4000, 8000];

/** 옥타브밴드 A가중 보정값(dB). IEC 61672(2003/2014) 공개 표준값 — 여러 출처로 교차 확인(2026-11-21). */
export const A_WEIGHT_DB = { 63: -26.2, 125: -16.1, 250: -8.6, 500: -3.2, 1000: 0, 2000: 1.2, 4000: 1.0, 8000: -1.1 };

/** 여러 dB 값을 에너지(로그) 합산해 하나의 dB로 합쳐요. null/숫자 아님은 무시해요. */
export function logSumDb(levelsDb) {
  const valid = levelsDb.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (valid.length === 0) return null;
  const sum = valid.reduce((acc, v) => acc + 10 ** (v / 10), 0);
  return 10 * Math.log10(sum);
}

/**
 * ISO 9613-2 상한 시나리오를 옥타브 8밴드로 나눠 계산한 뒤 A가중 합산해요(로드맵 설계 그대로).
 * 로드맵 §2는 "음원은 반드시 옥타브 밴드 스펙트럼으로 입력, dB(A) 단일값 금지"라고 못
 * 박아서(11/21 재확인), spectrumRatiosDb(밴드별 "전체 LW 대비 상대 dB")가 없으면
 * CONCAWE와 똑같이 계산하지 않아요(value:null) — 전에는 여기서 단일주파수 근사로
 * 조용히 내려갔는데, 그건 이 규칙을 제가 스스로 어긴 거였어요(11/21 바로잡음).
 * 그 근사가 그래도 필요하면(예: 개발 중 임시 확인용) allowApprox:true로 명시적으로 요청하세요
 * — 그러면 calcNoiseIso9613Upper()의 1kHz 근사로 내려가고 "비공식근사_명시요청"이 붙어요.
 * @param {{ sourceLat: number, sourceLon: number, receiverLat: number, receiverLon: number,
 *   windVecFromDeg: number, lwDb: number, tempC: number, rhPercent: number,
 *   spectrumRatiosDb?: Partial<Record<63|125|250|500|1000|2000|4000|8000, number>>,
 *   allowApprox?: boolean }} p
 * @returns {{ value: number|null, flags: string[], scenario: string }}
 */
export function calcNoiseIso9613UpperOctave({ sourceLat, sourceLon, receiverLat, receiverLon, windVecFromDeg, lwDb, tempC, rhPercent, spectrumRatiosDb, allowApprox = false }) {
  if (!spectrumRatiosDb) {
    if (allowApprox) {
      const fallback = calcNoiseIso9613Upper({ sourceLat, sourceLon, receiverLat, receiverLon, windVecFromDeg, lwDb, tempC, rhPercent });
      return { ...fallback, flags: [...fallback.flags, "비공식근사_명시요청", "옥타브분해미적용_스펙트럼모양미확인"] };
    }
    return { value: null, flags: ["옥타브스펙트럼필수_모양미확인"], scenario: "ISO9613-2_상한추정_지면효과미적용_옥타브8밴드" };
  }
  const scenario = "ISO9613-2_상한추정_지면효과미적용_옥타브8밴드";
  const geometry = sourceReceiverGeometry({ sourceLat, sourceLon, receiverLat, receiverLon, windVecFromDeg });
  const gate = windGateFor(geometry);
  const flags = [...gate.flags, "지면효과미적용"];
  if (!gate.include) return { value: null, flags, scenario };
  if (typeof lwDb !== "number" || !Number.isFinite(lwDb)) return { value: null, flags: [...flags, "음원세기미확인"], scenario };
  const adiv = calcAdiv(geometry.distanceM);
  const dc = stageDirectivityDb();
  const bandLevelsDbA = OCTAVE_BANDS_HZ.map((freqHz) => {
    const bandLw = lwDb + (spectrumRatiosDb[freqHz] ?? 0);
    const aatm = calcAatm(geometry.distanceM, freqHz, tempC, rhPercent);
    const bandLp = bandLw + dc - adiv - aatm;
    return bandLp + A_WEIGHT_DB[freqHz];
  });
  return { value: logSumDb(bandLevelsDbA), flags, scenario };
}

// ---------------------------------------------------------------------------
// 음원 세기(LW) 역산 — 11/21 추가. 로드맵 '음원 세기'의 "계약 기준 반영 시나리오":
// 공단이 알려줄 측정 지점·측정 지표(예: 65dB)로, 그 지점이 정확히 그 값이 나오도록
// LW를 거꾸로 구해요. "오늘 공연이 실제로 몇 dB였다"가 아니라 "그 공연이 허용 기준치로
// 운영된다고 가정"하는 거예요 — 숫자 자체(측정 지점 좌표·목표 dB)는 공단 답 대기 중.
// ---------------------------------------------------------------------------

/**
 * 측정 지점에서 목표 dB(targetDb)가 정확히 나오도록 음원 세기(LW)를 역산해요.
 * Lp = LW + Dc − Adiv − Aatm 이고 Dc는 항상 0이니, LW = targetDb + Adiv + Aatm.
 * 바람 부채꼴은 적용하지 않아요 — 이건 실시간 전파 계산이 아니라, 음원 세기 하나를
 * 정하는 보정 계산이에요(기준 조건에서 한 번만 하면 됨).
 * @param {{ sourceLat: number, sourceLon: number, measureLat: number, measureLon: number,
 *   targetDb: number, freqHz?: number, tempC: number, rhPercent: number }} p
 *   tempC/rhPercent: 역산에 쓸 기준 날씨 — 공연마다 바뀌는 실시간 예보가 아니라, 호출하는
 *   쪽이 정한 기준 조건(아직 로드맵에 합의된 기준값 없음 — 공단 답 확인 후 정해요).
 * @returns {{ lwDb: number, distanceM: number, adiv: number, aatm: number }}
 */
export function lwFromTargetDb({ sourceLat, sourceLon, measureLat, measureLon, targetDb, freqHz = 1000, tempC, rhPercent }) {
  const distanceM = haversineDistanceM(sourceLat, sourceLon, measureLat, measureLon);
  const adiv = calcAdiv(distanceM);
  const aatm = calcAatm(distanceM, freqHz, tempC, rhPercent);
  const dc = stageDirectivityDb();
  return { lwDb: targetDb - dc + adiv + aatm, distanceM, adiv, aatm };
}

/**
 * 공단 화면에서 기본 음량(역산값 또는 문헌 가정값)을 조정할 때 쓰는 preset(±3dB).
 * 값은 로드맵 2번에 적힌 가정이고, 실측으로 검증된 숫자는 아니에요.
 */
export const VOLUME_PRESETS = { 조용한: -3, 기본: 0, 큰공연: 3 };

/**
 * 기본 LW에 preset을 적용해요.
 * @param {number} baseLwDb
 * @param {keyof VOLUME_PRESETS} [preset]
 * @returns {number}
 */
export function applyVolumePreset(baseLwDb, preset = "기본") {
  if (!(preset in VOLUME_PRESETS)) throw new Error(`알 수 없는 preset: ${preset}(조용한·기본·큰공연 중 하나)`);
  return baseLwDb + VOLUME_PRESETS[preset];
}

// ---------------------------------------------------------------------------
// CONCAWE 전체(K1~K7) — 11/21 구현. 숫자 출처: data/concawe_4_81.json(하린이
// 1차+2차 독립 대조). 원문이 답하지 않는 부분(거리 밖, 25.7 인쇄오류, K5 γ 불일치,
// 경계값, K6·K7 등)은 그 문서 16번 "검토자 추천안"을 그대로 따랐어요(친구 라인 결정).
// ---------------------------------------------------------------------------

/** 계산에 쓰는 CONCAWE 밴드(Hz). 원문 범위 그대로 7개(8kHz 제외 — 추천안 3번). */
export const CONCAWE_BANDS_HZ = [63, 125, 250, 500, 1000, 2000, 4000];

function evalPoly(coeffs, L) {
  return coeffs.reduce((acc, c, i) => acc + c * L ** i, 0);
}

/** K1: 거리 감쇠(구면 확산). K1 = 10·log10(4π·d²). (data/concawe_4_81.json 참고 안 함 — 식이 원문에 직접 있음) */
export function concaweK1(d) {
  return 10 * Math.log10(4 * Math.PI * d ** 2);
}

/**
 * K2 표(온도 0~30℃·5도 간격, 습도 55~100%·5%간격)를 보간해서 읽어요. 범위 밖이면 null
 * (호출하는 쪽이 ISO 9613-1 식으로 대체 — 추천안 1번).
 */
function k2TableLookup(concaweData, freqHz, tempC, rhPercent) {
  if (tempC < 0 || tempC > 30 || rhPercent < 55 || rhPercent > 100) return null;
  const table = concaweData.K2_대기흡음_dB_per_km;
  const row = String(table.옥타브_to_표행[String(freqHz)]);
  const rhList = table.상대습도_퍼센트;

  const t0 = Math.min(25, Math.floor(tempC / 5) * 5);
  const t1 = t0 + 5;
  const tf = (tempC - t0) / (t1 - t0);

  let rIdx1 = rhList.findIndex((r) => r >= rhPercent);
  if (rIdx1 <= 0) rIdx1 = 1;
  const rIdx0 = rIdx1 - 1;
  const r0 = rhList[rIdx0], r1 = rhList[rIdx1];
  const rf = (rhPercent - r0) / (r1 - r0);

  const readCell = (t, rIdx) => {
    let v = table.표[String(t)][row][rIdx];
    // 0℃·3200Hz(=4000Hz 밴드)·RH65% 원문 인쇄 오류 보정(25.7→35.7, 추천안 "간단히 정하면 되는 것").
    if (t === 0 && row === "3200" && rhList[rIdx] === 65) v = 35.7;
    return v;
  };
  const v00 = readCell(t0, rIdx0), v01 = readCell(t0, rIdx1);
  const v10 = readCell(t1, rIdx0), v11 = readCell(t1, rIdx1);
  const v0 = v00 + (v01 - v00) * rf;
  const v1 = v10 + (v11 - v10) * rf;
  return v0 + (v1 - v0) * tf;
}

/** K2: 공기 흡수(dB). 표 범위 밖이면 ISO 9613-1 식(atmosphericAbsorptionDbPerM)으로 대체해요. */
export function concaweK2(concaweData, freqHz, tempC, rhPercent, d) {
  const alphaTable = k2TableLookup(concaweData, freqHz, tempC, rhPercent); // dB/km
  if (alphaTable !== null) return { k2: alphaTable * (d / 1000), flags: [] };
  const alphaIso = atmosphericAbsorptionDbPerM(freqHz, tempC, rhPercent) * 1000; // dB/m → dB/km
  return { k2: alphaIso * (d / 1000), flags: ["K2범위밖_ISO9613대체"] };
}

/**
 * K3: 지면 효과. 딱딱한 면(콘크리트·물)은 항상 −3dB. 그 외(잔디 등)는 밴드별 3차식 —
 * dSoftM은 "부드러운 면 위를 지나는 거리"만(일부만 부드러우면 그 구간 길이, 원문 p31 예).
 */
export function concaweK3(concaweData, freqHz, groundType, dSoftM) {
  if (groundType === "hard") return -3;
  const coeffs = concaweData.K3_지면효과_soft.계수[String(freqHz)];
  return evalPoly(coeffs, Math.log10(dSoftM));
}

const AB_STABILITY = ["A", "B"], FG_STABILITY = ["F", "G"];

/**
 * 안정도(Pasquill A~G)와 벡터풍속(v, 음원→수음점 쪽 +)으로 기상 범주(1~6)를 정해요
 * (원문 p26 표). 경계값(v=±0.5,±3.0)은 범주4(기상영향 0, 가장 덜 극단적인 쪽)에 가까운
 * 쪽으로 넣었어요(추천안 7번). F·G에서 v>+3.0은 표에 없는 칸이라 범주6으로 봐요(추천안 8번).
 * @param {string} stability
 * @param {number} v
 * @returns {number} 1~6
 */
export function concaweCategory(stability, v) {
  if (AB_STABILITY.includes(stability)) {
    if (v < -3.0) return 1;
    if (v < -0.5) return 2;
    if (v < 0.5) return 3;
    if (v <= 3.0) return 4;
    return 5;
  }
  if (FG_STABILITY.includes(stability)) {
    if (v < -3.0) return 3;
    if (v <= -0.5) return 4;
    if (v <= 0.5) return 5;
    return 6;
  }
  // C, D, E
  if (v < -3.0) return 2;
  if (v < -0.5) return 3;
  if (v <= 0.5) return 4;
  if (v <= 3.0) return 5;
  return 6;
}

/** K4: 기상 보정. 범주4는 모든 밴드·거리에서 0. */
export function concaweK4(concaweData, freqHz, category, d) {
  if (category === 4) return 0;
  const coeffs = concaweData.K4_기상보정.계수[String(freqHz)][String(category)];
  return evalPoly(coeffs, Math.log10(d));
}

// K5 γ — 추천안 B(원문 p76 그림 9 그래프 판독값, docs/CONCAWE_원문정리.md 15번 G).
// 원문 인쇄 식(1−0.478ψ+0.068ψ²−0.0029ψ³)은 이 그래프와 안 맞아요(원문 내부 불일치,
// 같은 문서 14번) — 본문(p32)이 "γ는 그림 9에서 구한다"고 적어 그래프 쪽을 따랐어요.
const GAMMA_GRAPH_PSI_DEG = [0, 1, 2, 3, 4, 5.2];
const GAMMA_GRAPH_VALUES = [1.0, 0.70, 0.38, 0.17, 0.06, 0];

function gammaFromGraph(psiDeg) {
  if (psiDeg <= 0) return 1;
  if (psiDeg >= 5.2) return 0;
  for (let i = 0; i < GAMMA_GRAPH_PSI_DEG.length - 1; i++) {
    const p0 = GAMMA_GRAPH_PSI_DEG[i], p1 = GAMMA_GRAPH_PSI_DEG[i + 1];
    if (psiDeg >= p0 && psiDeg <= p1) {
      const f = (psiDeg - p0) / (p1 - p0);
      return GAMMA_GRAPH_VALUES[i] + (GAMMA_GRAPH_VALUES[i + 1] - GAMMA_GRAPH_VALUES[i]) * f;
    }
  }
  return 0;
}

/**
 * K5: 음원·수음점 높이 보정. hs≤2m이면 0(원문 그림 9). hr은 수음점 높이(기본 1.5m, 원문 검증 조건).
 * (K3+K4)가 −3dB보다 크지 않으면(즉 ≤−3) 0이에요(원문 p32, "<"지만 경계에서 두 식이 같은 0이라 영향 없음).
 */
export function concaweK5(k3, k4, hs, hr, d) {
  if (k3 + k4 <= -3) return 0;
  if (hs <= 2) return 0;
  const psiDeg = (Math.atan((hs + hr) / d) * 180) / Math.PI;
  return (k3 + k4 + 3) * (gammaFromGraph(psiDeg) - 1);
}

/**
 * 밴드 하나(음원 1개×수음점 1개)의 CONCAWE Lp를 계산해요. D(지향성)=0(원문 권장),
 * K6(차폐)·K7(설비 내부 차폐)=0(추천안 10·11번 — "차폐 미반영(보수적)"·"원문: 예측 불가").
 * d<100m은 계산 안 함(원문 p92 "100m 미만에는 쓰지 말 것"), d>2000m은 2000m로 고정
 * (추천안 1·3번).
 * @returns {{ value: number|null, flags: string[], category?: number }}
 */
export function calcConcaweBand({ concaweData, freqHz, lwDb, d, groundType, dSoftM, tempC, rhPercent, stability, v, hs, hr = 1.5 }) {
  if (d < 100) return { value: null, flags: ["근거리100m미만_계산안함"] };
  const flags = [];
  let dCalc = d;
  if (d > 2000) {
    dCalc = 2000;
    flags.push("거리2000m초과_외삽");
  }
  const k1 = concaweK1(dCalc);
  const { k2, flags: k2Flags } = concaweK2(concaweData, freqHz, tempC, rhPercent, dCalc);
  flags.push(...k2Flags);
  const dSoft = groundType === "soft" ? Math.min(dSoftM ?? dCalc, dCalc) : dCalc;
  const k3 = concaweK3(concaweData, freqHz, groundType, dSoft);
  const category = concaweCategory(stability, v);
  const k4 = concaweK4(concaweData, freqHz, category, dCalc);
  const k5 = concaweK5(k3, k4, hs, hr, dCalc);
  if (category !== 4) flags.push(`기상범주${category}`);
  return { value: lwDb - (k1 + k2 + k3 + k4 + k5), flags: [...flags, "차폐미반영", "설비내부차폐미반영"], category };
}

/**
 * CONCAWE 전체(K1~K7) 시간별 추정 시나리오 — 음원 1개×수음점 1개에 대해 옥타브 7밴드를
 * 전부 계산하고 A가중 로그합까지 끝낸 dB(A)를 돌려줘요(로드맵 §2 계산 순서의 ③④ 단계).
 * 동시 공연 여러 개 합산(②단계)·가동시간 가중(①단계)은 combine.js가 밴드 로그합 전에 해요.
 * @param {{ concaweData: object, spectrumRatiosDb: Record<number,number>|undefined, lwDb: number,
 *   sourceLat: number, sourceLon: number, receiverLat: number, receiverLon: number,
 *   windVecFromDeg: number, wsd10m: number, stability: string,
 *   groundType: "hard"|"soft", dSoftM?: number, tempC: number, rhPercent: number,
 *   hs: number, hr?: number }} p
 *   spectrumRatiosDb가 없으면(음량 스펙트럼 모양 미확보) 계산하지 않아요 — 원문은 "음원은
 *   반드시 옥타브 밴드로 입력, dB(A) 단일값 금지"라서(로드맵 §2), 단일주파수 근사 폴백을
 *   안 둬요(ISO9613 쪽과 다른 점 — CLAUDE.md 규칙 2).
 * @returns {{ value: number|null, flags: string[], scenario: string, category?: number }}
 */
export function calcNoiseConcaweHourly({
  concaweData, spectrumRatiosDb, lwDb,
  sourceLat, sourceLon, receiverLat, receiverLon, windVecFromDeg, wsd10m, stability,
  groundType, dSoftM, tempC, rhPercent, hs, hr = 1.5,
}) {
  const scenario = "CONCAWE_전체_시간별추정";
  if (typeof lwDb !== "number" || !Number.isFinite(lwDb)) return { value: null, flags: ["음원세기미확인"], scenario };
  if (!spectrumRatiosDb) return { value: null, flags: ["옥타브스펙트럼필수_모양미확인"], scenario };

  const geometry = sourceReceiverGeometry({ sourceLat, sourceLon, receiverLat, receiverLon, windVecFromDeg });
  const v = wsd10m * geometry.alignment; // 음원→수음점 쪽 벡터 풍속(+)

  const flagsAll = new Set();
  const bandLevelsDbA = [];
  let category;
  for (const freqHz of CONCAWE_BANDS_HZ) {
    const bandLw = lwDb + (spectrumRatiosDb[freqHz] ?? 0);
    const band = calcConcaweBand({ concaweData, freqHz, lwDb: bandLw, d: geometry.distanceM, groundType, dSoftM, tempC, rhPercent, stability, v, hs, hr });
    band.flags.forEach((f) => flagsAll.add(f));
    if (band.value === null) continue;
    category = band.category;
    bandLevelsDbA.push(band.value + A_WEIGHT_DB[freqHz]);
  }
  if (bandLevelsDbA.length === 0) return { value: null, flags: [...flagsAll], scenario };
  return { value: logSumDb(bandLevelsDbA), flags: [...flagsAll], scenario, category };
}
