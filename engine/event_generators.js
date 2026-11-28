// engine/event_generators.js — 실제 공연 일정 → 발전차 자동 생성 (하린 라인, 11/26)
//
// 왜: 시민 화면은 발전차를 아무도 입력하지 않으면 배출가스가 하나도 안 나왔어요(발전차 대수
// 기본 0). 공단 11/26 답변으로 "발전차는 모든 공연장에서 사용"이 확인됐으니, 12/1 데모까지는
// 공연이 있는 날 그 공연장에 발전차를 자동으로 넣어요(하린 결정, 옵션 A).
//
// 대수 규칙(하린 11/26 결정, 11/27 재검토 후 확정 — 근거는 docs/발전차_배출가스_가정값과_근거.md 끝):
//   공단이 확인해 준 공연장별 값이 있으면 그 값, 없으면 확인된 최소(1대).
//   → KSPO DOME 5대(VB0000130509: 2026-02부터 최대 4~5대 제한), 나머지 1대.
//   숫자는 data/assumptions.json `발전차_기본대수`에만 있어요(코드에 안 박음).
//
// 시간: 공연 시작·종료는 app/shared.js buildRealEventStageSources와 똑같은 규칙(종료 = 시작+3시간,
// 옥외는 21:30 중 먼저)을 써요 — validation/event_generators_test.mjs가 두 결과가 같은지 확인해요.
// 가동 시작은 엔진(generatorActivityAtHour)이 정해요: setupStart가 있으면 그때, 없으면 시작 2시간 전.
// 그날 시작 시각을 모르면 time.출처 "미확인"으로 넣어요 → 엔진이 그 칸을 비워요(11/22 결정:
// 발전차 하나라도 가동 시간을 모르면 칸 전체를 비움 — 일부만 빼면 과소평가).
//
// 위치: 11/27 공단 회신(지도 표시)으로 KSPO DOME·88잔디마당·티켓링크 라이브 아레나·올림픽홀은
// assumptions.발전차_위치 좌표를 써요. 나머지는 site.geojson 공연장 좌표. 여러 대면 한 점에 겹쳐요.
// 사양: 비워 둬요 → plume_v2가 대표모델(Cat XQ230) 가정값과 꼬리표를 붙여요.

const ASSUMED_DURATION_MS = 3 * 3600 * 1000; // app/shared.js PERFORMANCE_ASSUMED_DURATION_MS와 같아야 함
const OUTDOOR_CUTOFF_HHMM = "21:30:00"; // app/shared.js OUTDOOR_CUTOFF_HHMM과 같아야 함
const INDOOR_KINDS = /^실내/;

function kstDateStr(hourIso) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(new Date(hourIso)); // "YYYY-MM-DD"
}

// app/shared.js의 weekdayOfDateStr와 같은 규칙(JS Date.getUTCDay(), 0=일~6=토) — 11/27
// expandWeekdayScheduleToDates(engine/events.js)가 요일만 적힌 자유문장을 펼친 공연(ev.공연요일)이
// 이 날짜에 실제로 하는지 확인할 때 써요.
function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** 11/29 버그 수정(하린 발견): 공연 위치가 '무대' 이름(site.geojson 음원 점, 예: "88잔디마당 무대")이면
 * 발전차 대수·위치·실내외 규칙은 그 무대가 속한 공연장(assumptions 기본안_계산대상·발전차_위치의 이름)으로
 * 찾아야 해요. 전에는 무대 이름 그대로 찾아서 0대가 됐어요(공단 일정의 88잔디마당·수변무대 공연 포함). */
const VENUE_OF_STAGE = {
  "88잔디마당 무대": "88잔디마당",
  "88호수 수변무대 무대": "88호수 수변무대",
  "평화의광장 무대 A": "평화의광장",
  "평화의광장 무대 B(세계평화의문 앞)": "평화의광장",
};
export function venueOfSite(site) {
  return VENUE_OF_STAGE[site] ?? site;
}

/** 공연장별 발전차 위치: 공단이 알려준 위치(assumptions.발전차_위치)가 있으면 그 좌표, 없으면 공연장 좌표. */
export function generatorPosition(site, feature, assumptions) {
  const p = assumptions?.발전차_위치?.공연장별?.[venueOfSite(site)];
  if (p && Number.isFinite(p.lat) && Number.isFinite(p.lon)) return { lat: p.lat, lon: p.lon, 위치출처: "공단회신" };
  const [lon, lat] = feature.geometry.coordinates;
  return { lat, lon, 위치출처: "공연장좌표" };
}

