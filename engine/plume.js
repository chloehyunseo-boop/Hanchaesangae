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
 * @param {number} loadFactor 부하율(이 함수의 기본 1.0 = 기존입력가정용. 지도 기본 계산(calcExhaustAtReceiver "기본추정")은 0.43)
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
  // 좌표가 NaN이면 태양 고도가 NaN → 일사 등급이 기본값으로 떨어져 그럴듯한 안정도가 나와요. 미리 막아요(11/21 코드 검토).
  if (typeof lat !== "number" || !Number.isFinite(lat) || lat < -90 || lat > 90) throw new Error(`위도 범위 밖: ${lat}`);
  if (typeof lon !== "number" || !Number.isFinite(lon) || lon < -180 || lon > 180) throw new Error(`경도 범위 밖: ${lon}`);
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
// 기존 단일 계산 — 가우시안 플룸 (지면 배출, 지면 수음점, plume rise 미적용). "기존입력가정"·회귀 테스트용. 지도 기본은 아래 calcExhaustAtReceiver
// ---------------------------------------------------------------------------
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
// 시나리오(가정 묶음) — 11/21 변경안 docs/배출가스_기본추정_변경_적용본.md, 검토 2회 반영
// ---------------------------------------------------------------------------
// "기본추정"       : 부하율 0.43(EPA NONROAD 기본값) · ARM2 · 배기구 높이 · 개방된 곳만 Briggs 연기 상승
// "기존입력가정"   : 11/21 이전 그대로(부하율 1.0 · NO2/NOx 0.9 · 배출 높이 0m · 2m 풍속). 비교·회귀 테스트용
// "연기상승제외"   : 기본추정에서 모든 발전차의 연기 상승을 뺀 민감도(배기구 높이는 유지)
// "전량NO2"        : 기본추정에서 NO2/NOx = 1.0으로 둔 민감도(배출 초기 NO2 비율이 높을 가능성 대비)
// 어느 것도 건물 후류(다운워시)를 계산하지 않아요. '최악'이라고 부르지 않아요.
export const EXHAUST_ASSUMPTIONS = ["기본추정", "기존입력가정", "연기상승제외", "전량NO2"];

// EPA420-P-04-005(NR-005c, 2004.4.) 부록 표 "Load Factor and Activity Estimates in Draft NONROAD2004",
// SCC 2270006005 Diesel Light Commercial Generator Sets = 0.43. 실측 부하율이 아니라 모델 기본값.
export const DEFAULT_LOAD_FACTOR_NONROAD = 0.43;

// 배기 사양을 모를 때 쓰는 가정값(정격 출력 기준 스펙시트 값 — 부분 부하 배기 아님).
// 높이: 렌탈 발전기 전체 높이 중 가장 낮은 값(Generac MDE570 트레일러 3.0m). 실제 배기구 높이 아님(가정).
// 온도·배기량: 4종 중 배기량이 가장 작은 Cat XQ570 prime 정격(472℃, 86.7 m³/min).
export const DEFAULT_EXHAUST = { 배기구높이_m: 3.0, 배기온도_C: 472, 배기량_m3_per_min: 86.7 };

const G = 9.81; // m/s² (ISC3 2권 식 1-8의 g)

/**
 * 배출 높이의 풍속 (ISC3 2권 식 1-6 거듭제곱 법칙, 도시형 지수 p, 최소 1.0 m/s).
 * h가 0 이하면 기존처럼 2m를 기준 높이로 써요(advectionWindSpeed와 같음).
 */
export function windSpeedAtHeight(wsd10m, stability, h) {
  const href = h > 0 ? h : 2;
  return Math.max(wsd10m * (href / 10) ** DISPERSION[stability].p, 1.0);
}

/** 부력 플럭스 F_b (m⁴/s³). ISC3 2권 식 1-8: g·v_s·d_s²·ΔT/(4T_s) = g·V·ΔT/(π·T_s), V = 배기량(m³/s) */
export function buoyancyFlux({ 배기온도_C, 배기량_m3_per_min, 대기온도_C }) {
  const Ts = 배기온도_C + 273.15, Ta = 대기온도_C + 273.15;
  const dT = Ts - Ta;
  if (dT <= 0) return 0;
  return (G * (배기량_m3_per_min / 60) * dT) / (Math.PI * Ts);
}

