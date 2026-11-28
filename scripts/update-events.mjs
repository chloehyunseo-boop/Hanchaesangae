// scripts/update-events.mjs
// GitHub Actions가 매시 50분에 실행해요(.github/workflows/update-data.yml).
// 공단 데이터 2곳을 받아 data/events.json을 갱신해요.
// 인증키는 환경변수(KCISA_SERVICE_KEY)로만 받아요 — 코드·커밋에는 절대 안 넣어요.

import { writeFile } from "node:fs/promises";
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
  const nextYm = ymOf(new Date(now.getTime() + 32 * 86400e3));
  const months = [];
  let monthFail = false;
  for (const ym of [thisYm, nextYm]) {
    const r = await fetchScheduleMonth(ym);
    if (r.ok) months.push(parseScheduleMonthJson(r.json));
    else { monthFail = true; 실패기록.push({ 시각: now.toISOString(), 사유: `월별 일정(${ym}): ${r.사유}` }); }
  }
  if (monthFail || months.length === 0) {
    const scheduleRes = await fetchUpcomingSchedulePage();
    if (scheduleRes.ok) months.push(parseUpcomingScheduleHtml(scheduleRes.html));
    else 실패기록.push({ 시각: now.toISOString(), 사유: `일정안내 페이지: ${scheduleRes.사유}` });
  }
  공연.push(...mergeScheduleLists(...months));

  const record = {
    _설명: "GitHub Actions가 매시 50분에 갱신해요. 출처 '공단API'는 과거 공연 기록(사례 재현용), '공단일정페이지'는 앞으로 있을 공연(공단 홈페이지 일정안내의 이번 달·다음 달)이에요. 수동 입력은 agency.html의 이 브라우저 저장소(localStorage)에 따로 있어요.",
    저장시각: now.toISOString(),
    공연,
    실패기록,
  };

  await writeFile(new URL("../data/events.json", import.meta.url), JSON.stringify(record, null, 2) + "\n");

  if (공연.length === 0 && 실패기록.length > 0) {
    console.error("공연 일정을 하나도 못 받았어요:", 실패기록);
    process.exitCode = 1;
  } else {
    console.log(`공연 ${공연.length}건 자동 수집(공단API+일정페이지 합계), 실패 ${실패기록.length}건`);
  }
}

main();
