// 독립 검토(11/28 밤) 지적 수정 검증. 실행: TZ=Asia/Seoul node validation/review_fixes_1128.mjs
import { nextMonthYm } from "../scripts/update-events.mjs";
import { parseWeekdayGroupedTimes } from "../engine/events.js";
import { carryOverMissing } from "../engine/weather.js";
let fails = 0;
const ok = (c, m, x = "") => { console.log(`${c ? "✓" : "✗"} ${m}${x ? `  → ${x}` : ""}`); if (!c) fails++; };

// 월 계산: 말일에도 다음 달이 맞아야 해요
for (const [a, b] of [["202611", "202612"], ["202612", "202701"], ["202601", "202602"], ["202609", "202610"]]) ok(nextMonthYm(a) === b, `다음 달 ${a} → ${b}`, nextMonthYm(a));

// 파서: 날짜 끝 '일'·'월'을 요일로 읽지 않기
let r = parseWeekdayGroupedTimes("2026년 12월 5일 19시 2026년 12월 6일 17시");
ok(Object.keys(r).length === 0, "'12월 5일 19시'는 요일 묶음이 아님", JSON.stringify(r));
r = parseWeekdayGroupedTimes("1월 5일 19시");
ok(Object.keys(r).length === 0, "'1월 5일 19시'도 요일 묶음이 아님", JSON.stringify(r));
// 진짜 요일 표기는 그대로 읽기
r = parseWeekdayGroupedTimes("금 오후 7시 30분 / 토 오후 3시 / 일 오후 2시");
ok(r[5]?.[0] === "19:30" && r[6]?.join() === "15:00" && r[0]?.[0] === "14:00", "요일 표기(금·토·일)는 그대로", JSON.stringify(r));
r = parseWeekdayGroupedTimes("화~금 8시, 토일 오후 2시");
ok(r[6]?.[0] === "14:00" && r[0]?.[0] === "14:00", "'토일' 묶음은 그대로", JSON.stringify(r));

// 날씨: 단기예보 실패 땐 6시간 밖 값도 직전 값을 이어 받기
const now = new Date("2026-11-28T20:50:00+09:00");
const mk = (d, h, v) => ({ fcstDate: d, fcstTime: `${h}00`, category: "TMP", value: String(v) });
const prev = [mk("20261128", "21", 5), mk("20261129", "12", 3), mk("20261130", "18", 2)];
let out = carryOverMissing([], prev, now);
ok(out.length === 1, "기본(6시간): 21시 값만 이어 받음", `${out.length}건`);
out = carryOverMissing([], prev, now, { hours: 96 });
ok(out.length === 3, "단기예보 실패(96시간): 3건 모두 이어 받음", `${out.length}건`);
ok(out.every((x) => x.유지 === "직전갱신"), "이어 받은 값에 '직전갱신' 표시");
out = carryOverMissing([mk("20261129", "12", 9)], prev, now, { hours: 96 });
ok(out.find((x) => x.fcstDate === "20261129").value === "9", "새 값이 있으면 새 값이 이김");
console.log(fails ? `\n실패 ${fails}건` : "\n전부 통과");
if (fails) process.exitCode = 1;