/**
 * 부력 지배 여부 (ISC3 2권 1.1.4.3·1.1.4.7, 원문 p.1-8~1-11). ΔT ≥ (ΔT)_c 이면 부력 지배.
 * - A~D: F_b<55 → (ΔT)_c = 0.0297·T_s·v_s^(1/3)/d_s^(2/3) (식 1-10), F_b≥55 → 0.00575·T_s·v_s^(2/3)/d_s^(1/3) (식 1-11)
 * - E·F: (ΔT)_c = 0.019582·T_s·v_s·√s (식 1-18)
 * v_s = 배기량/(π d_s²/4). 배기구 지름이 없으면 판정할 수 없어서 null을 돌려줘요.
 * @returns {boolean|null}
 */
export function isBuoyancyDominated({ 배기온도_C, 배기량_m3_per_min, 배기구지름_m, 대기온도_C, stability, Fb }) {
  if (!(배기구지름_m > 0)) return null;
  const Ts = 배기온도_C + 273.15, Ta = 대기온도_C + 273.15, dT = Ts - Ta;
  if (dT <= 0) return false;
  const vs = (배기량_m3_per_min / 60) / ((Math.PI * 배기구지름_m ** 2) / 4);
  let dTc;
  if (stability === "E" || stability === "F") {
    const s = (G * (stability === "E" ? 0.020 : 0.035)) / Ta;
    dTc = 0.019582 * Ts * vs * Math.sqrt(s);
  } else if (Fb < 55) dTc = (0.0297 * Ts * vs ** (1 / 3)) / 배기구지름_m ** (2 / 3);
  else dTc = (0.00575 * Ts * vs ** (2 / 3)) / 배기구지름_m ** (1 / 3);
  return dT >= dTc;
}

/**
 * Briggs 부력 연기 상승 Δh(m). ISC3 2권(HWIR99판) 1.1.4절.
 * - A~D 최종 상승: F_b<55 → 21.425·F_b^(3/4)/u_s (식 1-14), F_b≥55 → 38.71·F_b^(3/5)/u_s (식 1-15)
 *   최종 상승 거리 x_f: F_b<55 → 49·F_b^(5/8) (1-12), F_b≥55 → 119·F_b^(2/5) (1-13)
 * - E·F 최종 상승: 2.6·(F_b/(u_s·s))^(1/3) (식 1-20), s = g·(∂θ/∂z)/T_a (1-17), ∂θ/∂z E 0.020·F 0.035 K/m
 *   x_f = 2.0715·u_s/√s (1-19)
 * - x < x_f: 점진 상승 1.60·F_b^(1/3)·x^(2/3)/u_s (식 1-22), 최종 상승을 넘으면 최종 상승
 * 부력 지배만 다뤄요(운동량 상승 식 1-16·1-21 미사용 — 배기구 지름 정보 없음, 검토 문서 2-③).
 * @returns {{dh:number, final:number, xf:number}}
 */
export function briggsBuoyantRise({ Fb, us, stability, 대기온도_C, x }) {
  if (!(Fb > 0)) return { dh: 0, final: 0, xf: 0 };
  let final, xf;
  if (stability === "E" || stability === "F") {
    const s = (G * (stability === "E" ? 0.020 : 0.035)) / (대기온도_C + 273.15);
    final = 2.6 * Math.cbrt(Fb / (us * s));
    xf = (2.0715 * us) / Math.sqrt(s);
  } else if (Fb < 55) {
    final = (21.425 * Fb ** 0.75) / us;
    xf = 49 * Fb ** (5 / 8);
  } else {
    final = (38.71 * Fb ** 0.6) / us;
    xf = 119 * Fb ** 0.4;
  }
  const dh = x < xf ? Math.min((1.6 * Math.cbrt(Fb) * x ** (2 / 3)) / us, final) : final;
  return { dh, final, xf };
}

/**
 * ARM2 NO2/NOx 비율. 다항식: EPA ARM2 Development and Evaluation Report(2013.9.20.) 3.4절 p.22
 * (x = 1시간 NOx 농도, µg/m³). 상·하한 0.5~0.9: EPA AERMOD NO2 Changes TSD 4.1절.
 */
export function arm2Ratio(noxUgPerM3) {
  const x = noxUgPerM3;
  const y = -1.1723e-17 * x ** 6 + 4.2795e-14 * x ** 5 - 5.8345e-11 * x ** 4 + 3.4555e-8 * x ** 3
    - 5.6062e-6 * x ** 2 - 2.7383e-3 * x + 1.2441;
  return Math.min(0.9, Math.max(0.5, y));
}

