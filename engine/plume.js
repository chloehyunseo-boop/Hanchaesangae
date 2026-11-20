// engine/plume.js — 발전차 배출가스 엔진 (하린 라인)
// 가우시안 플룸(ISC3 도시형 확산계수 참고), AP-42 배출계수, NO2 환산.
// 모든 수치·수식의 출처는 docs/발전차_배출가스_가정값과_근거.md(원문 대조 완료)와
// data/assumptions.json의 "배출가스" 항목을 따라요 — 값이 둘에서 다르면 assumptions.json이 코드용 기준.
// 로드맵 2번 "배출가스" 참고. 11/17 1차 작성(M2): 확산·배출량 + 안정도 자동판정
// (NOAA 태양 위치, Turner 표 6-4~6-6, 기본/비교 시나리오)까지 들어 있어요.

import { haversineDistanceM, bearingDeg, windComponentTowardReceiver, WIND_FAN_HALF_WIDTH_DEG } from "./common.js";

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
// 태양 위치: NOAA Solar Calculator의 공개 계산식(Meeus "Astronomical Algorithms" 기반)을 그대로 옮겼어요.
// 출처: NOAA Global Monitoring Laboratory, Solar Calculation Details
//   https://gml.noaa.gov/grad/solcalc/calcdetails.html
// 대기 굴절 보정은 하지 않아요(일사 등급 경계 15°·35°·60° 판정에는 영향이 작음).
// 일출·일몰은 같은 출처의 기준(태양 중심이 지평선 아래 0.833°)을 써요.
const DEG = Math.PI / 180;

/**
 * 태양 적위(도)와 균시차(분)를 계산해요.
 * @param {Date} dateUtc
 */
function solarDeclinationAndEqTime(dateUtc) {
  const jd = dateUtc.getTime() / 86400000 + 2440587.5; // 율리우스일
  const t = (jd - 2451545.0) / 36525.0; // 율리우스 세기
  const l0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  const m = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const c =
    Math.sin(m * DEG) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * m * DEG) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * m * DEG) * 0.000289;
  const omega = 125.04 - 1934.136 * t;
  const lambda = l0 + c - 0.00569 - 0.00478 * Math.sin(omega * DEG);
  const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * DEG);
  const decl = Math.asin(Math.sin(eps * DEG) * Math.sin(lambda * DEG)) / DEG;
  const y = Math.tan((eps / 2) * DEG) ** 2;
  const eqTime =
    4 *
    (y * Math.sin(2 * l0 * DEG) -
      2 * e * Math.sin(m * DEG) +
      4 * e * y * Math.sin(m * DEG) * Math.cos(2 * l0 * DEG) -
      0.5 * y * y * Math.sin(4 * l0 * DEG) -
      1.25 * e * e * Math.sin(2 * m * DEG)) /
    DEG;
  return { decl, eqTime };
}

/**
 * 태양 고도(도). 지평선 위가 양수예요.
 * @param {number} lat 위도(도)
 * @param {number} lon 경도(도, 동경 +)
 * @param {Date} dateUtc
 */
export function solarElevationDeg(lat, lon, dateUtc) {
  const { decl, eqTime } = solarDeclinationAndEqTime(dateUtc);
  const utcMin = dateUtc.getUTCHours() * 60 + dateUtc.getUTCMinutes() + dateUtc.getUTCSeconds() / 60;
  const trueSolarMin = (((utcMin + eqTime + 4 * lon) % 1440) + 1440) % 1440;
  const hourAngle = trueSolarMin / 4 - 180;
  const cosZen =
    Math.sin(lat * DEG) * Math.sin(decl * DEG) + Math.cos(lat * DEG) * Math.cos(decl * DEG) * Math.cos(hourAngle * DEG);
  return 90 - Math.acos(Math.max(-1, Math.min(1, cosZen))) / DEG;
}

/**
 * 그 날의 일출·일몰 시각(UTC Date)을 계산해요. dateUtc에 가장 가까운 남중 시각을 기준으로 해요.
 * @returns {{sunrise: Date, sunset: Date, solarNoon: Date}}
 */
