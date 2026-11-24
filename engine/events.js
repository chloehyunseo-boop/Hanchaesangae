// engine/events.js — 공연 일정 자동 수집·수동 입력 (친구 라인, 11/25)
// 로드맵 M3 11/23 몫("공연 일정 자동(공단 API)+수동 입력") — 11/24까지 빠뜨렸던 걸 이제 만들어요.
//
// CLAUDE.md 5번 결정대로 공단 '올림픽공원 공연정보' API(KOPIS 아님 — 공연시설·기획제작사만
// 가입 가능해서 못 씀)를 써요. 실제 엔드포인트는 문화공공데이터광장 경유
// `https://api.kcisa.kr/openapi/service/rest/meta/KSCperf`(11/19 실제 호출로 확인, decisions.md).
//
// 인증키(serviceKey)는 engine/weather.js와 같은 원칙 — 절대 이 파일이나 커밋에 적지 않고,
// 호출하는 쪽(Actions 환경변수)에서 넘겨받기만 해요. Secrets 이름은 KCISA_SERVICE_KEY
// (KMA_SERVICE_KEY와 다른 키 — 문화공공데이터광장은 공공데이터포털과 발급처가 달라요).
//
// ⚠️ 11/19 호출로 temporalCoverage(시작시각)·extent(소요시간) 필드가 있다는 것만 확인했고,
// 전체 응답 구조(공연명·장소 필드 이름)까지는 저장해 둔 샘플이 없어요 — 문화공공데이터광장
// 표준 메타데이터(title·description·spatial·temporalCoverage·extent·url)를 그대로 가정했는데,
// 이건 KCISA의 다른 meta/ API들과 같은 공통 스키마라 추정이지 확인된 사실은 아니에요.
// Secrets 등록 후 실제 응답으로 한 번 더 확인해야 해요(이 파일 하단 "확인할 것" 참고).

const BASE_URL = "https://api.kcisa.kr/openapi/service/rest/meta";

/**
 * 공단 공연정보를 호출해요. 실패하면 던지지 않고 실패 정보를 돌려줘요(weather.js와 같은 방식).
 * @param {{ serviceKey: string, numOfRows?: number, pageNo?: number }} opts
 * @returns {Promise<{ok:true, raw:any} | {ok:false, 사유:string}>}
 */