/**
 * 발전차 한 대가 한 수음점에 주는 NOx 농도(g/m³) — 시나리오별 가정 적용, NO2 환산 전.
 * ISC3 2권 식 1-1 + 식 1-50(지면 수음점 z_r=0, 혼합고 반사항 없음): χ = Q/(π u_s σy σz)·exp(−y²/2σy²)·exp(−h_e²/2σz²)
 * h_e = 0이면 gaussianGroundLevelConc와 같은 식이에요.
 */
function noxFromGenerator({ g, receiverLat, receiverLon, stability, wsd10m, vec, 가정, 대기온도_C }) {
  const flags = [];
  const legacy = 가정 === "기존입력가정";
  const load = g.loadFactor === undefined ? (legacy ? 1.0 : DEFAULT_LOAD_FACTOR_NONROAD) : g.loadFactor;
  if (!legacy && g.loadFactor === undefined) flags.push("부하율EPA기본값");

  const distance = haversineDistanceM(g.lat, g.lon, receiverLat, receiverLon);
  if (distance < 1) return { nox: null, flags, reason: "음원 위치" };
  const { diffDeg } = windComponentTowardReceiver(vec, bearingDeg(g.lat, g.lon, receiverLat, receiverLon));
  const th = (diffDeg * Math.PI) / 180;
  const x = distance * Math.cos(th);
  const y = distance * Math.sin(th);
  if (x <= 0) return { nox: 0, flags };
  if (x < 100) flags.push("근거리불확실");

  // 배출 높이와 연기 상승
  let hs = 0, dh = 0;
  if (!legacy) {
    const known = ["배기구높이_m", "배기온도_C", "배기량_m3_per_min"].every((k) => typeof g[k] === "number");
    if (!known) flags.push("배기사양가정");
    hs = g.배기구높이_m ?? DEFAULT_EXHAUST.배기구높이_m;
  }
  const us = legacy ? advectionWindSpeed(wsd10m, stability) : windSpeedAtHeight(wsd10m, stability, hs);
  if (!legacy) {
    if (가정 === "연기상승제외") flags.push("연기상승제외");
    else if (g.건물옆 !== false) flags.push("건물옆_연기상승제외"); // 개방된 곳이라고 명시(false)한 발전차만 상승 적용
    else if (typeof 대기온도_C !== "number") flags.push("기온없음_연기상승제외");
    else {
      const ex = {
        배기온도_C: g.배기온도_C ?? DEFAULT_EXHAUST.배기온도_C,
        배기량_m3_per_min: g.배기량_m3_per_min ?? DEFAULT_EXHAUST.배기량_m3_per_min,
        배기구지름_m: g.배기구지름_m, 대기온도_C,
      };
      const Fb = buoyancyFlux(ex);
      // 부력 상승 식(1-14·1-15·1-20·1-22)은 부력 지배일 때만 써요(11/21 코드 검토 P1). 운동량 상승은 구현하지 않아서,
      // 부력 지배가 아니거나 판정할 수 없으면 상승을 빼요(보수적). 단, 온도·배기량을 모두 기본값으로 쓸 때는
      // 지름 0.15~0.3m 범위에서 부력 지배임을 미리 확인했어요(교차 온도차 최대 340K < 실제 약 460K, 적용본 문서 2-③).
      const usesDefaultExhaust = g.배기온도_C === undefined && g.배기량_m3_per_min === undefined;
      const dom = isBuoyancyDominated({ ...ex, stability, Fb });
      if (dom === false) flags.push("부력지배아님_연기상승제외");
      else if (dom === null && !usesDefaultExhaust) flags.push("지름없음_연기상승제외");
      else {
        dh = briggsBuoyantRise({ Fb, us, stability, 대기온도_C, x }).dh;
        if (dh > 0) flags.push("연기상승적용");
      }
    }
  }
  // 배기구 끝 하강(stack-tip downwash, ISC3 식 1-7, p.1-6): v_s < 1.5·u_s 이면 h_s' = h_s + 2·d_s·(v_s/u_s − 1.5).
  // 배출 속도 v_s를 알려면 배기구 지름이 필요해서, 지름을 입력한 발전차에만 적용해요. 음수 높이는 0으로 막아요.
  let hsEff = hs;
  if (!legacy && g.배기구지름_m > 0) {
    const vs = ((g.배기량_m3_per_min ?? DEFAULT_EXHAUST.배기량_m3_per_min) / 60) / ((Math.PI * g.배기구지름_m ** 2) / 4);
    if (vs < 1.5 * us) {
      hsEff = Math.max(0, hs + 2 * g.배기구지름_m * (vs / us - 1.5));
      flags.push("배기구끝하강");
    }
  }
  const he = hsEff + dh;
  const qNox = (noxEmissionFactorGPerKWh(g.엔진출력_kW) * g.엔진출력_kW * load) / 3600; // g/s
  let sy = DISPERSION[stability].sigmaY(x), sz = DISPERSION[stability].sigmaZ(x);
  // 부력에 의한 확산(BID, ISC3 식 1-48·1-49, p.1-32): σ_e = √(σ² + (Δh/3.5)²). Δh는 그 거리의 상승(점진/최종)이에요.
  // 연기 상승을 적용할 때만 들어가요(11/21 코드 검토 2차 P1). 상승이 0이면 σ가 그대로예요.
  if (dh > 0) {
    sy = Math.hypot(sy, dh / 3.5);
    sz = Math.hypot(sz, dh / 3.5);
  }
  const nox = gaussianGroundLevelConc({ qGPerS: qNox, u: us, sigmaY: sy, sigmaZ: sz, y }) * Math.exp(-0.5 * (he / sz) ** 2);
  return { nox, flags };
}