export function sunriseSunset(lat, lon, dateUtc) {
  // 1) dateUtc에 가장 가까운 태양 남중 시각
  const { eqTime } = solarDeclinationAndEqTime(dateUtc);
  const noonMinOfUtcDay = 720 - 4 * lon - eqTime;
  const dayStart = Date.UTC(dateUtc.getUTCFullYear(), dateUtc.getUTCMonth(), dateUtc.getUTCDate());
  let noonMs = dayStart + noonMinOfUtcDay * 60000;
  const diff = dateUtc.getTime() - noonMs;
  if (diff > 12 * 3600000) noonMs += 86400000;
  if (diff < -12 * 3600000) noonMs -= 86400000;
  // 2) 남중 시각의 적위로 일출 시간각 계산 (지평선 아래 0.833°)
  const { decl } = solarDeclinationAndEqTime(new Date(noonMs));
  const cosH =
    Math.cos(90.833 * DEG) / (Math.cos(lat * DEG) * Math.cos(decl * DEG)) - Math.tan(lat * DEG) * Math.tan(decl * DEG);
  const haDeg = Math.acos(Math.max(-1, Math.min(1, cosH))) / DEG;
  return {
    solarNoon: new Date(noonMs),
    sunrise: new Date(noonMs - haDeg * 4 * 60000),
    sunset: new Date(noonMs + haDeg * 4 * 60000),
  };
}

/**
 * Turner 방법의 '밤'인지 판정해요: 일몰 1시간 전 ~ 일출 1시간 후 (표 6-6, p.6-15).
 * @returns {boolean}
 */
export function isTurnerNight(lat, lon, dateUtc) {
  const { sunrise, sunset } = sunriseSunset(lat, lon, dateUtc);
  const t = dateUtc.getTime();
  const dayStart = sunrise.getTime() + 3600000;
  const dayEnd = sunset.getTime() - 3600000;
  return !(t >= dayStart && t < dayEnd);
}

/** 표 6-5(p.6-14): 태양 고도 → 일사 등급(1~4). */
export function insolationClass(elevationDeg) {
  if (elevationDeg > 60) return 4;
  if (elevationDeg > 35) return 3;
  if (elevationDeg > 15) return 2;
  return 1;
}

/** 기상청 단기예보 SKY 코드 → 하늘상태 (1 맑음, 3 구름많음, 4 흐림) */
export function skyCodeToName(code) {
  const map = { 1: "맑음", 3: "구름많음", 4: "흐림" };
  const name = map[Number(code)];
  if (!name) throw new Error(`알 수 없는 SKY 코드: ${code}`);
  return name;
}

/**
 * 기상청 SKY와 시각으로 순복사 지수를 근사해요 (Turner 기반 근사).
 * 근거: data/assumptions.json 배출가스.안정도_Turner기반근사 (SKY매핑_기본 / SKY매핑_비교).
 * - 기본(보수적 근사): 맑음 밤 −2·낮 일사등급, 구름많음 밤 −1·낮 일사등급−1, 흐림 밤 −1·낮 일사등급−2
 * - 비교(민감도 가정): 구름많음 낮 일사등급−2, 흐림이면 낮·밤 0.
 *   원문 표 6-6 1번의 지수 0은 '운량 10/10 + 운고 7,000ft 미만'일 때만이에요. 기상청 '흐림'(9~10할, 운고 없음)이
 *   그 조건이라고 '가정'한 것이지 원문 규칙을 그대로 구현한 게 아니에요. 표 6-4·6-5는 원문 그대로,
 *   표 6-6은 기상청 SKY 기반 근사예요.
 * 수정한 일사등급이 1 미만이면 1로 올려요(표 6-6 3(c)(5)).
 * @param {{sky: "맑음"|"구름많음"|"흐림", lat: number, lon: number, dateUtc: Date,
 *          scenario?: "기본"|"비교", isDaytime?: boolean}} p
 *   isDaytime을 주지 않으면 일출·일몰로 자동 판정해요.
 * @returns {number} 순복사 지수 (4 ~ −2)
 */
