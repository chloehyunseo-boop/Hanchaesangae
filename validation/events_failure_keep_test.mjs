// 공연 수집 실패 시 직전 성공본 유지 검증 (11/28 최종 점검). 실행: node validation/events_failure_keep_test.mjs
import { mergeWithPrevious } from "../scripts/update-events.mjs";
let fails = 0;
const ok = (c, m, x = "") => { console.log(`${c ? "✓" : "✗"} ${m}${x ? `  → ${x}` : ""}`); if (!c) fails++; };

const up = (id, title) => ({ 출처: "공단일정페이지", 공단일정번호: id, title, 기간시작: "2026-12-04" });
const past = (title) => ({ 출처: "공단API", title });
const prev = [up("1", "이승철"), up("2", "비"), past("옛 공연")];

// 1) 전부 성공 → 새로 받은 것만(사라진 공연은 빠짐)
let r = mergeWithPrevious([up("1", "이승철")], prev, { upcomingIncomplete: false, apiFailed: false });
ok(r.length === 1, "전부 성공하면 새로 받은 목록 그대로", `${r.length}건`);

// 2) 일정 조회가 전부 실패(새 목록 0건) → 직전 일정 유지, 과거 기록(API)은 새로 받은 것만
r = mergeWithPrevious([], prev, { upcomingIncomplete: true, apiFailed: false });
ok(r.filter((e) => e.출처 === "공단일정페이지").length === 2, "일정 조회 실패 → 직전 앞으로 있을 공연 2건 유지");
ok(!r.some((e) => e.출처 === "공단API"), "API는 성공했으니 직전 과거 기록은 안 끌어옴(새 목록 기준)");

// 3) 일부만 실패(이번 달만 받음) → 새것 우선, 못 받은 달 공연은 직전 것으로 채움, 중복 없음
r = mergeWithPrevious([up("1", "이승철(수정됨)")], prev, { upcomingIncomplete: true, apiFailed: false });
ok(r.length === 2 && r.find((e) => e.공단일정번호 === "1").title === "이승철(수정됨)", "새로 받은 것이 우선, 중복 없음", JSON.stringify(r.map((e) => e.title)));
ok(r.some((e) => e.공단일정번호 === "2"), "못 받은 달의 공연은 직전 것으로 채움");

// 4) API 실패 → 과거 기록 유지
r = mergeWithPrevious([up("1", "이승철")], prev, { upcomingIncomplete: false, apiFailed: true });
ok(r.some((e) => e.출처 === "공단API"), "API 실패 시 직전 과거 기록 유지");

// 5) 직전 파일이 없을 때(첫 실행)
r = mergeWithPrevious([], [], { upcomingIncomplete: true, apiFailed: true });
ok(Array.isArray(r) && r.length === 0, "직전 파일이 없어도 에러 없이 빈 목록");

console.log(fails ? `\n실패 ${fails}건` : "\n전부 통과");
if (fails) process.exitCode = 1;
