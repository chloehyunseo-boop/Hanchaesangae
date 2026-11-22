// engine/common.js
// 두 엔진(소음 engine/noise.js, 배출가스 engine/plume.js)이 공통으로 쓰는 값과 함수.
// 격자, 풍향 기준, 단위, 출력 형식을 여기서만 정해요. 각 엔진 파일 안에서 따로 정의하지 않아요.
// (로드맵 2번 "공통 조건", 4번 4항 참고)

// ---------------------------------------------------------------------------
// 1. 격자 (계산용 25m 격자, EPSG:5186 투영좌표계)
// ---------------------------------------------------------------------------
// 11/14~11/15에 실제 공원 경계로 확정. 지금은 자리만 잡아 둠.
export const CALC_GRID = {
  cellSizeM: 25,       // 계산 격자 한 칸 크기 (표시용. 기상 해상도 아님)
  crs: "EPSG:5186",    // 투영좌표계. 지도에 그릴 때만 위경도(EPSG:4326)로 변환
  // bounds: 11/19, data/site.geojson의 20개 지점(공연장·무대·주거지) 바운딩박스 + 1km.
  // ⚠️ 공원의 진짜 외곽 경계선(폴리곤)이 아니라 "아는 지점들의 바운딩박스"예요 — 공원에는
  // 이 지점들 바깥에도 산책로·녹지가 있어서, 실제 공원보다 좁게 잡혔을 수 있어요. 좌표는
  // 아직 위경도(EPSG:4326)예요 — 5186 투영 변환은 M2 지도 연결 때 해요(haversineDistanceM과
  // 같은 이유, 3.5절 참고).
  bounds: {
    minLat: 37.501230,
    maxLat: 37.535646,
    minLon: 127.097627,
    maxLon: 127.141842,
  },
};

// ---------------------------------------------------------------------------
// 2. 기상청 단기예보 격자 (nx, ny) — 11/13 작업
// ---------------------------------------------------------------------------
// 기상청 단기예보 조회서비스(data.go.kr 15084084)는 5km 격자(LCC 투영)의
// 격자번호 nx, ny로 지점을 지정해요. 아래 변환은 기상청이 활용가이드에 공개한
// 표준 알고리즘(Lambert Conformal Conic)을 그대로 옮긴 것이고, 새로 지어낸
// 계수는 없어요.
//
// 올림픽공원은 공원 전체가 5km 격자 한 칸(nx=62, ny=126) 안에 들어가요.
// 즉, 공원 안 어디를 기준점으로 잡아도 같은 격자를 조회하면 돼요.
export const KMA_GRID = {
  nx: 62,
  ny: 126,
  // 계산에 쓴 기준점: KSPO DOME 중심 (data/site.geojson, 11/15 확정 좌표로 재계산해도 nx=62, ny=126)
  refLat: 37.519163,
  refLon: 127.127359,
};

/**
 * 위경도(EPSG:4326, 도 단위)를 기상청 단기예보 5km 격자 번호(nx, ny)로 바꿔요.
 * 기상청이 공개한 Lambert Conformal Conic 변환식이에요(새 계수 없음).
 * @param {number} lat 위도 (도)
 * @param {number} lon 경도 (도)
 * @returns {{nx: number, ny: number}}
 */
export function latLonToKmaGrid(lat, lon) {
  const RE = 6371.00877; // 지구 반경 (km)
  const GRID = 5.0;      // 격자 간격 (km)
  const SLAT1 = 30.0;    // 투영 표준위도 1
  const SLAT2 = 60.0;    // 투영 표준위도 2
  const OLON = 126.0;    // 기준점 경도
  const OLAT = 38.0;     // 기준점 위도
  const XO = 43;         // 기준점 X좌표(GRID 단위)
  const YO = 136;         // 기준점 Y좌표(GRID 단위)

  const DEGRAD = Math.PI / 180.0;

  const re = RE / GRID;
  const slat1 = SLAT1 * DEGRAD;
  const slat2 = SLAT2 * DEGRAD;
  const olon = OLON * DEGRAD;
  const olat = OLAT * DEGRAD;

  let sn = Math.tan(Math.PI * 0.25 + slat2 * 0.5) / Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sn = Math.log(Math.cos(slat1) / Math.cos(slat2)) / Math.log(sn);
  let sf = Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sf = Math.pow(sf, sn) * Math.cos(slat1) / sn;
  let ro = Math.tan(Math.PI * 0.25 + olat * 0.5);
  ro = re * sf / Math.pow(ro, sn);

  let ra = Math.tan(Math.PI * 0.25 + (lat * DEGRAD) * 0.5);
  ra = re * sf / Math.pow(ra, sn);
  let theta = lon * DEGRAD - olon;
  if (theta > Math.PI) theta -= 2.0 * Math.PI;
  if (theta < -Math.PI) theta += 2.0 * Math.PI;
  theta *= sn;

  const x = Math.floor(ra * Math.sin(theta) + XO + 0.5);
  const y = Math.floor(ro - ra * Math.cos(theta) + YO + 0.5);
  return { nx: x, ny: y };
}