export function estimateNetRadiationIndex({ sky, lat, lon, dateUtc, scenario = "기본", isDaytime }) {
  const day = isDaytime ?? !isTurnerNight(lat, lon, dateUtc);
  if (scenario === "비교" && sky === "흐림") return 0;
  if (!day) return sky === "맑음" ? -2 : -1;
  const insolation = insolationClass(solarElevationDeg(lat, lon, dateUtc));
  if (sky === "맑음") return insolation;
  if (sky === "구름많음") return Math.max(1, insolation - (scenario === "비교" ? 2 : 1));
  return Math.max(1, insolation - 2); // 흐림(기본)
}

// 표 6-4(p.6-14) Turner's Key to the P-G Stability Categories.
// 행 = 10m 풍속 구간(m/s 상한, 원문의 노트 단위 구간을 원문이 함께 적은 m/s로),
// 열 = 순복사 지수 [4, 3, 2, 1, 0, −1, −2], 값 = 안정도 번호(1=A … 6=F, 7=G).
// 원문 PDF 화면에서 직접 대조(2026-11-15).
const TURNER_TABLE = [
  { maxWs: 0.7, row: [1, 1, 2, 3, 4, 6, 7] },
  { maxWs: 1.8, row: [1, 2, 2, 3, 4, 6, 7] },
  { maxWs: 2.8, row: [1, 2, 3, 4, 4, 5, 6] },
  { maxWs: 3.3, row: [2, 2, 3, 4, 4, 5, 6] },
  { maxWs: 3.8, row: [2, 2, 3, 4, 4, 4, 5] },
  { maxWs: 4.8, row: [2, 3, 3, 4, 4, 4, 5] },
  { maxWs: 5.4, row: [3, 3, 4, 4, 4, 4, 5] },
  { maxWs: 5.9, row: [3, 3, 4, 4, 4, 4, 4] },
  { maxWs: Infinity, row: [3, 4, 4, 4, 4, 4, 4] },
];
const STABILITY_LETTER = { 1: "A", 2: "B", 3: "C", 4: "D", 5: "E", 6: "F", 7: "F" }; // 6·7은 F로 합침(원문 주)

/**
 * 순복사 지수 + 10m 풍속 → 안정도(A~F). EPA 기상관측지침 표 6-4.
 * 기상청 풍속은 0.1m/s 단위라 원문 구간 사이(예: 0.7과 0.8 사이)의 값은 상한 기준으로 처리해요.
 * @param {{netRadiationIndex: number, wsd10m: number}} p
 * @returns {StabilityClass}
 */
export function estimateStabilityClass({ netRadiationIndex, wsd10m }) {
  if (typeof wsd10m !== "number" || !Number.isFinite(wsd10m) || wsd10m < 0) throw new Error(`풍속은 0 이상의 숫자여야 해요: ${wsd10m}`);
  const col = 4 - netRadiationIndex; // 4→0, 3→1, … −2→6
  if (!(col >= 0 && col <= 6 && Number.isInteger(col))) throw new Error(`순복사 지수 범위 밖: ${netRadiationIndex}`);
  const ws = Math.round(wsd10m * 10) / 10;
  const r = TURNER_TABLE.find((r) => ws <= r.maxWs);
  return STABILITY_LETTER[r.row[col]];
}

/**
 * 예보 한 시각의 값으로 안정도를 한 번에 구해요 (안정도 판정에는 10m 풍속을 그대로 써요).
 * @param {{sky: "맑음"|"구름많음"|"흐림", wsd10m: number, lat: number, lon: number, dateUtc: Date, scenario?: "기본"|"비교"}} p
 * @returns {{stability: StabilityClass, netRadiationIndex: number, solarElevation: number, isNight: boolean}}
 */
