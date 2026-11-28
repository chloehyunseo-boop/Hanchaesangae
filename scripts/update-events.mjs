// scripts/update-events.mjs
// GitHub Actions가 매시 50분에 실행해요(.github/workflows/update-data.yml).
// 공단 데이터 2곳을 받아 data/events.json을 갱신해요.
// 인증키는 환경변수(KCISA_SERVICE_KEY)로만 받아요 — 코드·커밋에는 절대 안 넣어요.

import { readFile, writeFile } from "node:fs/promises";
import { fetchPerformances, parsePerformanceResponse, fetchUpcomingSchedulePage, parseUpcomingScheduleHtml,
  fetchScheduleMonth, parseScheduleMonthJson, mergeScheduleLists } from "../engine/events.js";

// 수동 입력은 이 파일이 아니라 agency.html(공단 화면)의 localStorage에 있어요(발전차 입력과
// 같은 방식 — "공단 화면 입력은 그 브라우저에만 저장되는 시연 기능", 로드맵 문서).
// 이 스크립트는 공단이 내놓는 자동 자료 2가지만 다뤄요:
//  ① KSCperf API(과거 공연 기록, 2013~2019 — 11/25 확인) — 사례 재현·검증용으로 쓸모 있음.
//  ② 공단 '일정안내' 홈페이지(앞으로 있을 공연, 로그인·키 필요 없음) — 실제 예보에 쓸 자료.
// ①은 "확실히 과거"라서 범위 밖인 미래 공연은 안 섞여요, ②는 키 없이 긁는 거라 사이트가
// 바뀌면 깨질 수 있어요(engine/events.js의 fetchUpcomingSchedulePage 주석 참고).

async function main() {
  const serviceKey = process.env.KCISA_SERVICE_KEY;
  const now = new Date();
  const 실패기록 = [];
  let 공연 = [];

  // 11/28 최종 점검: 수집이 실패한 날 빈 목록으로 events.json을 덮어쓰면 화면이 '공연 없음'처럼
  // 보여요. 그래서 직전 성공본을 읽어 두고, 실패한 부분은 그대로 이어 받아요(mergeWithPrevious).
  let prev = null;
  try { prev = JSON.parse(await readFile(new URL("../data/events.json", import.meta.url), "utf8")); } catch { /* 첫 실행 */ }

  const apiRes = await fetchPerformances({ serviceKey });
  if (apiRes.ok) {
    공연.push(...parsePerformanceResponse(apiRes.raw));
  } else {
    실패기록.push({ 시각: now.toISOString(), 사유: `공단API: ${apiRes.사유}` });
  }

  // 11/28: 이번 달 + 다음 달을 월별 조회로 받아요(72시간 지도가 월을 넘어가도 공연이 보이게).
  // 둘 중 하나라도 실패하면 예전 방식(이번 달 HTML 페이지)도 같이 읽어 합쳐요.
  const ymOf = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit" }).format(d).replace("-", "");
  const thisYm = ymOf(now);
  // 11/28 독립 검토: 예전엔 '지금+32일'의 달을 썼는데 11/30에 돌리면 12월을 건너뛰고 1월이 됐어요(말일마다 반복).
  // 연·월 숫자에 1을 더해 계산해요.
  const nextYm = nextMonthYm(thisYm);
  const months = [];
  let monthFail = false;
  let okMonths = 0;
  for (const ym of [thisYm, nextYm]) {
    const r = await fetchScheduleMonth(ym);
    if (r.ok) { months.push(parseScheduleMonthJson(r.json)); okMonths++; }
    else { monthFail = true; 실패기록.push({ 시각: now.toISOString(), 사유: `월별 일정(${ym}): ${r.사유}` }); }
  }
  if (monthFail || months.length === 0) {
    const scheduleRes = await fetchUpcomingSchedulePage();
    if (scheduleRes.ok) months.push(parseUpcomingScheduleHtml(scheduleRes.html));
    else 실패기록.push({ 시각: now.toISOString(), 사유: `일정안내 페이지: ${scheduleRes.사유}` });
  }
  const upcomingIncomplete = okMonths < 2; // 이번 달·다음 달 중 월별 조회로 못 받은 달이 있음(예전 HTML 페이지는 이번 달만 줘서 완전하지 않아요)
  공연.push(...mergeScheduleLists(...months));
  공연 = mergeWithPrevious(공연, prev?.공연 ?? [], { upcomingIncomplete, apiFailed: !apiRes.ok && !!process.env.KCISA_SERVICE_KEY });

  // 11/28: 원문에서 시각을 못 읽은 날만, 다른 공개 출처로 직접 확인한 시각으로 채워요(data/events_time_supplement.json).
  try {
    const sup = JSON.parse(await readFile(new URL("../data/events_time_supplement.json", import.meta.url), "utf8")).보충 ?? [];
    applyTimeSupplement(공연, sup);
  } catch { /* 보충 파일이 없거나 깨졌으면 그냥 원문만 */ }

  const record = {
    _설명: "GitHub Actions가 매시 50분에 갱신해요. 출처 '공단API'는 과거 공연 기록(사례 재현용), '공단일정페이지'는 앞으로 있을 공연(공단 홈페이지 일정안내의 이번 달·다음 달)이에요. 수동 입력은 agency.html의 이 브라우저 저장소(localStorage)에 따로 있어요.",
    저장시각: now.toISOString(),
    // 앞으로 있을 공연을 마지막으로 빠짐없이 받은 시각(실패한 날은 이전 값 유지) — 화면이 '오래된 일정'을 알려 줄 때 써요.
    일정마지막성공시각: upcomingIncomplete ? (prev?.일정마지막성공시각 ?? prev?.저장시각 ?? null) : now.toISOString(),
    공연,
    실패기록,
  };

  await writeFile(new URL("../data/events.json", import.meta.url), JSON.stringify(record, null, 2) + "\n");

  if (실패기록.length > 0 && (공연.length === 0 || upcomingIncomplete)) {
    console.error("공연 일정을 다 받지 못했어요(못 받은 부분은 직전 성공본 유지):", 실패기록);
    process.exitCode = 1;
  } else {
    console.log(`공연 ${공연.length}건 자동 수집(공단API+일정페이지 합계), 실패 ${실패기록.length}건`);
  }
}

