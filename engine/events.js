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
// 11/25 KCISA_SERVICE_KEY 등록 후 실제 호출로 전체 필드를 확인했어요(100건 수신, 실패 0건):
// title, alternativeTitle, creator, regDate, collectionDb, subjectCategory, subjectKeyword,
// extent, description, spatial, temporalCoverage, person, language, sourceTitle, rights,
// copyrightOthers, uci, contributor — 표준 메타데이터(Dublin Core류) 그대로였어요. 날짜
// 전용 필드는 없어요(regDate는 "DB 등록일"이라 공연 날짜가 아니에요, parseEventDate 참고).
// 응답은 type=json을 줘도 XML로 와요(parseApiResponseText가 처리). items 자리는
// response.body.items.item 확인됨.

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
  // 11/25 실제 키로 호출해 확인: "type=json"을 줘도 XML을 그대로 돌려줘요. 공공 표준
  // 메타데이터 API들이 흔히 쓰는 파라미터 이름 "resultType"도 같이 보내 보지만(둘 다 안
  // 먹혀도 무해함), 그래도 XML이 오면 아래에서 직접 파싱해서 어느 쪽이든 안 깨지게 해요.
  url.searchParams.set("type", "json");
  url.searchParams.set("resultType", "json");

  try {
    const res = await fetch(url.toString());
    if (!res.ok) return { ok: false, 사유: `HTTP ${res.status}` };
    const text = await res.text();
    const parsed = parseApiResponseText(text);
    if (!parsed.ok) return parsed;
    const items = extractItems(parsed.body);
    if (items === null) return { ok: false, 사유: "응답 형식을 못 알아봤어요(items 자리를 못 찾음)" };
    return { ok: true, raw: parsed.body, totalCount: parsed.totalCount ?? null };
  } catch (err) {
    return { ok: false, 사유: `호출 실패: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * 응답 본문(JSON 또는 XML 문자열)을 공통 모양({response:{body:{items:{item:[...]}}}})으로 바꿔요.
 * 11/25에 실제 키로 호출해 보니 이 API는 JSON을 요청해도 XML을 줘요 — Node엔 XML 파서가
 * 기본으로 없어서, 이 API 응답처럼 안에 다른 태그가 없는 단순한 <item>태그들만 직접 읽어요
 * (CDATA·& 이스케이프 정도만 풀어줘요. 더 복잡한 XML이 오면 그때 제대로 된 파서로 바꿔야 해요).
 */
// 11/25 실제 호출로 확인: resultCode가 "00"이 아니어도(이 API는 성공할 때 다른 코드를
// 쓰는 듯) resultMsg가 "OK"로 성공을 알려 주는 걸 보고서야 알았어요 — "00"만 성공으로
// 치던 첫 수정이 진짜 성공 응답을 에러로 잘못 판정했어요(사유: "공단 API 오류 응답: OK"로
// 재현됨). resultCode 값 자체(기관마다 성공 코드가 다름, "00"·"0000"·"200" 등 추정)에
// 기대지 않고, resultMsg가 실제로 오류처럼 보이는 단어를 담고 있을 때만 실패로 쳐요.
const ERROR_LIKE_RESULT_MSG = /error|오류|실패|invalid|not\s*valid|등록되지|거부|fail/i;

export function parseApiResponseText(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("<")) {
    // 전체 몇 건 중 몇 번째 페이지인지 알아야 "최근 등록분"쪽 페이지로 점프해 볼 수 있어요
    // (11/25 발견: 1페이지가 전부 2013~2019년 과거 기록이라 최근 공연이 있는지 확인용).
    const totalCount = Number(trimmed.match(/<totalCount>(\d+)<\/totalCount>/)?.[1]) || null;
    const items = parseXmlItems(trimmed);
    if (items.length > 0) return { ok: true, body: { response: { body: { items: { item: items } } } }, totalCount };
    // 항목이 하나도 없을 때만 resultMsg를 봐요 — 진짜 오류인지, 그냥 "지금 해당 공연 없음"인지.
    const resultMsg = trimmed.match(/<resultMsg>([\s\S]*?)<\/resultMsg>/)?.[1]?.trim();
    if (resultMsg && ERROR_LIKE_RESULT_MSG.test(resultMsg)) {
      return { ok: false, 사유: `공단 API 오류 응답: ${resultMsg}` };
    }
    return { ok: true, body: { response: { body: { items: { item: [] } } } }, totalCount }; // 정상이지만 0건
  }
  try {
    return { ok: true, body: JSON.parse(trimmed) };
  } catch {
    return { ok: false, 사유: `JSON도 XML도 아닌 응답이에요(앞부분: ${trimmed.slice(0, 80)})` };
  }
}

function decodeXmlEntities(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&")
    .trim();
}

/** <item>...</item>가 반복되는 단순 구조만 읽어요(이 API가 그렇게 와요, 11/25 확인). */
function parseXmlItems(xmlText) {
  const items = [];
  // .match(/g)는 <item>…</item> 전체(바깥 태그 포함)를 돌려줘서, 그 안에서 필드를 다시
  // 찾으면 바깥 <item> 태그 자체가 "item"이라는 한 필드로 통째로 잡혀버려요(11/25 발견,
  // 테스트로 확인) — 캡처 그룹(안쪽 내용만)을 쓰는 matchAll로 고쳐요.
  for (const itemMatch of xmlText.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const inner = itemMatch[1];
    const obj = {};
    for (const fieldMatch of inner.matchAll(/<(\w+)>([\s\S]*?)<\/\1>/g)) {
      obj[fieldMatch[1]] = decodeXmlEntities(fieldMatch[2]);
    }
    items.push(obj);
  }
  return items;
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

/**
 * "2026-11-25", "2026.11.25", "2026년 11월 25일" 같은 날짜를 "YYYY-MM-DD"로 바꿔요.
 * 11/25 실제 응답으로 확인: 이 API엔 날짜 전용 필드가 없어요(진단 로그로 필드를 전부
 * 봤더니 title·creator·regDate·spatial·temporalCoverage·extent·description 등 표준
 * 메타데이터뿐 — regDate는 "DB에 등록한 날짜"라 공연 날짜가 아니에요, 안 써요). 날짜는
 * temporalCoverage나 description 문장 속에 섞여 있을 때만 여기서 뽑아내요 — 못 찾으면
 * null이에요(지어내지 않음, CLAUDE.md 2번).
 * @returns {string|null}
 */
export function parseEventDate(raw) {
  if (typeof raw !== "string") return null;
  let m = raw.match(/(\d{4})[.\-](\d{1,2})[.\-](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = raw.match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  return null;
}

/** 공연 장소 텍스트(API spatial)를 site.geojson 이름으로 매칭해요. 애매하면(평화의광장처럼
 * 무대 A/B 선택이 필요한 곳 등) 확인용 플래그만 붙이고 추측하지 않아요(CLAUDE.md 2번). */
const SITE_KEYWORDS = [
  ["KSPO DOME", "KSPO DOME"],
  ["체조경기장", "KSPO DOME"],
  ["핸드볼", "티켓링크 라이브 아레나(SK올림픽핸드볼경기장)"],
  ["티켓링크", "티켓링크 라이브 아레나(SK올림픽핸드볼경기장)"], // 11/28: 괄호 없이 "티켓링크 라이브 아레나"로만 적힌 경우
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
    // 날짜 전용 필드가 없어서(위 parseEventDate 설명 참고) temporalCoverage → description
    // 순서로 날짜를 찾아봐요. 둘 다 없으면 null + 플래그.
    const 날짜 = parseEventDate(temporalCoverage) ?? parseEventDate(it.description ?? null);
    if (!날짜) flags.push("날짜미확인");
    return {
      title: it.title ?? "(제목 없음)",
      site, 날짜, 시작: startTime, 소요분: durationMin,
      출처: "공단API", flags, 원본장소텍스트: spatial,
    };
  });
}

// --- 확인 끝(11/25, 실제 100건 응답으로) ---
// 1) items 자리: response.body.items.item 맞음.
// 2) 날짜 전용 필드 없음 — temporalCoverage/description에서 직접 찾아야 함(parseEventDate).
// 3) spatial 표기: "올림픽홀"처럼 site.geojson 이름과 겹치는 경우도, "뮤즈라이브"처럼
//    SITE_KEYWORDS에 없는 곳도 있었어요(올림픽공원 안 다른 시설이거나 공단 관할 밖일 수
//    있음 — 장소미확인으로 정직하게 남겨요. 나중에 자주 나오는 미확인 장소가 있으면
//    SITE_KEYWORDS에 추가하면 돼요).

// ---------------------------------------------------------------------------
// 공단 '일정안내' 페이지 스크래핑 (11/25 추가) — KSCperf API는 과거 기록(2013~2019)만
// 줘서(위에서 확인), 실제 "앞으로 있을 공연"은 API가 아니라 공단이 직접 운영하는 홈페이지
// 일정표에서만 볼 수 있어요. 로그인·키 없이 보이는 일반 공개 페이지라 바로 읽어요.
// ⚠️ 이건 공식 API가 아니라 페이지 구조를 그대로 읽는 거라, 공단이 사이트를 바꾸면
// 깨질 수 있어요(공식 데이터 계약이 아님 — API보다 약한 근거).
// ---------------------------------------------------------------------------
const SCHEDULE_PAGE_URL = "https://www.ksponco.or.kr/olympicpark/eventInfo/eventInfoList?mid=a20301010100";

/** 일정안내 페이지의 HTML을 그대로 가져와요(가공 없이). */
export async function fetchUpcomingSchedulePage() {
  try {
    const res = await fetch(SCHEDULE_PAGE_URL);
    if (!res.ok) return { ok: false, 사유: `HTTP ${res.status}` };
    const html = await res.text();
    if (!html.includes('id="rowSpace"')) {
      return { ok: false, 사유: "페이지 구조가 바뀐 것 같아요('rowSpace' 영역을 못 찾음) — 스크래핑 코드를 다시 봐야 해요" };
    }
    return { ok: true, html };
  } catch (err) {
    return { ok: false, 사유: `호출 실패: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * "2026-11-28 ~ 2027-01-03" → {기간시작, 기간끝}. 하루짜리("2026-11-27")만 있으면 둘 다
 * 같은 날짜예요. 못 읽으면 둘 다 null(지어내지 않음).
 */
export function parseDateRange(text) {
  if (typeof text !== "string") return { 기간시작: null, 기간끝: null };
  const dates = [...text.matchAll(/(\d{4})-(\d{2})-(\d{2})/g)].map((m) => m[0]);
  if (dates.length === 0) return { 기간시작: null, 기간끝: null };
  return { 기간시작: dates[0], 기간끝: dates[dates.length - 1] ?? dates[0] };
}

/**
 * "2026년 11월 27일(금) 오후 7시 2026년 11월 28일(토) 오후 6시 2026년 11월 29일(일) 오후 5시"
 * 같은 요일별 자유문장에서, "YYYY년 M월 D일 (오전|오후) H시(분?)" 패턴만 뽑아 날짜별
 * 시작시각(24시간, "HH:MM")으로 바꿔요(11/26, "공연 일정 → 지도 연결" 1단계). 11/27 보강:
 * "2026년 11월 27일(금) 8PM"처럼 영문 AM/PM 표기("H(AM|PM)")도 같이 읽어요(올림픽홀 실제
 * 원문이 이 형식이었어요 — 전엔 "오전/오후"만 읽어서 통째로 "시작시각미확인"으로 빠졌어요).
 * 이 패턴에 안 맞는 부분(예: "수목금 19시 30분"처럼 요일 묶음+시각만 있고 날짜가 없는 표현)은
 * `parseWeekdayGroupedTimes()`가 따로 읽어요 — 날짜가 명시된 부분만 믿을 수 있어서, 지어내지
 * 않아요(CLAUDE.md 2번).
 * @param {string|null} timeText
 * @returns {Record<string,string>} {"YYYY-MM-DD": "HH:MM"} — 못 읽으면 빈 객체.
 */
export function parseDailyStartTimes(timeText) {
  if (typeof timeText !== "string") return {};
  // 11/28: "9:00:00PM(KST)"·"07:00:00PM(KST)"·"7:30PM(KST)"처럼 콜론 붙은 영문 시각(초 포함
  // 가능, 뒤에 "(KST)" 등 꼬리말은 그냥 안 먹고 둬도 매치엔 지장 없음)도 읽게 세 번째 갈래 추가.
  const re = /(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일(?:\([^)]*\))?\s*(?:(오전|오후)\s*(\d{1,2})시(?:\s*(\d{1,2})분)?|(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)|(\d{1,2})\s*(AM|PM))/gi;
  const out = {};
  for (const m of timeText.matchAll(re)) {
    const [, y, mo, d, ampmKo, hKoRaw, minRaw, hColonRaw, minColonRaw, ampmColon, hEnRaw, ampmEn] = m;
    let h, min;
    if (ampmKo) {
      h = Number(hKoRaw);
      if (ampmKo === "오후" && h !== 12) h += 12;
      if (ampmKo === "오전" && h === 12) h = 0;
      min = minRaw ? Number(minRaw) : 0;
    } else if (hColonRaw) {
      h = Number(hColonRaw);
      const pm = ampmColon.toUpperCase() === "PM";
      if (pm && h !== 12) h += 12;
      if (!pm && h === 12) h = 0;
      min = Number(minColonRaw);
    } else {
      h = Number(hEnRaw);
      const pm = ampmEn.toUpperCase() === "PM";
      if (pm && h !== 12) h += 12;
      if (!pm && h === 12) h = 0;
      min = 0;
    }
    if (h < 0 || h > 23) continue; // 시각이 말이 안 되면(파싱 실수) 그 날짜는 건너뛰어요
    const dateKey = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    out[dateKey] = `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
  }
  return out;
}

const WEEKDAY_CHAR_TO_INDEX = { 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 }; // JS Date.getUTCDay()와 같은 규칙

/**
 * "수목금 19시 30분 / 토 15시, 19시 / 일 14시 (일자별 공연 시간 변동 있으며...)" 같은, 날짜
 * 없이 "요일 묶음 + 시각(복수 가능)"만 적힌 자유문장을 읽어요(11/27, 우리금융아트홀 실제
 * 원문). 날짜가 아예 없어서 parseDailyStartTimes는 못 읽는 형식이에요 — 요일별로 그날 공연이
 * 몇 시에 하는지(여러 번이면 전부) 모아서 돌려주고, 글에 언급 안 된 요일(이 예시의 월·화)은
 * "그 요일엔 공연 안 함"으로 간주해요(하린 11/27 지시) — 지어낸 휴무가 아니라, 공연 주최
 * 쪽이 적어둔 요일 목록 자체가 "공연하는 날"의 전부라고 보는 거예요.
 * @param {string|null} timeText
 * @returns {Record<number,string[]>} {요일(0=일~6=토): ["HH:MM", ...]} — 순서대로(첫 공연부터).
 */
export function parseWeekdayGroupedTimes(timeText) {
  if (typeof timeText !== "string") return {};
  // 11/28: "목 오후 7시 30분 / 금 오후 6시"처럼 요일 뒤에 "오전/오후"가 붙는 경우도 읽게 함.
  // 11/28 독립 검토: "5일 19시"의 "일"이나 "12월"의 "월"을 요일로 읽던 문제 — 요일 글자 바로 앞이 숫자면 요일이 아니에요.
  const groupRe = /(?<![0-9])([월화수목금토일]{1,3})\s*((?:(?:오전|오후)\s*)?(?:\d{1,2}시(?:\s*\d{1,2}분)?\s*,?\s*)+)/g;
  const timeRe = /(?:(오전|오후)\s*)?(\d{1,2})시(?:\s*(\d{1,2})분)?/g;
  const byWeekday = {};
  for (const gm of timeText.matchAll(groupRe)) {
    const days = [...gm[1]].map((ch) => WEEKDAY_CHAR_TO_INDEX[ch]).filter((n) => n !== undefined);
    if (days.length === 0) continue;
    const times = [];
    for (const tm of gm[2].matchAll(timeRe)) {
      const ampmKo = tm[1];
      let h = Number(tm[2]);
      if (ampmKo === "오후" && h !== 12) h += 12;
      if (ampmKo === "오전" && h === 12) h = 0;
      if (h < 0 || h > 23) continue;
      const min = tm[3] ? Number(tm[3]) : 0;
      times.push(`${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`);
    }
    if (times.length === 0) continue;
    for (const d of days) byWeekday[d] = times;
  }
  return byWeekday;
}

/** [기간시작, 기간끝] 사이 모든 날짜("YYYY-MM-DD")를 하루씩 돌려줘요. 상한(370일)은 날짜가
 * 깨져서 무한 반복하는 걸 막는 안전장치예요(generateGridPoints의 간격 검사와 같은 원칙). */
function* eachDateInRange(기간시작, 기간끝) {
  const startMs = new Date(`${기간시작}T00:00:00Z`).getTime();
  const endMs = new Date(`${기간끝}T00:00:00Z`).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return;
  const MAX_DAYS = 370;
  for (let i = 0, t = startMs; t <= endMs && i < MAX_DAYS; i++, t += 86400000) {
    yield new Date(t).toISOString().slice(0, 10);
  }
}

/** 날짜 문자열("YYYY-MM-DD")의 요일(0=일~6=토, JS Date.getUTCDay()와 같은 규칙)을 구해요. */
function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** parseDailyStartTimes가 날짜를 하나도 못 찾았을 때(원문에 날짜가 없고 요일만 있을 때)
 * parseWeekdayGroupedTimes + [기간시작,기간끝]로 날짜별 시작시각을 채워요(11/27). 요일에
 * 공연이 여러 번 있으면(토 15시,19시) 첫 공연을 일자별시작에, 마지막 공연을
 * 일자별최종공연시작에 넣어요(이름은 "마지막 공연까지 끝나야 진짜 종료" 계산용 — 종료 시각
 * 가정은 그 공연 호출 쪽에서 "마지막 공연 시작 + 3시간"으로 써요). 글에 없는 요일은
 * 공연요일 배열에서 빠져서 "그날은 공연 안 함"으로 구분돼요(상시가동으로 안 보임).
 * @returns {{일자별시작:Record<string,string>, 일자별최종공연시작:Record<string,string>, 공연요일:number[]|null}}
 */
export function expandWeekdayScheduleToDates(timeText, 기간시작, 기간끝) {
  const byWeekday = parseWeekdayGroupedTimes(timeText);
  const weekdays = Object.keys(byWeekday).map(Number);
  if (weekdays.length === 0 || !기간시작 || !기간끝) return { 일자별시작: {}, 일자별최종공연시작: {}, 공연요일: null };
  const 일자별시작 = {};
  const 일자별최종공연시작 = {};
  for (const dateStr of eachDateInRange(기간시작, 기간끝)) {
    const times = byWeekday[weekdayOf(dateStr)];
    if (!times) continue; // 글에 언급 안 된 요일 — 공연 안 함
    일자별시작[dateStr] = times[0];
    if (times.length > 1) 일자별최종공연시작[dateStr] = times[times.length - 1];
  }
  return { 일자별시작, 일자별최종공연시작, 공연요일: weekdays.sort((a, b) => a - b) };
}

/**
 * "2026.12.18. FRI 7PM / 12.19 SAT 6PM / 12.20 SUN 5PM(KST)"나 "12.24(목) 8PM 12.25(금) 5PM"
 * 처럼, "YYYY년 M월 D일" 형식이 아니라 점으로 적은 날짜(연도는 맨 앞에만 있거나 아예 없음) +
 * 영문 AM/PM 시각으로 된 자유문장을 읽어요(11/28). parseDailyStartTimes는 "년·월·일" 글자가
 * 없으면 못 읽는 형식이에요. 요일 표기(영문 3글자 "FRI"나 한글 괄호 "(목)")는 그냥 건너뛰고,
 * 날짜·시각만 믿어요. 연도가 안 적힌 항목은 바로 앞에 나온 연도를 이어서 쓰되, 월이 갑자기
 * 작아지면(예: 12월 → 1월) 해를 넘긴 걸로 보고 1년 더해요 — 지어내는 게 아니라 "12월 다음은
 * 1월"이라는 달력 순서를 따르는 거예요. 그래도 첫 항목에 연도가 아예 없으면 기간시작의
 * 연도를 빌려요.
 * @param {string|null} timeText
 * @param {string|null} 기간시작 "YYYY-MM-DD" — 연도를 하나도 못 찾았을 때의 출발점
 * @returns {Record<string,string>} {"YYYY-MM-DD": "HH:MM"} — 못 읽으면 빈 객체.
 */
export function parseShortDateTimes(timeText, 기간시작) {
  if (typeof timeText !== "string") return {};
  const re = /(?:(\d{4})\s*\.\s*)?(\d{1,2})\s*\.\s*(\d{1,2})\s*\.?\s*(?:\([^)]*\)\s*)?(?:[A-Z]{3}\s+)?(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/gi;
  const out = {};
  let year = 기간시작 ? Number(기간시작.slice(0, 4)) : null;
  let lastMonth = null;
  for (const m of timeText.matchAll(re)) {
    const [, yRaw, moRaw, dRaw, hRaw, minRaw, ampm] = m;
    const mo = Number(moRaw);
    const d = Number(dRaw);
    if (yRaw) {
      year = Number(yRaw);
    } else if (year === null) {
      continue; // 연도를 하나도 못 구하면(기간시작도 없음) 지어내지 않고 건너뜀
    } else if (lastMonth !== null && mo < lastMonth) {
      year += 1; // 12월 다음에 1월이 나오면 해가 바뀐 것
    }
    lastMonth = mo;
    let h = Number(hRaw);
    const pm = ampm.toUpperCase() === "PM";
    if (pm && h !== 12) h += 12;
    if (!pm && h === 12) h = 0;
    const min = minRaw ? Number(minRaw) : 0;
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h < 0 || h > 23) continue;
    const dateKey = `${year}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    out[dateKey] = `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
  }
  return out;
}

/**
 * 일정안내 페이지 HTML → EventRecord[]로 바꿔요(11/25 실제 페이지로 구조 확인). 맨 위
 * "앞으로 있을 공연" 영역(id="rowSpace")만 읽고, 그 아래 "지난 공연"(class="last") 구간은
 * 안 읽어요. 공연마다 요일별 시간이 다르게 적혀 있어서(예: "수목금 19시30분/토 15시,19시")
 * 그 전부를 안전하게 구조화하긴 어려워요 — 날짜가 박힌 형식이면 일자별시작을 바로 채우고,
 * 요일만 적힌 자유문장이면(11/27) expandWeekdayScheduleToDates로 날짜 범위에 펼쳐요. 시간
 * 원문은 그대로(`원본시간텍스트`) 남겨서 지어내지 않아요.
 * ⚠️ <head>의 <script> 안에도 똑같은 HTML 조각(AJAX 템플릿 문자열)이 들어있어서, 반드시
 * "rowSpace" 섹션 범위 안에서만 찾아야 해요 — 전체 페이지에서 찾으면 스크립트 템플릿까지
 * 걸려서 완전히 엉뚱한 값이 나와요(11/25 실제로 겪은 버그, 테스트로 남겨둠).
 * @returns {{title:string, site:string|null, 날짜:null, 기간시작:string|null, 기간끝:string|null,
 *   시작:null, 소요분:null, 일자별시작:Record<string,string>, 일자별최종공연시작:Record<string,string>,
 *   공연요일:number[]|null, 출처:"공단일정페이지", flags:string[],
 *   원본장소텍스트:string|null, 원본시간텍스트:string|null}[]}
 */
export function parseUpcomingScheduleHtml(html) {
  const startIdx = html.indexOf('id="rowSpace"');
  if (startIdx === -1) return [];
  const lastIdx = html.indexOf('<div class="last">');
  const section = lastIdx === -1 ? html.slice(startIdx) : html.slice(startIdx, lastIdx);

  const itemRe = /<em class="place">([\s\S]*?)<\/em>\s*<strong class="title">([\s\S]*?)<\/strong>[\s\S]*?<span class="date">([\s\S]*?)<\/span>\s*<small class="time"\s*>?([\s\S]*?)<\/small>/g;
  const out = [];
  for (const m of section.matchAll(itemRe)) {
    out.push(buildUpcomingItem({
      spatial: decodeXmlEntities(m[1]), title: decodeXmlEntities(m[2]),
      dateText: decodeXmlEntities(m[3]), timeText: decodeXmlEntities(m[4]),
    }));
  }
  return out;
}

/** 일정 한 건(장소·제목·기간 글·시간 글) → events.json 공연 한 건. 페이지(HTML)와 월별 조회(JSON)가 같이 써요. */
function buildUpcomingItem({ spatial, title, dateText, timeText, durationText = null, evtSeq = null }) {
  const { site, flags } = matchSite(spatial);
  const { 기간시작, 기간끝 } = parseDateRange(dateText);
  if (!기간시작) flags.push("날짜미확인");
  let 일자별시작 = parseDailyStartTimes(timeText);
  let 일자별최종공연시작 = {};
  let 공연요일 = null;
  // 11/28: "년·월·일" 형식이 아니라 "2026.12.18. FRI 7PM"·"12.24(목) 8PM"처럼 점으로 적은
  // 날짜+영문 AM/PM이면 parseDailyStartTimes가 못 읽어요 — 다음으로 이 형식을 시도해요.
  if (Object.keys(일자별시작).length === 0) {
    일자별시작 = parseShortDateTimes(timeText, 기간시작);
  }
  // 11/27: 그래도 못 읽었으면(날짜 자체가 없고 요일만 적힌 자유문장, "수목금 19시 30분 /
  // 토 15시, 19시 / 일 14시") 요일 묶음으로 다시 시도해요.
  if (Object.keys(일자별시작).length === 0) {
    const expanded = expandWeekdayScheduleToDates(timeText, 기간시작, 기간끝);
    일자별시작 = expanded.일자별시작;
    일자별최종공연시작 = expanded.일자별최종공연시작;
    공연요일 = expanded.공연요일;
  }
  if (Object.keys(일자별시작).length === 0) flags.push("시작시각미확인");
  return {
    title, site, 날짜: null, 기간시작, 기간끝, 시작: null, 소요분: null, 일자별시작,
    일자별최종공연시작, 공연요일,
    출처: "공단일정페이지", flags, 원본장소텍스트: spatial, 원본시간텍스트: timeText || null,
    // 11/28: 월별 조회에서만 오는 값. 소요 시간은 원문 그대로 남기고 계산(종료 3시간 가정)엔 아직 안 써요.
    ...(durationText !== null ? { 원본소요시간텍스트: String(durationText).trim() || null } : {}),
    ...(evtSeq !== null ? { 공단일정번호: evtSeq } : {}),
  };
}

// ---------------------------------------------------------------------------
// 11/28 하린 발견: 일정안내 페이지(HTML)는 "이번 달"만 보여줘서 다음 달 공연(예: 12/4 KSPO DOME)이
// 빠졌어요. 같은 페이지가 월 버튼을 누를 때 부르는 월별 조회 주소(eventInfoListAjax.es,
// 요청 {nowYM:"YYYYMM", plcCd:""} → 응답 [ [이번 달 공연...], [지난 공연...] ])로 이번 달·다음 달을
// 받아요. 이것도 공식 API가 아니라 페이지 내부 주소라 사이트가 바뀌면 깨질 수 있어요 — 실패하면
// update-events.mjs가 예전 방식(HTML 페이지)으로 돌아가요.
// ---------------------------------------------------------------------------
const SCHEDULE_MONTH_URL = "https://www.ksponco.or.kr/olympicpark/eventInfo/eventInfoListAjax.es";

/** 월별 일정 JSON을 그대로 가져와요. ym = "YYYYMM". */
export async function fetchScheduleMonth(ym) {
  try {
    const res = await fetch(SCHEDULE_MONTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json;charset=UTF-8" },
      body: JSON.stringify({ nowYM: ym, plcCd: "" }),
    });
    if (!res.ok) return { ok: false, 사유: `HTTP ${res.status}` };
    const json = await res.json();
    if (!Array.isArray(json) || !Array.isArray(json[0])) return { ok: false, 사유: "응답 모양이 바뀐 것 같아요(첫 칸이 목록이 아님)" };
    return { ok: true, json };
  } catch (err) {
    return { ok: false, 사유: `호출 실패: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** 월별 일정 JSON → 공연 목록(HTML 파서와 같은 모양). 응답 첫 칸(그 달 공연)만 써요. */
export function parseScheduleMonthJson(json) {
  const list = Array.isArray(json?.[0]) ? json[0] : [];
  return list.filter((x) => x && x.delYn !== "Y").map((x) => buildUpcomingItem({
    spatial: String(x.plc ?? "").trim(), title: String(x.title ?? "").trim(),
    dateText: `${x.beginDt ?? ""} ~ ${x.endDt ?? ""}`, timeText: String(x.tm ?? "").trim(),
    durationText: x.ndTm ?? "", evtSeq: x.evtSeq ?? null,
  }));
}

/** 여러 달 결과를 합치며 같은 공연(공단일정번호, 없으면 제목+시작일)은 한 번만 남겨요. */
export function mergeScheduleLists(...lists) {
  const seen = new Set();
  const out = [];
  for (const it of lists.flat()) {
    const k = it.공단일정번호 ?? `${it.title}|${it.기간시작}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}
