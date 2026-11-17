// engine/plume.js — 발전차 배출가스 엔진 (하린 라인)
// 가우시안 플룸(ISC3 도시형 확산계수 참고), AP-42 배출계수, NO2 환산.
// 모든 수치·수식의 출처는 발전차_배출가스_가정값과_근거.md(2026-11-15, 하린, 원문 대조 완료)를 따라요.
// 로드맵 2번 "배출가스" 참고. 11/17 1차 작성(M2) — 안정도 등급 자동판정의 마지막 단계
// (풍속×순복사지수 → A~F, EPA 기상관측지침 표 6-4)는 그 표의 실제 풍속 구간 값을
// 아직 원문에서 확인 못해서 비워뒀어요(아래 estimateNetRadiationIndex 설명 참고).

import { haversineDistanceM, bearingDeg, windComponentTowardReceiver } from "./common.js";

// ---------------------------------------------------------------------------
// 배출계수 (AP-42, 평균값) — 가정값 문서 "배출량" 표
// ---------------------------------------------------------------------------
const KW_PER_HP = 0.745699872; // 표준 환산 (1hp = 0.745699872kW)

/**
 * 엔진 출력(kW)에 맞는 NOx 배출계수(g/kWh, AP-42 평균값)를 돌려줘요.
 * 600hp 경계로 나뉘어요(kW를 hp로 바꿔서 비교 — 447kW 같은 반올림 값 쓰지 않음).
 * @param {number} enginePowerKW 엔진 출력(기계 출력. 발전기 kWe 아님)
 * @returns {number} g/kWh
 */
export function noxEmissionFactorGPerKWh(enginePowerKW) {
  const hp = enginePowerKW / KW_PER_HP;
  return hp <= 600 ? 18.8 : 14.6; // AP-42 3.3절(표 3.3-1) / 3.4절(표 3.4-1)
}

const NO2_NOX_RATIO = 0.9; // EPA AERMOD NO2 기술문서 4.1절(ARM2 기본범위 0.5~0.9의 상한)

/**
 * 발전차 한 대의 NO2 배출률(g/s)을 계산해요.
 * 발전차가 여러 대면 이 함수를 대당 따로 불러서, 농도를 나중에 더해요(대수를 곱해 합치지 않음).
 * @param {number} enginePowerKW
 * @param {number} loadFactor 부하율(기본 1.0 = 100% 가정. 민감도는 0.5·0.75)
 * @returns {number} g/s
 */
export function no2EmissionRateGPerS(enginePowerKW, loadFactor = 1.0) {
  const noxGPerH = noxEmissionFactorGPerKWh(enginePowerKW) * enginePowerKW * loadFactor;
  return (noxGPerH * NO2_NOX_RATIO) / 3600;
}

// ---------------------------------------------------------------------------
// 확산계수 (ISC3 도시형, Briggs 참고) — 가정값 문서 "확산" 표
// ---------------------------------------------------------------------------
/** @typedef {"A"|"B"|"C"|"D"|"E"|"F"} StabilityClass */

const DISPERSION = {
  A: { sigmaY: (x) => 0.32 * x * (1 + 0.0004 * x) ** -0.5, sigmaZ: (x) => 0.24 * x * (1 + 0.001 * x) ** 0.5, p: 0.15 },
  B: { sigmaY: (x) => 0.32 * x * (1 + 0.0004 * x) ** -0.5, sigmaZ: (x) => 0.24 * x * (1 + 0.001 * x) ** 0.5, p: 0.15 },
  C: { sigmaY: (x) => 0.22 * x * (1 + 0.0004 * x) ** -0.5, sigmaZ: (x) => 0.20 * x, p: 0.20 },
  D: { sigmaY: (x) => 0.16 * x * (1 + 0.0004 * x) ** -0.5, sigmaZ: (x) => 0.14 * x * (1 + 0.0003 * x) ** -0.5, p: 0.25 },
  E: { sigmaY: (x) => 0.11 * x * (1 + 0.0004 * x) ** -0.5, sigmaZ: (x) => 0.08 * x * (1 + 0.0015 * x) ** -0.5, p: 0.30 },
  F: { sigmaY: (x) => 0.11 * x * (1 + 0.0004 * x) ** -0.5, sigmaZ: (x) => 0.08 * x * (1 + 0.0015 * x) ** -0.5, p: 0.30 },
};

