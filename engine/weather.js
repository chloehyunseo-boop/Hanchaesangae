// engine/weather.js — 기상청 예보 호출·파싱 (친구 라인)
// 로드맵 2번 "공통 조건" 기상 항목을 그대로 따라요:
//   - 0~6시간: 초단기예보 우선. 응답 실패나 발표 시각이 오래됐으면 단기예보로 대체
//   - 6~72시간: 단기예보
//   - 값이 없는 시간은 임의로 채우지 않고, 예보가 있는 시각만 돌려줘요
//   - 저장 시각 / 발표 시각(baseTime) / 예보 대상 시각 / 원본값 / 실패 기록을 구분해서 남겨요
//
// 인증키(serviceKey)는 절대 이 파일이나 다른 코드에 적지 않아요. 호출하는 쪽(Actions
// 워크플로의 환경변수, 또는 로컬 테스트 시 터미널 환경변수)에서 넘겨받기만 해요.
//
// 공공데이터포털 "기상청_단기예보 조회서비스"(15084084) 활용가이드에 나온
// 엔드포인트 2개를 그대로 써요. 새로 지어낸 파라미터는 없어요.

import { KMA_GRID } from "./common.js";

const BASE_URL = "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0";

// 기상청 단기예보는 하루 8번(02,05,08,11,14,17,20,23시) 발표되고,
// 초단기예보는 매시 발표돼요(제공은 45분 이후). 활용가이드에 나온 값 그대로예요.
const VILAGE_BASE_HOURS = [2, 5, 8, 11, 14, 17, 20, 23];

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatBaseDateTime(date) {
  const y = date.getFullYear();
  const m = pad2(date.getMonth() + 1);
  const d = pad2(date.getDate());
  const hh = pad2(date.getHours());
  const mm = pad2(date.getMinutes());
  return { baseDate: `${y}${m}${d}`, baseTime: `${hh}${mm}` };
}

/**
 * 가장 최근에 나왔을 발표 시각을 계산해요(직접 호출해서 성공하는지는 별개 — 실패하면
 * 그대로 실패 기록에 남겨요. 여기서 값을 꾸며내지 않아요).
 * @param {Date} now
 * @param {"ultra"|"vilage"} kind
 */
export function latestBaseDateTime(now, kind) {
  const d = new Date(now.getTime());
  if (kind === "ultra") {
    // 초단기예보: 매시 45분 발표, 그 전엔 전 시각 발표를 써요.
    if (d.getMinutes() < 45) d.setHours(d.getHours() - 1);
    d.setMinutes(0, 0, 0);
    return formatBaseDateTime(d);
  }
  // 단기예보: 발표 시각 목록 중 "지금보다 과거이면서 가장 가까운" 시각 + 10분 뒤부터 제공.
  let hour = d.getHours();
  let minute = d.getMinutes();
  let candidates = VILAGE_BASE_HOURS.filter((h) => h < hour || (h === hour && minute >= 10));
  if (candidates.length === 0) {
    d.setDate(d.getDate() - 1);
    hour = VILAGE_BASE_HOURS[VILAGE_BASE_HOURS.length - 1];
  } else {
    hour = candidates[candidates.length - 1];
  }
  d.setHours(hour, 0, 0, 0);
  return formatBaseDateTime(d);
}

/**
 * 기상청 단기예보/초단기예보를 호출해요. 실패하면 던지지 않고 실패 정보를 돌려줘요
 * (호출하는 쪽이 "실패 기록"에 그대로 남길 수 있게).
 * @param {Object} opts
 * @param {string} opts.serviceKey  공공데이터포털에서 발급받은 인증키 (호출자가 넘김, 여기 저장 안 함)
 * @param {"ultra"|"vilage"} opts.kind
 * @param {number} [opts.nx] 기본값 KMA_GRID.nx
 * @param {number} [opts.ny] 기본값 KMA_GRID.ny
 * @param {Date} [opts.now]
 * @returns {Promise<{ok: true, baseDate: string, baseTime: string, raw: any} | {ok: false, 사유: string}>}
 */
