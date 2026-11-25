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
 * 일정안내 페이지 HTML → EventRecord[]로 바꿔요(11/25 실제 페이지로 구조 확인). 맨 위
 * "앞으로 있을 공연" 영역(id="rowSpace")만 읽고, 그 아래 "지난 공연"(class="last") 구간은
 * 안 읽어요. 공연마다 요일별 시간이 다르게 적혀 있어서(예: "수목금 19시30분/토 15시,19시")
 * 그 전부를 안전하게 구조화하긴 어려워요 — 날짜 범위(기간시작·기간끝)만 뽑고, 시간
 * 원문은 그대로(`원본시간텍스트`) 남겨서 지어내지 않아요.
 * ⚠️ <head>의 <script> 안에도 똑같은 HTML 조각(AJAX 템플릿 문자열)이 들어있어서, 반드시
 * "rowSpace" 섹션 범위 안에서만 찾아야 해요 — 전체 페이지에서 찾으면 스크립트 템플릿까지
 * 걸려서 완전히 엉뚱한 값이 나와요(11/25 실제로 겪은 버그, 테스트로 남겨둠).
 * @returns {{title:string, site:string|null, 날짜:null, 기간시작:string|null, 기간끝:string|null,
 *   시작:null, 소요분:null, 출처:"공단일정페이지", flags:string[], 원본장소텍스트:string|null, 원본시간텍스트:string|null}[]}
 */
export function parseUpcomingScheduleHtml(html) {
  const startIdx = html.indexOf('id="rowSpace"');
  if (startIdx === -1) return [];
  const lastIdx = html.indexOf('<div class="last">');
  const section = lastIdx === -1 ? html.slice(startIdx) : html.slice(startIdx, lastIdx);

  const itemRe = /<em class="place">([\s\S]*?)<\/em>\s*<strong class="title">([\s\S]*?)<\/strong>[\s\S]*?<span class="date">([\s\S]*?)<\/span>\s*<small class="time"\s*>?([\s\S]*?)<\/small>/g;
  const out = [];
  for (const m of section.matchAll(itemRe)) {
    const spatial = decodeXmlEntities(m[1]);
    const title = decodeXmlEntities(m[2]);
    const dateText = decodeXmlEntities(m[3]);
    const timeText = decodeXmlEntities(m[4]);
    const { site, flags } = matchSite(spatial);
    const { 기간시작, 기간끝 } = parseDateRange(dateText);
    if (!기간시작) flags.push("날짜미확인");
    out.push({
      title, site, 날짜: null, 기간시작, 기간끝, 시작: null, 소요분: null,
      출처: "공단일정페이지", flags, 원본장소텍스트: spatial, 원본시간텍스트: timeText || null,
    });
  }
  return out;
}