/**
 * 기상청 10m 풍속을 2m(이류 풍속) 높이로 보정해요. 최소 1m/s(배출 높이 0m일 때
 * 보정식을 그대로 쓰면 풍속이 0이 돼 계산이 깨지는 걸 막아요).
 * @param {number} wsd10m
 * @param {StabilityClass} stability
 */
export function advectionWindSpeed(wsd10m, stability) {
  const u2 = wsd10m * (2 / 10) ** DISPERSION[stability].p;
  return Math.max(u2, 1.0);
}

// ---------------------------------------------------------------------------
// 대기 안정도 — 가정값 문서 "대기 안정도" 표 (Turner 기반 근사)
// ---------------------------------------------------------------------------
/**
 * 태양 고도(도)를 공개된 적위·시간각 공식으로 근사해요. 맑은 낮의 일사 등급에만 써요.
 * 시간대 보정은 생략했어요(경도로 근사) — 올림픽공원처럼 좁은 범위에선 영향이 작아요.
 */
export function solarElevationDeg(lat, lon, dateUtc) {
  const dayOfYear = Math.floor((dateUtc - Date.UTC(dateUtc.getUTCFullYear(), 0, 0)) / 86400000);
  const decl = 23.45 * Math.sin((Math.PI / 180) * (360 / 365) * (284 + dayOfYear));
  const solarTimeHr = dateUtc.getUTCHours() + dateUtc.getUTCMinutes() / 60 + lon / 15;
  const hourAngle = 15 * (solarTimeHr - 12);
  const toRad = (deg) => (deg * Math.PI) / 180;
  const sinAlt =
    Math.sin(toRad(lat)) * Math.sin(toRad(decl)) +
    Math.cos(toRad(lat)) * Math.cos(toRad(decl)) * Math.cos(toRad(hourAngle));
  return (Math.asin(Math.max(-1, Math.min(1, sinAlt))) * 180) / Math.PI;
}

/** 표 6-5(p.6-14): 태양 고도 → 일사 등급(1~4). 맑은 낮에만 써요. */
export function insolationClass(elevationDeg) {
  if (elevationDeg > 60) return 4;
  if (elevationDeg > 35) return 3;
  if (elevationDeg > 15) return 2;
  return 1;
}

/**
 * 기상청 SKY(맑음/구름많음/흐림)·낮밤으로 순복사 지수를 근사해요(표 6-6, '기본' 보수적 근사).
 * 비교 시나리오(낮 구름많음 −2, 흐림 0)는 아직 안 붙였어요.
 * @param {{sky: "맑음"|"구름많음"|"흐림", isDaytime: boolean, lat: number, lon: number, dateUtc: Date}} p
 * @returns {number} 순복사 지수
 */
export function estimateNetRadiationIndex({ sky, isDaytime, lat, lon, dateUtc }) {
  if (sky === "맑음") return isDaytime ? insolationClass(solarElevationDeg(lat, lon, dateUtc)) : -2;
  if (sky === "구름많음") return -1;
  return isDaytime ? -2 : -1; // 흐림
}

/**
 * 순복사 지수 + 10m 풍속으로 안정도 등급(A~F)을 정해요 — EPA 기상관측지침 표 6-4(p.6-14).
 * 11/17 기준: 이 표의 정확한 풍속 구간 경계값을 원문에서 아직 확인 못해서 미구현이에요.
 * (CLAUDE.md 규칙 2 — 확인 안 된 숫자를 지어내지 않음). 표를 직접 보고 채워주세요.
 * @returns {StabilityClass}
 */
export function estimateStabilityClass(/* { netRadiationIndex, wsd10m } */) {
  throw new Error(
    "미구현 — EPA 기상관측지침 표 6-4(풍속×순복사지수 → A~F)의 정확한 구간값 확인 필요. " +
      "확인 전까지는 calcExhaustGaussianPlume()에 stability를 직접 넣어서 써요."
  );
}