// ---------------------------------------------------------------------------
// 3. 풍향 기준 — 11/15 작업
// ---------------------------------------------------------------------------
// 기상청 VEC는 "바람이 불어오는 방향"(0~360도, 0=북)이에요. 두 엔진 모두
// "음원 → 수음점" 쪽으로 바람이 얼마나 부는지가 필요해서, 이 변환은 여기
// 한 곳에만 둬요. 새 계수는 없고, 방위각 기하 계산만이에요.

// 풍향 불확실성 부채꼴. 임시값: 중심에서 양쪽으로 22.5도(전체 폭 45도).
// 11/27 예보-실측 비교로 구한 원형 각도 오차의 90백분위수로 바꿔요. (로드맵 2번 공통 조건)
export const WIND_FAN_HALF_WIDTH_DEG = 22.5;

/**
 * 바람이 "음원 → 수음점" 방향으로 얼마나 부는지 계산해요.
 * @param {number} vecFromDeg 기상청 VEC — 바람이 불어오는 방향 (도, 0=북, 시계방향)
 * @param {number} sourceToReceiverBearingDeg 음원에서 수음점을 바라보는 방위각 (도, 0=북, 시계방향)
 * @returns {{ diffDeg: number, alignment: number, withinFan: boolean }}
 *   diffDeg: 바람이 "실제로 불어가는" 방향과 음원→수음점 방향의 차이 (-180~180, 0이면 정확히 그 방향)
 *   alignment: cos(diffDeg) — 1이면 정확히 그 방향, -1이면 정반대
 *   withinFan: diffDeg가 ±WIND_FAN_HALF_WIDTH_DEG 부채꼴 안인지
 */
export function windComponentTowardReceiver(vecFromDeg, sourceToReceiverBearingDeg) {
  const windGoingToDeg = (vecFromDeg + 180) % 360;
  let diff = windGoingToDeg - sourceToReceiverBearingDeg;
  diff = ((diff + 180) % 360 + 360) % 360 - 180; // -180~180로 정규화
  return {
    diffDeg: diff,
    alignment: Math.cos((diff * Math.PI) / 180),
    withinFan: Math.abs(diff) <= WIND_FAN_HALF_WIDTH_DEG,
  };
}

// ---------------------------------------------------------------------------
// 3.5 거리·방위각 — 11/17 임시
// ---------------------------------------------------------------------------
// SourceSpec.x/y는 원래 EPSG:5186(미터) 기준인데, 지금 가진 음원 좌표
// (data/site.geojson)는 아직 위경도(EPSG:4326)예요. 5186 투영 변환은
// M2 "지도 연결"에서 하기로 하고, 지금은 공원처럼 좁은 범위(수 km 이내)에서
// 오차가 1% 미만인 하버사인(haversine) 공식으로 거리·방위각을 구해요.
// 공식 자체는 측지학 공개 표준이고, 새로 지어낸 계수는 없어요.
const EARTH_RADIUS_M = 6371000;

/**
 * 두 위경도 지점 사이의 직선거리(미터)를 하버사인 공식으로 계산해요.
 * @returns {number} 거리 (m)
 */