// ---------------------------------------------------------------------------
// 한 수음점의 최종값 — 발전차 여러 대 합산 + 풍향 불확실성 부채꼴
// ---------------------------------------------------------------------------
/**
 * 한 수음점에 대해 발전차 여러 대의 NOx를 더한 뒤 NO2로 환산하고, 풍향 예보 오차를 고려해
 * 예보 풍향 ±fanHalfWidthDeg 안에서 합계가 가장 큰 값을 돌려줘요.
 * - 여러 대: 대수를 곱하지 않고 한 대씩 계산해 NOx를 더해요. NO2 환산(ARM2 등)은 '더한 뒤' 수음점별로 해요.
 * - 부채꼴: 같은 시각엔 모든 발전차에 같은 바람이 분다고 보고, 방향을 함께 돌려 가며 합계를 구해요.
 *   폭은 common.js WIND_FAN_HALF_WIDTH_DEG(임시 22.5°). 0이면 예보 방향만. 간격은 fanStepDeg 그대로, ±반폭 끝 포함.
 * - 결과 해석: '그 시간 기상이 한 시간 동안 유지된다는 가정의 1시간 평균 추정 농도'(ISC3 식 1-1은 시간 농도)이고,
 *   '예보 풍향 오차 범위 안의 최대값'이에요. 측정값이 아니에요.
 * - 전제조건: generators에는 그 시각에 가동 중인 발전차만 넣어요(시간 필터는 combine.js).
 * - 출력종류가 "엔진"이 아니면 '엔진출력미확인' 꼬리표.
 * - 건물옆: 큰 건물 옆 발전차는 기본(undefined)으로 연기 상승을 빼요. 건물 후류를 계산한 게 아니라,
 *   후류를 계산하지 못하니 연기 상승 효과를 믿지 않는 보수적 선택이에요(검토 2회차, 하린 결정 B).
 *   개방된 곳 발전차만 건물옆:false로 넣어 상승을 적용해요.
 * @param {Object} p
 * @param {{lat:number, lon:number, 엔진출력_kW:number, 출력종류?:string, loadFactor?:number, 정보출처?:string,
 *   배기구높이_m?:number, 배기온도_C?:number, 배기량_m3_per_min?:number, 배기구지름_m?:number, 건물옆?:boolean}[]} p.generators
 * @param {number} p.receiverLat
 * @param {number} p.receiverLon
 * @param {StabilityClass} p.stability
 * @param {number} p.wsd10m
 * @param {number} p.windVecFromDeg
 * @param {"기본추정"|"기존입력가정"|"연기상승제외"|"전량NO2"} [p.가정]  기본 "기본추정"
 * @param {number} [p.대기온도_C]  기상청 TMP. 없으면 연기 상승을 빼요(꼬리표).
 * @param {number} [p.fanHalfWidthDeg]  0 이상 180 이하
 * @param {number} [p.fanStepDeg]  0 초과
 * @returns {{value: number|null, flags: string[], scenario: string, reason?: string, centerValue: number|null, maxAtOffsetDeg: number|null, no2NoxRatio?: number}}
 */