export async function fetchLatestForecast({ serviceKey, kind, nx = KMA_GRID.nx, ny = KMA_GRID.ny, now = new Date() }) {
  if (!serviceKey) {
    return { ok: false, 사유: "serviceKey 없음 — 호출하는 쪽(Actions Secrets 또는 로컬 환경변수)에서 넘겨줘야 해요" };
  }
  const { baseDate, baseTime } = latestBaseDateTime(now, kind);
  const path = kind === "ultra" ? "getUltraSrtFcst" : "getVilageFcst";
  const url = new URL(`${BASE_URL}/${path}`);
  url.searchParams.set("serviceKey", serviceKey);
  url.searchParams.set("numOfRows", "1000");
  url.searchParams.set("pageNo", "1");
  url.searchParams.set("dataType", "JSON");
  url.searchParams.set("base_date", baseDate);
  url.searchParams.set("base_time", baseTime);
  url.searchParams.set("nx", String(nx));
  url.searchParams.set("ny", String(ny));

  try {
    const res = await fetch(url.toString());
    if (!res.ok) {
      return { ok: false, 사유: `HTTP ${res.status}` };
    }
    const body = await res.json();
    const header = body?.response?.header;
    if (!header || header.resultCode !== "00") {
      return { ok: false, 사유: `기상청 응답 오류: ${header?.resultMsg ?? "resultCode 없음"}` };
    }
    return { ok: true, baseDate, baseTime, raw: body };
  } catch (err) {
    return { ok: false, 사유: `호출 실패: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * fetchLatestForecast가 돌려준 raw 응답을 engine/common.js의 ForecastItem[] 모양으로 바꿔요.
 * 값이 없는 항목은 만들어내지 않고, 응답에 있는 항목만 그대로 옮겨요.
 * @param {any} raw  fetchLatestForecast의 ok:true 결과 중 raw
 * @param {"ultra"|"vilage"} kind
 * @returns {import("./common.js").ForecastItem[]}
 */
export function parseForecastResponse(raw, kind) {
  const items = raw?.response?.body?.items?.item;
  if (!Array.isArray(items)) return [];
  return items.map((it) => ({
    baseDate: String(it.baseDate),
    baseTime: String(it.baseTime),
    fcstDate: String(it.fcstDate),
    fcstTime: String(it.fcstTime),
    category: String(it.category),
    value: String(it.fcstValue),
    source: kind,
  }));
}

/**
 * 로드맵 2번 공통 조건대로 초단기예보·단기예보를 합쳐요.
 * 0~6시간은 초단기예보 우선(없으면 단기예보로 대체), 6~72시간은 단기예보.
 * "오래된 발표"의 기준(몇 분까지 허용할지)은 아직 미정 — 11/15 실제 응답으로
 * 확인 후 채워요. 지금은 초단기예보가 있으면 그냥 써요.
 * @param {import("./common.js").ForecastItem[]} ultraItems
 * @param {import("./common.js").ForecastItem[]} vilageItems
 * @param {Date} now
 * @returns {import("./common.js").ForecastItem[]}
 */
export function mergeForecasts(ultraItems, vilageItems, now) {
  const sixHoursLater = new Date(now.getTime() + 6 * 60 * 60 * 1000);
  const cutoff = `${sixHoursLater.getFullYear()}${pad2(sixHoursLater.getMonth() + 1)}${pad2(sixHoursLater.getDate())}${pad2(sixHoursLater.getHours())}00`;

  const key = (it) => `${it.fcstDate}${it.fcstTime}:${it.category}`;
  const merged = new Map();
  for (const it of vilageItems) merged.set(key(it), it);
  for (const it of ultraItems) {
    // fcstDate+fcstTime이 이미 YYYYMMDDHHmm(12자리)이라 cutoff와 길이가 같아야
    // 문자열 비교가 자릿수 오차 없이 맞아요. 전에는 여기 "00"을 더 붙여서(14자리)
    // 정확히 6시간째 정각(날짜+시가 cutoff와 같은 시각)일 때만 길이 차이 때문에
    // fcstKey > cutoff로 잘못 나와 그 시각만 초단기예보가 안 덮어써지는 버그가 있었어요.
    const fcstKey = `${it.fcstDate}${it.fcstTime}`;
    if (fcstKey <= cutoff) merged.set(key(it), it); // 0~6시간 구간은 초단기예보가 덮어써요
  }
  return Array.from(merged.values());
}

/**
 * 11/28 하린 발견(미반영 브랜치 fix/weather-gap): 단기예보는 3시간마다 새로 나오고, 새 발표분은
 * "발표 시각 다음 시간"부터만 값이 있어요(예: 08시 발표 → 09시부터). 그래서 새 발표를 받은 갱신에서는
 * 지금 시각의 기온(TMP)이 빠져, 엔진이 그 시각 지도 전체를 '계산 불가'로 비웠어요(11/26~28 30번 중 8번).
 * 새로 받은 예보에 없는 (시각, 항목)만 직전 갱신 파일 값으로 채워요. 새 값이 있으면 항상 새 값이 이겨요.
 * 채우는 범위는 지금 시(정각)부터 6시간까지만이에요(오래된 값이 계속 남지 않게).
 * 채운 값에는 유지: "직전갱신"을 붙여요(지어낸 값이 아니라 기상청이 직전에 준 예보값).
 */
export function carryOverMissing(newItems, prevItems, now) {
  const fmt = (d) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}${pad2(d.getHours())}00`;
  const from = fmt(now);
  const to = fmt(new Date(now.getTime() + 6 * 60 * 60 * 1000));
  const key = (it) => `${it.fcstDate}${it.fcstTime}:${it.category}`;
  const have = new Set(newItems.map(key));
  const out = [...newItems];
  for (const it of prevItems ?? []) {
    const t = `${it.fcstDate}${it.fcstTime}`;
    if (t < from || t > to || have.has(key(it))) continue;
    have.add(key(it));
    out.push({ ...it, 유지: "직전갱신" });
  }
  return out;
}
