// engine/event_generators.js — 실제 공연 일정 → 발전차 자동 생성 (하린 라인, 11/26)
//
// 왜: 시민 화면은 발전차를 아무도 입력하지 않으면 배출가스가 하나도 안 나왔어요(발전차 대수
// 기본 0). 공단 11/26 답변으로 "발전차는 모든 공연장에서 사용"이 확인됐으니, 12/1 데모까지는
// 공연이 있는 날 그 공연장에 발전차를 자동으로 넣어요(하린 결정, 옵션 A).
//
// 대수 규칙(하린 11/26 결정, "나중에 다시 검토" 표시):
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

/** 공연장별 발전차 위치: 공단이 알려준 위치(assumptions.발전차_위치)가 있으면 그 좌표, 없으면 공연장 좌표. */
export function generatorPosition(site, feature, assumptions) {
  const p = assumptions?.발전차_위치?.공연장별?.[site];
  if (p && Number.isFinite(p.lat) && Number.isFinite(p.lon)) return { lat: p.lat, lon: p.lon, 위치출처: "공단회신" };
  const [lon, lat] = feature.geometry.coordinates;
  return { lat, lon, 위치출처: "공연장좌표" };
}

/** 공연장 이름 → 기본 대수. 매연 계산 대상이 아니면 0. */
export function defaultGeneratorCount(site, assumptions) {
  const venues = assumptions?.기본안_계산대상?.venues ?? [];
  const v = venues.find((x) => x.site === site);
  if (!v || v.매연_포함 !== true) return 0;
  const rule = assumptions?.발전차_기본대수;
  if (!rule) return 0; // 규칙이 없으면 만들지 않음(지어내지 않음)
  const n = rule.공연장별?.[site]?.대수 ?? rule.확인안된_공연장;
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
    if (skip.has(`${ev.site}|${dateStr}`) || skipWholeSite.has(ev.site)) continue;
    const count = defaultGeneratorCount(ev.site, assumptions);
    if (count === 0) continue;
    const feature = siteByName.get(ev.site);
    if (!feature) continue;
    const pos = generatorPosition(ev.site, feature, assumptions);
    const { lat, lon } = pos;
    const indoor = INDOOR_KINDS.test(venues.find((x) => x.site === ev.site)?.종류 ?? "");

    let time;
    const startStr = ev.일자별시작?.[dateStr];
    const startMs = startStr ? new Date(`${dateStr}T${startStr}:00+09:00`).getTime() : NaN;
    if (!Number.isFinite(startMs)) {
      time = { start: null, end: null, 출처: "미확인" };
    } else {
      let endMs = startMs + ASSUMED_DURATION_MS;
      if (!indoor) endMs = Math.min(endMs, new Date(`${dateStr}T${OUTDOOR_CUTOFF_HHMM}+09:00`).getTime());
      time = {
        start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(),
        출처: "공단일정페이지_종료시각가정(3시간 또는 21:30 중 먼저)",
      };
    }
    const 대수근거 = assumptions.발전차_기본대수.공연장별?.[ev.site] ? "공단확인값" : "확인된최소";
    for (let i = 0; i < count; i++) {
      out.push({ lat, lon, 위치출처: pos.위치출처, site: ev.site, 정보출처: "공연일정자동_대수가정", 대수근거, time });
    }
  }
  return out;
}