export function calcExhaustAtReceiver({
  generators, receiverLat, receiverLon, stability, wsd10m, windVecFromDeg,
  가정 = "기본추정", 대기온도_C,
  fanHalfWidthDeg = WIND_FAN_HALF_WIDTH_DEG, fanStepDeg = 2.5,
}) {
  const scenario = `가우시안플룸_ISC3도시형확산계수_풍향부채꼴최대_${가정}`;
  const fail = (reason, flags = []) => ({
    value: null, flags: [...new Set([...flags, "계산불가"])], scenario, reason, centerValue: null, maxAtOffsetDeg: null,
  });
  const finite = (v) => typeof v === "number" && Number.isFinite(v);
  const legacy = 가정 === "기존입력가정";
  // 기상청 기온이 빠지면 null로 올 수 있어요. null도 '기온 없음'으로 받아요(코드 검토 2차 P2 — 지도 전체가 계산불가가 되지 않게).
  if (대기온도_C === null) 대기온도_C = undefined;
  // 부하율을 안 넣었을 때(undefined)만 기본값. null은 '잘못된 입력'으로 검증에서 걸러요.
  const loadOf = (g) => (g.loadFactor === undefined ? (legacy ? 1.0 : DEFAULT_LOAD_FACTOR_NONROAD) : g.loadFactor);

  // 1) 공통 입력을 부채꼴로 돌리기 '전에' 검증해요(예: 361°가 1°로 바뀌어 통과하는 것 방지).
  if (!EXHAUST_ASSUMPTIONS.includes(가정)) return fail(`가정은 ${EXHAUST_ASSUMPTIONS.join("·")} 중 하나: ${가정}`);
  if (대기온도_C !== undefined && (!finite(대기온도_C) || 대기온도_C < -50 || 대기온도_C > 60)) return fail(`대기온도는 −50~60℃: ${대기온도_C}`);
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
    if (!legacy) {
      if (g.배기구높이_m !== undefined && (!finite(g.배기구높이_m) || g.배기구높이_m < 0 || g.배기구높이_m > 50)) return failKeep(`발전차 ${i + 1}번: 배기구 높이 0~50m: ${g.배기구높이_m}`);
      if (g.배기온도_C !== undefined && (!finite(g.배기온도_C) || g.배기온도_C < -50 || g.배기온도_C > 1000)) return failKeep(`발전차 ${i + 1}번: 배기 온도 −50~1000℃: ${g.배기온도_C}`);
      if (g.배기량_m3_per_min !== undefined && (!finite(g.배기량_m3_per_min) || g.배기량_m3_per_min <= 0)) return failKeep(`발전차 ${i + 1}번: 배기량은 0보다 커야 해요: ${g.배기량_m3_per_min}`);
      if (g.배기구지름_m !== undefined && (!finite(g.배기구지름_m) || g.배기구지름_m <= 0 || g.배기구지름_m > 5)) return failKeep(`발전차 ${i + 1}번: 배기구 지름 0~5m: ${g.배기구지름_m}`);
      if (g.건물옆 !== undefined && typeof g.건물옆 !== "boolean") return failKeep(`발전차 ${i + 1}번: 건물옆은 true/false: ${g.건물옆}`);
    }
  }

  // 약풍: 10m 풍속 1m/s 미만이면 지도에 그리지 않아요(가정값 문서 "확산" 절). 0이 아니라 null.
  if (wsd10m < 1.0) {
    return { value: null, flags: [...baseFlags, "약풍미표시"], scenario, reason: "10m 풍속 1m/s 미만", centerValue: null, maxAtOffsetDeg: null };
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

  const toNo2 = (noxGPerM3) => {
    const ratio = legacy ? NO2_NOX_RATIO : 가정 === "전량NO2" ? 1.0 : arm2Ratio(noxGPerM3 * 1e6);
    return { ppm: mgPerM3ToPpm(noxGPerM3 * ratio * 1000), ratio };
  };

  let best = null;
  let center = null;
  for (const off of offsets) {
    const vec = (((windVecFromDeg + off) % 360) + 360) % 360;
    let noxTotal = 0;
    const flags = new Set(baseFlags);
    for (const g of generators) {
      const r = noxFromGenerator({ g, receiverLat, receiverLon, stability, wsd10m, vec, 가정, 대기온도_C });
      if (r.nox === null) return fail(r.reason, [...flags, ...r.flags]);
      noxTotal += r.nox;
      r.flags.forEach((f) => flags.add(f));
    }
    const { ppm, ratio } = toNo2(noxTotal);
    if (Math.abs(off) < 1e-9) center = ppm;
    if (best === null || ppm > best.ppm) best = { ppm, ratio, flags, off };
  }
  const flags = [...best.flags];
  if (fanHalfWidthDeg > 0) flags.push("풍향부채꼴최대");
  if (!legacy && 가정 !== "전량NO2") flags.push("ARM2");
  return { value: best.ppm, flags, scenario, centerValue: center, maxAtOffsetDeg: best.off, no2NoxRatio: best.ratio };
}