export async function fetchPerformances({ serviceKey, numOfRows = 100, pageNo = 1 }) {
  if (!serviceKey) {
    return { ok: false, 사유: "serviceKey 없음 — 호출하는 쪽(Actions Secrets 또는 로컬 환경변수)에서 넘겨줘야 해요" };
  }
  const url = new URL(`${BASE_URL}/KSCperf`);
  url.searchParams.set("serviceKey", serviceKey);
  url.searchParams.set("numOfRows", String(numOfRows));
  url.searchParams.set("pageNo", String(pageNo));
  url.searchParams.set("type", "json");

  try {
    const res = await fetch(url.toString());
    if (!res.ok) return { ok: false, 사유: `HTTP ${res.status}` };
    const body = await res.json();
    const items = extractItems(body);
    if (items === null) return { ok: false, 사유: "응답 형식을 못 알아봤어요(items 자리를 못 찾음)" };
    return { ok: true, raw: body };
  } catch (err) {
    return { ok: false, 사유: `호출 실패: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** KCISA 응답은 공공데이터포털과 바깥 틀이 달라요 — 몇 가지 흔한 자리를 순서대로 찾아봐요. */
function extractItems(body) {
  const candidates = [
    body?.response?.body?.items?.item,
    body?.response?.body?.items,
    body?.items?.item,
    body?.items,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
    if (c && typeof c === "object") return [c]; // 결과 1건이면 배열이 아니라 객체 하나로 올 수 있음
  }
  return null;
}

/**
 * "19:00", "오후 7시", "오후7시30분" 같은 시작 시각 문자열을 "HH:MM"로 바꿔요.
 * CLAUDE.md 5번: "2015년 4월5일(일) 오후4시"처럼 지저분한 값도 있어요 — 알아볼 수 있는
 * 부분(오후4시)만 뽑고, 아예 못 알아보면 null이에요(지어내지 않음).
 * @returns {string|null} "HH:MM" 또는 못 읽으면 null
 */
export function parseStartTime(raw) {
  if (typeof raw !== "string") return null;
  const clean = raw.replace(/\s+/g, "");
  let m = clean.match(/^(\d{1,2}):(\d{2})$/);
  if (m) return `${m[1].padStart(2, "0")}:${m[2]}`;
  m = clean.match(/(오전|오후)(\d{1,2})시(?:(\d{1,2})분)?/);
  if (m) {
    let h = Number(m[2]);
    const min = m[3] ? Number(m[3]) : 0;
    if (h === 12) h = 0; // 오전12시=0시, 오후12시=12시
    if (m[1] === "오후") h += 12;
    if (h >= 0 && h <= 23 && min >= 0 && min <= 59) {
      return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
    }
  }
  return null;
}

/**
 * "120분", "2시간", "2시간 30분" 같은 소요시간 문자열을 분(숫자)으로 바꿔요.
 * @returns {number|null}
 */
export function parseDurationMinutes(raw) {
  if (typeof raw !== "string") return null;
  const clean = raw.replace(/\s+/g, "");
  let total = 0;
  let matched = false;
  const h = clean.match(/(\d+)시간/);
  if (h) { total += Number(h[1]) * 60; matched = true; }
  const m = clean.match(/(\d+)분/);
  if (m) { total += Number(m[1]); matched = true; }
  if (!matched) {
    const onlyNum = clean.match(/^(\d+)$/);
    if (onlyNum) { total = Number(onlyNum[1]); matched = true; } // 단위 없이 숫자만이면 분으로 봐요
  }
  return matched && total > 0 ? total : null;
}

/** 공연 장소 텍스트(API spatial)를 site.geojson 이름으로 매칭해요. 애매하면(평화의광장처럼
 * 무대 A/B 선택이 필요한 곳 등) 확인용 플래그만 붙이고 추측하지 않아요(CLAUDE.md 2번). */
const SITE_KEYWORDS = [
  ["KSPO DOME", "KSPO DOME"],
  ["체조경기장", "KSPO DOME"],
  ["핸드볼", "티켓링크 라이브 아레나(SK올림픽핸드볼경기장)"],
  ["우리금융아트홀", "우리금융아트홀"],
  ["K아트홀", "올림픽공원 K아트홀"],
  ["올림픽홀", "올림픽홀"],
  ["테니스", "올림픽공원 테니스경기장"],
  ["벨로드롬", "올림픽공원 벨로드롬"],
  ["88호수", "88호수 수변무대 무대"],
  ["수변무대", "88호수 수변무대 무대"],
  ["88잔디마당", "88잔디마당 무대"],
  ["잔디마당", "88잔디마당 무대"],
  ["장미광장", "장미광장"],
];
export function matchSite(spatialText) {
  if (typeof spatialText !== "string") return { site: null, flags: ["장소미확인"] };
  if (spatialText.includes("평화의광장")) return { site: null, flags: ["무대선택필요_평화의광장"] }; // 무대 A·B 중 사람이 골라야 함
  for (const [kw, site] of SITE_KEYWORDS) {
    if (spatialText.includes(kw)) return { site, flags: [] };
  }
  return { site: null, flags: ["장소미확인"] };
}

/**
 * fetchPerformances의 ok:true 결과(raw) → EventRecord[]로 바꿔요. 값이 없거나 못 읽은
 * 항목은 지어내지 않고 그대로 null·플래그로 남겨요.
 * @returns {{title:string, site:string|null, 날짜:string|null, 시작:string|null, 소요분:number|null, 출처:"공단API", flags:string[], 원본장소텍스트:string|null}[]}
 */
export function parsePerformanceResponse(raw) {
  const items = extractItems(raw) ?? [];
  return items.map((it) => {
    const spatial = it.spatial ?? it.eventSite ?? null;
    const { site, flags } = matchSite(spatial);
    const temporalCoverage = it.temporalCoverage ?? null;
    const extent = it.extent ?? null;
    const startTime = parseStartTime(temporalCoverage);
    const durationMin = parseDurationMinutes(extent);
    if (temporalCoverage && !startTime) flags.push("시작시각형식미확인");
    if (extent && !durationMin) flags.push("소요시간형식미확인");
    if (!temporalCoverage) flags.push("시작시각없음");
    // 날짜는 흔히 title이나 별도 필드에 있는데, 11/19 확인 때 날짜 전용 필드 이름은 못
    // 봤어요 — eventStartDate가 있으면 쓰고, 없으면 null(지어내지 않음, 확인 필요).
    const 날짜 = it.eventStartDate ?? null;
    return {
      title: it.title ?? "(제목 없음)",
      site, 날짜, 시작: startTime, 소요분: durationMin,
      출처: "공단API", flags, 원본장소텍스트: spatial,
    };
  });
}

// --- 확인할 것 (KCISA_SERVICE_KEY 등록 후 실제 응답으로 다시 봐야 함) ---
// 1) items가 실제로 어느 자리에 있는지(extractItems의 후보 중 맞는 것).
// 2) 날짜 필드 이름(eventStartDate는 추정 — 다른 이름일 수 있음).
// 3) spatial 필드가 실제로 장소를 어떻게 적는지(SITE_KEYWORDS 키워드가 실제 표기와 맞는지).