export function stabilityFromForecast({ sky, wsd10m, lat, lon, dateUtc, scenario = "기본" }) {
  if (!(dateUtc instanceof Date) || Number.isNaN(dateUtc.getTime())) throw new Error(`시각이 올바르지 않아요: ${dateUtc}`);
  if (!["맑음", "구름많음", "흐림"].includes(sky)) throw new Error(`하늘상태는 맑음·구름많음·흐림: ${sky}`);
  const isNight = isTurnerNight(lat, lon, dateUtc);
  const netRadiationIndex = estimateNetRadiationIndex({ sky, lat, lon, dateUtc, scenario, isDaytime: !isNight });
  return {
    stability: estimateStabilityClass({ netRadiationIndex, wsd10m }),
    netRadiationIndex,
    solarElevation: solarElevationDeg(lat, lon, dateUtc),
    isNight,
  };
}

// ---------------------------------------------------------------------------
// 농도 환산 기준 — 가정값 문서 "농도 환산과 기준" 표
// ---------------------------------------------------------------------------
const NO2_HOURLY_STANDARD_PPM = 0.1; // 환경정책기본법 시행령 별표 1
const LEVEL_PPM = { 강: 0.05, 중: 0.01, 약: 0.002 }; // 위 기준의 50%·10%·2% (CLAUDE.md 6번)

/** ppm = mg/m³ × 24.45 / 46.0055 (25℃, 1기압 표준 환산식 — 실제 기온·기압이 아닌 표준 조건 환산값) */
function mgPerM3ToPpm(mgPerM3) {
  return (mgPerM3 * 24.45) / 46.0055;
}