/** "202611" → "202612", "202612" → "202701". 연·월 숫자에 1을 더해요(날짜 일수로 더하면 말일에 한 달을 건너뛰어요). */
export function nextMonthYm(ym) {
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(4));
  return m === 12 ? `${y + 1}01` : `${y}${String(m + 1).padStart(2, "0")}`;
}

/**
 * 수집에 실패한 부분만 직전 성공본(prev)으로 채워요. 새로 받은 것(fresh)이 항상 우선이에요.
 *  - 앞으로 있을 공연('공단일정페이지'): 이번 달·다음 달 중 못 받은 달이 있으면 직전 목록에서 이어 받음
 *  - 과거 공연 기록('공단API'): 키가 있는데 호출이 실패했으면 직전 목록에서 이어 받음
 * 전부 성공했으면 fresh 그대로예요(사이트에서 사라진 공연은 그때 빠져요).
 */
export function mergeWithPrevious(fresh, prev, { upcomingIncomplete, apiFailed }) {
  const keep = [];
  if (upcomingIncomplete) keep.push(...prev.filter((e) => e.출처 === "공단일정페이지"));
  if (apiFailed) keep.push(...prev.filter((e) => e.출처 === "공단API"));
  if (!keep.length) return fresh;
  const freshUp = fresh.filter((e) => e.출처 === "공단일정페이지");
  const keyOf = (it) => it.공단일정번호 ?? `${it.title}|${it.기간시작}`;
  const seen = new Set(freshUp.map(keyOf));
  const add = keep.filter((e) => (e.출처 === "공단일정페이지" ? !seen.has(keyOf(e)) : true));
  return [...fresh, ...add];
}

/** 원문 시각이 없는 날짜만 채워요(원문이 우선). 채운 날짜와 출처를 공연에 같이 적어요. */
export function applyTimeSupplement(list, sup) {
  for (const it of sup) {
    const ev = list.find((e) => e.출처 === "공단일정페이지" && ((it.공단일정번호 && e.공단일정번호 === it.공단일정번호) || (e.title === it.title && e.site === it.site)));
    if (!ev) continue;
    ev.일자별시작 = ev.일자별시작 ?? {};
    const filled = [];
    for (const [d, t] of Object.entries(it.일자별시작 ?? {})) {
      if (ev.일자별시작[d]) continue;
      ev.일자별시작[d] = t;
      filled.push(d);
    }
    if (!filled.length) continue;
    ev.시각보충 = { 날짜: filled, 출처: it.출처, 출처주소: it.출처주소, 확인일: it.확인일 };
    ev.flags = (ev.flags ?? []).filter((f) => f !== "시작시각미확인");
    if (!ev.flags.includes("시각_외부출처보충")) ev.flags.push("시각_외부출처보충");
  }
  return list;
}

if (import.meta.url === `file://${process.argv[1]}`) main();