/** 공연장 이름 → 기본 대수. 매연 계산 대상이 아니면 0. */
export function defaultGeneratorCount(site, assumptions) {
  const venues = assumptions?.기본안_계산대상?.venues ?? [];
  const venue = venueOfSite(site);
  const v = venues.find((x) => x.site === venue);
  if (!v || v.매연_포함 !== true) return 0;
  const rule = assumptions?.발전차_기본대수;
  if (!rule) return 0; // 규칙이 없으면 만들지 않음(지어내지 않음)
  const n = rule.공연장별?.[venue]?.대수 ?? rule.확인안된_공연장;
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * 그 시각(hourIso)이 속한 날짜에 열리는 실제 공연(data/events.json, 공단일정페이지)마다 발전차를 만들어요.
 * opts.noGeneratorDays: [{site, 날짜:"YYYY-MM-DD"}] 공단이 '발전차 사용 안 함'으로 표시한 날
 * opts.enteredDays:     [{site, 날짜}] 공단이 실제 발전차를 입력한 날(그 입력이 대신 들어감)
 * opts.enteredAllDaysSites: [site] 날짜 없이 입력된 발전차가 있는 곳(상시 가동 입력 → 그 공연장은 자동 생성 안 함)
 * @returns {Array<{lat:number, lon:number, 정보출처:string, 대수근거:string, site:string, time:object}>}
 */
export function buildRealEventGeneratorSources(events, siteByName, assumptions, hourIso, opts = {}) {
  const out = [];
  if (!events?.공연) return out;
  const dateStr = kstDateStr(hourIso);
  // 11/27 하린: 공단이 "이 공연장 이날은 발전차 안 씀"이라고 표시한 곳(공단 화면 '발전차 사용 안 함')과
  // 공단이 실제 발전차를 입력한 곳(그 값이 우선)은 기본 대수를 넣지 않아요.
  const skip = new Set([...(opts.noGeneratorDays ?? []), ...(opts.enteredDays ?? [])]
    .filter((x) => x?.site && x?.날짜).map((x) => `${x.site}|${x.날짜}`));
  const skipWholeSite = new Set(opts.enteredAllDaysSites ?? []);
  const venues = assumptions?.기본안_계산대상?.venues ?? [];
  for (const ev of events.공연) {
    if (ev.출처 !== "공단일정페이지") continue; // 과거 기록(공단API)은 예보에 안 씀
    if (!ev.기간시작 || !ev.기간끝 || dateStr < ev.기간시작 || dateStr > ev.기간끝) continue;
    // 11/27: 요일만 적힌 원문을 펼친 공연(공연요일)은, 글에 없는 요일이면 확인된 휴무예요
    // (app/shared.js buildRealEventStageSources와 같은 규칙 — event_generators_test.mjs가 확인).
    if (Array.isArray(ev.공연요일) && !ev.공연요일.includes(weekdayOf(dateStr))) continue;
    if (skip.has(`${ev.site}|${dateStr}`) || skipWholeSite.has(ev.site)) continue;
    const count = defaultGeneratorCount(ev.site, assumptions);
    if (count === 0) continue;
    const feature = siteByName.get(ev.site);
    if (!feature) continue;
    const pos = generatorPosition(ev.site, feature, assumptions);
    const { lat, lon } = pos;
    const indoor = INDOOR_KINDS.test(venues.find((x) => x.site === venueOfSite(ev.site))?.종류 ?? "");

    let time;
    const startStr = ev.일자별시작?.[dateStr];
    const startMs = startStr ? new Date(`${dateStr}T${startStr}:00+09:00`).getTime() : NaN;
    if (!Number.isFinite(startMs)) {
      time = { start: null, end: null, 출처: "미확인" };
    } else {
      // 11/27: 하루 여러 공연이면(예: 토 15시·19시) 일자별최종공연시작의 마지막 공연 시각
      // 기준으로 종료를 잡아요(app/shared.js buildRealEventStageSources와 같은 규칙).
      const lastShowStr = ev.일자별최종공연시작?.[dateStr] ?? startStr;
      const lastShowMs = new Date(`${dateStr}T${lastShowStr}:00+09:00`).getTime();
      let endMs = (Number.isFinite(lastShowMs) ? lastShowMs : startMs) + ASSUMED_DURATION_MS;
      if (!indoor) endMs = Math.min(endMs, new Date(`${dateStr}T${OUTDOOR_CUTOFF_HHMM}+09:00`).getTime());
      time = {
        start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(),
        출처: "공단일정페이지_종료시각가정(마지막 공연+3시간 또는 21:30 중 먼저)",
      };
    }
    const 대수근거 = assumptions.발전차_기본대수.공연장별?.[venueOfSite(ev.site)] ? "공단확인값" : "확인된최소";
    for (let i = 0; i < count; i++) {
      out.push({ lat, lon, 위치출처: pos.위치출처, site: ev.site, 정보출처: "공연일정자동_대수가정", 대수근거, time });
    }
  }
  return out;
}