/** CLAUDE.md 6번: NO2 1시간 기준(0.10ppm) 대비 강 50%↑ · 중 10~50% · 약 2~10% */
export function classifyExhaustLevel(ppm) {
  // 나눗셈(0.01/0.1 = 0.0999…) 대신 ppm 경계값을 직접 비교해요(부동소수점 오차로 단계가 바뀌지 않게).
  // 경계: 0.10ppm의 50% = 0.05, 10% = 0.01, 2% = 0.002
  if (!Number.isFinite(ppm) || ppm < 0) return null;
  if (ppm >= LEVEL_PPM.강) return "강";
  if (ppm >= LEVEL_PPM.중) return "중";
  if (ppm >= LEVEL_PPM.약) return "약";
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
 * @param {import("./plume.js").StabilityClass} p.stability  안정도 등급(A~F) — stabilityFromForecast()로 구해서 넣어요
 * @param {number} p.wsd10m  기상청 10m 풍속(m/s)
 * @param {number} p.windVecFromDeg  기상청 VEC(바람이 불어오는 방향, 0=북)
 * @param {"확인"|"시연용가정"} [p.정보출처]  발전차 사양 출처. "시연용가정"이면 flags에 표시
 * @returns {{value: number|null, flags: string[], scenario: string, reason?: string}}  value가 null이면 계산 불가(flags에 "계산불가", reason에 이유) — 0ppm과 구분해요
 */
/**
 * 확산 계산 입력이 물리적으로 말이 되는지 확인해요. 문제가 있으면 이유(문자열), 없으면 null.
 */
export function validatePlumeInput({ sourceLat, sourceLon, receiverLat, receiverLon, enginePowerKW, loadFactor, stability, wsd10m, windVecFromDeg }) {
  const finite = (v) => typeof v === "number" && Number.isFinite(v);
  for (const [k, v] of Object.entries({ sourceLat, receiverLat })) if (!finite(v) || v < -90 || v > 90) return `${k} 범위 밖: ${v}`;
  for (const [k, v] of Object.entries({ sourceLon, receiverLon })) if (!finite(v) || v < -180 || v > 180) return `${k} 범위 밖: ${v}`;
  if (!finite(enginePowerKW) || enginePowerKW <= 0) return `엔진 출력은 0보다 커야 해요: ${enginePowerKW}`;
  if (!finite(loadFactor) || loadFactor <= 0 || loadFactor > 1) return `부하율은 0 초과 1 이하: ${loadFactor}`;
  if (!finite(wsd10m) || wsd10m < 0) return `풍속은 0 이상: ${wsd10m}`;
  if (!finite(windVecFromDeg) || windVecFromDeg < 0 || windVecFromDeg > 360) return `풍향은 0~360: ${windVecFromDeg}`;
  if (!["A", "B", "C", "D", "E", "F"].includes(stability)) return `안정도는 A~F: ${stability}`;
  return null;
}

/**
 * 지면 배출(H=0)·지면 수용점(z=0) 가우시안 플룸 농도 (g/m³).
 * Turner(1970) 워크북 식 (3.4)에 옆 방향 항을 곱한 형태: χ = Q/(π σy σz u) · exp(−y²/2σy²).
 * 확산폭(σ)을 밖에서 받게 따로 떼어 둔 이유: 교재 예제의 σ를 그대로 넣어 식 자체를 검증하려고요
 * (validation/plume_turner_test.mjs).
 * @param {{qGPerS:number, u:number, sigmaY:number, sigmaZ:number, y?:number}} p
 */
export function gaussianGroundLevelConc({ qGPerS, u, sigmaY, sigmaZ, y = 0 }) {
  return (qGPerS / (Math.PI * u * sigmaY * sigmaZ)) * Math.exp(-(y ** 2) / (2 * sigmaY ** 2));
}

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

  // 입력 검증: 잘못된 입력이 0ppm(=영향 없음)으로 둔갑하지 않게 value를 null로 돌려줘요.
  const bad = validatePlumeInput({ sourceLat, sourceLon, receiverLat, receiverLon, enginePowerKW, loadFactor, stability, wsd10m, windVecFromDeg });
  if (bad) return { value: null, flags: [...flags, "계산불가"], scenario, reason: bad };

  // 약풍: 10m 풍속 1m/s 미만이면 지도에 그리지 않아요(가정값 문서 "확산" 절).
  // 계산을 안 한 것이라 0(영향 없음)이 아니라 null이에요(common.js OutputCell 규칙).
  if (wsd10m < 1.0) {
    return { value: null, flags: [...flags, "약풍미표시"], scenario, reason: "10m 풍속 1m/s 미만" };
  }

  const distance = haversineDistanceM(sourceLat, sourceLon, receiverLat, receiverLon);
  const bearingSR = bearingDeg(sourceLat, sourceLon, receiverLat, receiverLon);
  const { diffDeg } = windComponentTowardReceiver(windVecFromDeg, bearingSR);
  const theta = (diffDeg * Math.PI) / 180;
  const x = distance * Math.cos(theta); // 풍하 거리
  const y = distance * Math.sin(theta); // 풍축에서 옆으로 벗어난 거리

  if (distance < 1) {
    // 음원과 같은 자리: 식이 정의되지 않아요(ISC3도 1m 이내 수용점은 계산하지 않음). 0이 아니라 계산 불가예요.
    return { value: null, flags: [...flags, "계산불가"], scenario, reason: "음원 위치" };
  }
  if (x <= 0) {
    // 수음점이 풍상측(바람이 불어오는 쪽)이라 플룸이 거기로 안 가요.
    return { value: 0, flags, scenario };
  }
  // ISC3 지침 p.1-16: 100m 미만 수용점은 의심스러울 수 있음. 확산폭이 풍하 거리 x로 정해지므로 x 기준으로 봐요.
  if (x < 100) flags.push("근거리불확실");

  const sigmaY = DISPERSION[stability].sigmaY(x);
  const sigmaZ = DISPERSION[stability].sigmaZ(x);
  const u = advectionWindSpeed(wsd10m, stability);

  const qNo2GPerS = no2EmissionRateGPerS(enginePowerKW, loadFactor);
  const concGPerM3 = gaussianGroundLevelConc({ qGPerS: qNo2GPerS, u, sigmaY, sigmaZ, y });
  const ppm = mgPerM3ToPpm(concGPerM3 * 1000);

  return { value: ppm, flags, scenario };
}