// ---------------------------------------------------------------------------
// 농도 환산 기준 — 가정값 문서 "농도 환산과 기준" 표
// ---------------------------------------------------------------------------
const NO2_HOURLY_STANDARD_PPM = 0.1; // 환경정책기본법 시행령 별표 1

/** ppm = mg/m³ × 24.45 / 46.0055 (25℃, 1기압 표준 환산식) */
function mgPerM3ToPpm(mgPerM3) {
  return (mgPerM3 * 24.45) / 46.0055;
}

/** CLAUDE.md 6번: NO2 1시간 기준(0.10ppm) 대비 강 50%↑ · 중 10~50% · 약 2~10% */
export function classifyExhaustLevel(ppm) {
  const ratio = ppm / NO2_HOURLY_STANDARD_PPM;
  if (ratio >= 0.5) return "강";
  if (ratio >= 0.1) return "중";
  if (ratio >= 0.02) return "약";
  return null;
}

// ---------------------------------------------------------------------------
// 메인 계산 — 가우시안 플룸 (지면 배출, 지면 수음점, plume rise 미적용)
// ---------------------------------------------------------------------------
/**
 * 발전차 한 대가 한 수음점에 주는 NO2 기여 농도(ppm)를 계산해요.
 * @param {Object} p
 * @param {number} p.sourceLat  발전차 위도
 * @param {number} p.sourceLon  발전차 경도
 * @param {number} p.receiverLat  수음점 위도
 * @param {number} p.receiverLon  수음점 경도
 * @param {number} p.enginePowerKW  발전차 엔진 출력
 * @param {number} [p.loadFactor]  부하율 (기본 1.0)
 * @param {import("./plume.js").StabilityClass} p.stability  안정도 등급(A~F) — 지금은 직접 넣어요
 * @param {number} p.wsd10m  기상청 10m 풍속(m/s)
 * @param {number} p.windVecFromDeg  기상청 VEC(바람이 불어오는 방향, 0=북)
 * @param {"확인"|"시연용가정"} [p.정보출처]  발전차 사양 출처. "시연용가정"이면 flags에 표시
 * @returns {{value: number, flags: string[], scenario: string}}
 */
export function calcExhaustGaussianPlume({
  sourceLat,
  sourceLon,
  receiverLat,
  receiverLon,
  enginePowerKW,
  loadFactor = 1.0,
  stability,
  wsd10m,
  windVecFromDeg,
  정보출처,
}) {
  const scenario = "가우시안플룸_지면배출_ISC3도시형확산계수";
  const flags = [];
  if (정보출처 === "시연용가정") flags.push("시연용가정");

  // 약풍: 10m 풍속 1m/s 미만이면 지도에 그리지 않아요(가정값 문서 "확산" 절).
  if (wsd10m < 1.0) {
    return { value: 0, flags: [...flags, "약풍미표시"], scenario };
  }

  const distance = haversineDistanceM(sourceLat, sourceLon, receiverLat, receiverLon);
  const bearingSR = bearingDeg(sourceLat, sourceLon, receiverLat, receiverLon);
  const { diffDeg } = windComponentTowardReceiver(windVecFromDeg, bearingSR);
  const theta = (diffDeg * Math.PI) / 180;
  const x = distance * Math.cos(theta); // 풍하 거리
  const y = distance * Math.sin(theta); // 풍축에서 옆으로 벗어난 거리

  if (x <= 0) {
    // 수음점이 풍상측(바람이 불어오는 쪽)이라 플룸이 거기로 안 가요.
    return { value: 0, flags, scenario };
  }
  if (distance < 100) flags.push("근거리불확실"); // ISC3 지침 p.1-16: 100m 미만 수용점은 의심스러울 수 있음

  const sigmaY = DISPERSION[stability].sigmaY(x);
  const sigmaZ = DISPERSION[stability].sigmaZ(x);
  const u = advectionWindSpeed(wsd10m, stability);

  const qNo2GPerS = no2EmissionRateGPerS(enginePowerKW, loadFactor);
  const concGPerM3 =
    (qNo2GPerS / (Math.PI * u * sigmaY * sigmaZ)) * Math.exp(-(y ** 2) / (2 * sigmaY ** 2));
  const ppm = mgPerM3ToPpm(concGPerM3 * 1000);

  return { value: ppm, flags, scenario };
}