export function haversineDistanceM(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

/**
 * 지점1에서 지점2를 바라보는 방위각(도, 0=북, 시계방향)을 계산해요.
 * @returns {number} 방위각 (0~360도)
 */
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

// ---------------------------------------------------------------------------
// 3.6 시간 가중 보조 — 11/21 추가
// ---------------------------------------------------------------------------
/**
 * [startIso, endIso) 구간이 [hourIso, hourIso+1시간) 한 시간과 겹치는 분(分)을 구해요.
 * endIso가 없으면(null) 그 시간 끝까지 계속되는 것으로 봐요(종료 미상 — 보수적으로 최대치).
 * @param {string} startIso
 * @param {string|null} endIso
 * @param {string} hourIso
 * @returns {number} 겹치는 분(0 이상, 60 이하)
 */
export function overlapMinutesInHour(startIso, endIso, hourIso) {
  const hourStartMs = new Date(hourIso).getTime();
  const hourEndMs = hourStartMs + 3600000;
  const startMs = new Date(startIso).getTime();
  const endMs = endIso ? new Date(endIso).getTime() : hourEndMs;
  const overlapStartMs = Math.max(hourStartMs, startMs);
  const overlapEndMs = Math.min(hourEndMs, endMs);
  return Math.max(0, (overlapEndMs - overlapStartMs) / 60000);
}

// ---------------------------------------------------------------------------
// 4. 기상 입력 형식 — 11/15 초안 (engine/weather.js가 이 모양으로 돌려줘요)
// ---------------------------------------------------------------------------
/**
 * @typedef {Object} ForecastItem
 * @property {string} baseDate   발표일(YYYYMMDD) — 이 예보가 언제 나온 예보인지
 * @property {string} baseTime   발표시각(HHMM)
 * @property {string} fcstDate   예보 대상일(YYYYMMDD)
 * @property {string} fcstTime   예보 대상시각(HHMM)
 * @property {string} category   기상청 코드: VEC(풍향) WSD(풍속) TMP(기온) SKY(하늘상태) PTY(강수형태) 등
 * @property {string} value      원본 예보값 (문자열 그대로, 단위는 기상청 코드 정의 따름)
 * @property {"ultra"|"vilage"} source 초단기예보(ultra)인지 단기예보(vilage)인지
 */

/**
 * @typedef {Object} ForecastRecord
 * @property {string} 저장시각      ISO 문자열 — 이 파일을 쓴 시각 (실행 시각, 발표 시각 아님)
 * @property {ForecastItem[]} 예보
 * @property {Array<{시각: string, 사유: string}>} 실패기록  호출 실패나 파싱 실패를 그대로 남겨요(값을 임의로 채우지 않음)
 */

// ---------------------------------------------------------------------------
// 5. 소스(음원) 형식 — 11/15 초안
// ---------------------------------------------------------------------------
/**
 * 소음 음원(공연)과 배출가스 음원(발전차)이 공통으로 갖는 모양이에요.
 * 종류별로 더 필요한 값은 각자 확장해서 써요(이 모양을 덮어쓰지 않음).
 * @typedef {Object} SourceSpec
 * @property {"stage"|"generator"} kind
 * @property {number} x  경도(lon, EPSG:4326, 도) — OutputCell과 같은 이유로 지금은 위경도
 * @property {number} y  위도(lat, EPSG:4326, 도)
 * @property {{start: string|null, end: string|null, 출처: "공단API명시"|"런타임추정"|"수동입력"|"미확인"}} time
 *   time.출처가 "미확인"이면 이 음원은 계산에 넣지 않아요(로드맵 2번 공통 조건).
 */

/**
 * kind가 "generator"인 SourceSpec은 발전차 한 대당 하나씩 아래 필드를 더 가져요.
 * 실제 값(대수, 출력, tier4 여부 등)의 근거는 docs/발전차_배출가스_가정값과_근거.md와
 * data/assumptions.json의 "배출가스" 항목을 따라요.
 * @typedef {Object} GeneratorSourceSpec
 * @property {"generator"} kind
 * @property {number} 엔진출력_kW
 * @property {"엔진"|"전기"|"미확인"} 출력종류
 * @property {boolean|null} tier4여부  null이면 미확인
 * @property {"확인"|"시연용가정"} 정보출처  "시연용가정"이면 화면에 가정값 표시 필요(CLAUDE.md 규칙 2)
 */

// ---------------------------------------------------------------------------
// 6. 출력 형식 — 11/15 초안 (M2 "엔진 연결"에서 최종 확정, 지금은 바뀔 수 있음)
// ---------------------------------------------------------------------------
/**
 * 소음 엔진(noise.js)과 배출가스 엔진(plume.js)이 25m 계산 격자 한 칸·한 시각에 대해
 * 돌려주는 값의 모양이에요. 둘 다 같은 모양을 써서, 지도 쪽 코드가 레이어만 바꿔 그리게 해요.
 * @typedef {Object} OutputCell
 * @property {number} x  경도(lon, EPSG:4326, 도) — 원래는 EPSG:5186 미터(격자 칸 중심)가
 *   맞지만, 5186 투영 변환이 아직 없어서(3.5절) engine/combine.js가 지금은 위경도를 그대로 넣어요.
 * @property {number} y  위도(lat, EPSG:4326, 도)
 * @property {string} hour  ISO 시각 (1시간 단위)
 * @property {"noise"|"exhaust"} layer
 * @property {number|null} value  소음은 dB(A), 배출가스는 NO2 ppm (로드맵 2번). 계산 자체를
 *   안 한 칸(예: 풍상측이라 플룸이 안 닿음)은 null — 0과 다른 의미라 지도에서 구분해요.
 * @property {"강"|"중"|"약"|null} level  로드맵 2번 3단계 기준으로 분류. 기준 미만이면 null
 * @property {string[]} flags  이 칸의 값에 적용된 주의사항. 예: "근거리불확실"(발전차 100m 이내),
 *   "약풍미표시"(풍속 과소), "사양미확인"(발전차 사양 정보출처가 "시연용가정"),
 *   "시연용가정"(가정값으로 계산됨), "기상보정미적용"(K4 등 아직 미적용). 없으면 빈 배열.
 * @property {string} scenario  이 값이 어느 계산 시나리오로 나왔는지(로드맵 2번).
 *   예: "ISO9613-2_상한", "CONCAWE_전체", "계약기준역산", "문헌기반가정"
 */

// ---------------------------------------------------------------------------
// 7. 지도 표시 규칙 — 11/19 초안 (M3 지도 연결에서 index.html/agency.html이 그대로 써요)
// ---------------------------------------------------------------------------
/**
 * OutputCell 하나를 지도에서 어떻게 표시할지 정해요. 값 자체(숫자·단계)를 바꾸지 않고,
 * "보여주는 방식"만 결정해요 — 계산은 noise.js/plume.js가, 표시 규칙은 여기 한 곳에만 둬요.
 * @param {import("./common.js").OutputCell} cell
 * @returns {{ mode: "blank"|"hatch"|"value", hideValue: boolean, hideLevel: boolean }}
 *   mode "blank": value가 null → 빈칸(아무 것도 안 그림)
 *   mode "hatch": flags에 "근거리불확실"이 있음 → 숫자·단계 안 보여주고 회색 빗금만
 *   mode "value": 그 외 → 숫자·단계 그대로 보여줌
 */
export function mapDisplayFor(cell) {
  if (cell.value === null) {
    return { mode: "blank", hideValue: true, hideLevel: true };
  }
  if (cell.flags?.includes("근거리불확실")) {
    return { mode: "hatch", hideValue: true, hideLevel: true };
  }
  return { mode: "value", hideValue: false, hideLevel: false };
}

/**
 * 배출가스 레이어에 항상 같이 보여줄 문구. 로드맵 §2 "발전차 배출가스" 끝부분에 명시된
 * 문구 그대로예요(11/21 — 전에 제가 임의로 다른 문구를 썼던 걸 바로잡음).
 */
export const EXHAUST_LAYER_DISCLAIMER = "배경 농도 미포함, 대기환경기준 초과 판정이 아님";

/**
 * 소음 시민 화면에 음원 세기(LW) 출처별로 같이 보여줄 문구(로드맵 §2 "음원 세기").
 * source의 LW가 어느 쪽으로 정해졌는지에 맞춰 골라 써요.
 */
export const NOISE_SOURCE_DISCLAIMER = {
  계약기준역산: "공연 음량은 공단 계약 기준 최대치로 가정",
  문헌기반가정: "공연 음량은 문헌 기반 가정값",
};

/**
 * 소음 레이어에 시나리오별로 같이 보여줄 "무엇을 안 넣었는지" 문구. 외부 검토에서 제안한
 * 표현을 그대로 채택했어요(11/22) — OutputCell.scenario로 어느 쪽인지 구분해요.
 */
export const NOISE_LAYER_DISCLAIMER = {
  concawe: "CONCAWE 기반 시간별 추정 · 건물 및 방음벽 차폐 미반영",
  iso: "ISO 기반 비교 추정 · 지면반사·차폐 미반영",
};