// ---------------------------------------------------------------------------
// 한 수음점의 최종값 — 발전차 여러 대 합산 + 풍향 불확실성 부채꼴
// ---------------------------------------------------------------------------
/**
 * 한 수음점에 대해 발전차 여러 대의 NO2 기여를 더하고, 풍향 예보 오차를 고려해
 * 예보 풍향 ±fanHalfWidthDeg 안에서 합계가 가장 큰 값을 돌려줘요.
 * - 여러 대: 대수를 곱하지 않고 한 대씩 계산해 더해요(가정값 문서 '배출량').
 * - 부채꼴: 같은 시각엔 모든 발전차에 같은 바람이 분다고 보고, 방향을 함께 돌려 가며 합계를 구해요.
 *   폭은 common.js WIND_FAN_HALF_WIDTH_DEG(임시 22.5°, 11/27 예보-AWS 비교로 교체 예정). 0이면 예보 방향만.
 *   간격은 fanStepDeg 그대로 쓰고, 마지막에 ±반폭 끝 방향을 꼭 넣어요(이산 탐색이라 연속 구간의 정확한 최대는 아님).
 * - 결과 해석: value는 '예보 풍향 오차 범위(±반폭) 안의 최대 추정 농도'예요. 실제 풍향이 그 방향이었다는 뜻이 아니에요.
 * - 전제조건: generators에는 그 시각에 가동 중이고 가동 시간 출처가 '미확인'이 아닌 발전차만 넣어요
 *   (시간 필터는 호출하는 쪽 — combine.js — 이 해요. common.js SourceSpec 규칙).
 * - 출력종류가 "엔진"이 아니면(전기·미확인·빈칸) 계산은 하되 flags에 '엔진출력미확인'을 붙여요
 *   (배출계수는 엔진 기계 출력 기준. 가정값 문서 '배출량' 표).
 * @param {Object} p
 * @param {{lat:number, lon:number, 엔진출력_kW:number, 출력종류?:"엔진"|"전기"|"미확인", loadFactor?:number, 정보출처?:"확인"|"시연용가정"}[]} p.generators
 * @param {number} p.receiverLat
 * @param {number} p.receiverLon
 * @param {StabilityClass} p.stability
 * @param {number} p.wsd10m
 * @param {number} p.windVecFromDeg
 * @param {number} [p.fanHalfWidthDeg]  0 이상 180 이하
 * @param {number} [p.fanStepDeg]  0 초과
 * @returns {{value: number|null, flags: string[], scenario: string, reason?: string, centerValue: number|null, maxAtOffsetDeg: number|null}}
 */
