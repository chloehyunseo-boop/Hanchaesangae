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
  // bounds: 11/14~11/15에 공원 경계 + 1km로 확정
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
  // 계산에 쓴 기준점: KSPO돔(체조경기장) 대략 중심
  refLat: 37.5203,
  refLon: 127.1268,
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
// 3. 풍향 기준 — 아직 비어 있음 (11/15 작업)
// ---------------------------------------------------------------------------
// 기상청 VEC(바람이 불어오는 방향, 0~360도)를
// "음원 → 수음점" 방향의 바람 성분으로 바꾸는 함수를 여기에 하나만 둬요.
// export function windComponentTowardReceiver(vecDeg, sourceToReceiverBearingDeg) { ... }

// ---------------------------------------------------------------------------
// 4. 출력 형식 — 아직 비어 있음 (11/19 "엔진 연결"에서 확정)
// ---------------------------------------------------------------------------
// 소음 엔진과 배출가스 엔진이 격자 칸마다 돌려주는 값의 모양(강/중/약 등)을
// 여기에 타입으로 적어 둬요.