export function calcExhaustAtReceiver({
  generators, receiverLat, receiverLon, stability, wsd10m, windVecFromDeg,
  fanHalfWidthDeg = WIND_FAN_HALF_WIDTH_DEG, fanStepDeg = 2.5,
}) {
  const scenario = "가우시안플룸_지면배출_ISC3도시형확산계수_풍향부채꼴최대";
  const fail = (reason, flags = []) => ({
    value: null, flags: [...new Set([...flags, "계산불가"])], scenario, reason, centerValue: null, maxAtOffsetDeg: null,
  });
  const finite = (v) => typeof v === "number" && Number.isFinite(v);
  // 부하율을 안 넣었을 때(undefined)만 기본 100%. null은 '잘못된 입력'으로 검증에서 걸러요.
  const loadOf = (g) => (g.loadFactor === undefined ? 1.0 : g.loadFactor);

  // 1) 공통 입력을 부채꼴로 돌리기 '전에' 검증해요(예: 361°가 1°로 바뀌어 통과하는 것 방지).
  if (!finite(fanHalfWidthDeg) || fanHalfWidthDeg < 0 || fanHalfWidthDeg > 180) return fail(`부채꼴 반폭은 0~180°: ${fanHalfWidthDeg}`);
  if (!finite(fanStepDeg) || fanStepDeg <= 0) return fail(`부채꼴 간격은 0보다 커야 해요: ${fanStepDeg}`);
  // 간격이 너무 작으면(예: 1e-20) 반복이 끝나지 않거나 지나치게 길어져요. 방향 수 상한을 둬요.
  const MAX_FAN_DIRECTIONS = 1000;
  if (fanHalfWidthDeg > 0 && (2 * fanHalfWidthDeg) / fanStepDeg + 3 > MAX_FAN_DIRECTIONS) {
    return fail(`부채꼴 방향 수가 너무 많아요(반폭 ${fanHalfWidthDeg}°, 간격 ${fanStepDeg}° → 상한 ${MAX_FAN_DIRECTIONS}개)`);
  }
  if (!Array.isArray(generators) || generators.length === 0) return fail("발전차 없음");

  // 발전차 정보에서 오는 꼬리표는 검증에 실패해도 남겨요(읽을 수 있는 원소만 안전하게 읽어요).
  const baseFlags = new Set();
  for (const g of generators) {
    if (!g || typeof g !== "object") continue;
    if (g.정보출처 === "시연용가정") baseFlags.add("시연용가정");
    if (g.출력종류 !== "엔진") baseFlags.add("엔진출력미확인");
  }
  const failKeep = (reason) => fail(reason, [...baseFlags]);
  for (let i = 0; i < generators.length; i++) {
    const g = generators[i];
    if (!g || typeof g !== "object") return failKeep(`발전차 ${i + 1}번 정보가 비어 있어요`);
    const bad = validatePlumeInput({
      sourceLat: g.lat, sourceLon: g.lon, receiverLat, receiverLon, enginePowerKW: g.엔진출력_kW,
      loadFactor: loadOf(g), stability, wsd10m, windVecFromDeg,
    });
    if (bad) return failKeep(`발전차 ${i + 1}번: ${bad}`);
  }

  // 3) 오프셋: −반폭부터 fanStepDeg 간격, 끝(+반폭)은 꼭 포함
  const offsets = [];
  if (fanHalfWidthDeg === 0) offsets.push(0);
  else {
    for (let o = -fanHalfWidthDeg; o < fanHalfWidthDeg - 1e-9; o += fanStepDeg) offsets.push(Math.round(o * 1e9) / 1e9);
    offsets.push(fanHalfWidthDeg);
    if (!offsets.some((o) => Math.abs(o) < 1e-9)) offsets.push(0); // 예보 방향(중심)은 항상 계산
    offsets.sort((a, b) => a - b);
  }

  let best = null;
  let center = null;
  for (const off of offsets) {
    const vec = (((windVecFromDeg + off) % 360) + 360) % 360;
    let total = 0;
    const flags = new Set(baseFlags);
    for (const g of generators) {
      const r = calcExhaustGaussianPlume({
        sourceLat: g.lat, sourceLon: g.lon, receiverLat, receiverLon,
        enginePowerKW: g.엔진출력_kW, loadFactor: loadOf(g),
        stability, wsd10m, windVecFromDeg: vec, 정보출처: g.정보출처,
      });
      // 약풍·음원 위치 등으로 한 대라도 null이면 합계를 낼 수 없어요. 그때까지의 꼬리표도 함께 돌려줘요.
      if (r.value === null) {
        const keep = [...flags, ...r.flags];
        return r.flags.includes("약풍미표시")
          ? { value: null, flags: [...new Set(keep)], scenario, reason: r.reason, centerValue: null, maxAtOffsetDeg: null }
          : fail(r.reason, keep);
      }
      total += r.value;
      r.flags.forEach((f) => flags.add(f));
    }
    if (Math.abs(off) < 1e-9) center = total;
    if (best === null || total > best.total) best = { total, flags, off };
  }
  const flags = [...best.flags];
  if (fanHalfWidthDeg > 0) flags.push("풍향부채꼴최대");
  return { value: best.total, flags, scenario, centerValue: center, maxAtOffsetDeg: best.off };
}
