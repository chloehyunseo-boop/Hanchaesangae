// 문장 예보 단위 테스트 (하린 라인, 11/22). 실행: node validation/forecast_text_test.mjs
import { buildForecastSentences, windName, cellState } from "../engine/forecast_text.js";

let fails = 0;
const ok = (c, m, extra = "") => { console.log(`${c ? "✓" : "✗"} ${m}${extra ? `  → ${extra}` : ""}`); if (!c) fails++; };
const H = (d, h) => `2026-11-${d}T${String(h).padStart(2, "0")}:00:00+09:00`;
const ex = (level, flags = [], extra = {}) => ({ layer: "exhaust", value: level ? 0.06 : 0, level, flags, ...extra });
const no = (level, flags = []) => ({ layer: "noise", value: level ? 60 : 30, level, flags });
const NOW = H(23, 15);

// 풍향 이름
ok(windName(315) === "북서풍" && windName(0) === "북풍" && windName(360) === "북풍" && windName(202.5) === "남남서풍", "VEC → 16방위");
ok(windName(NaN) === null && windName(undefined) === null, "풍향 없음 → null");

// 1) 같은 단계가 이어지는 시간을 묶고, 내일 표기
{
  const series = [19, 20, 21].map((h) => ({ hour: H(24, h), weather: { windVecFromDeg: 315 }, cellsByPlace: { 올림픽수영장: { exhaust: ex("강"), noise: null } } }));
  const out = buildForecastSentences({ series, now: NOW });
  ok(out.length === 1 && out[0] === "내일 19~22시 북서풍으로 발전차 배출가스가 수영장 쪽으로 퍼질 가능성이 커요('강').", "연속 3시간 묶기 + 내일", out[0]);
}
// 2) 같은 시간·단계의 장소를 합치기
{
  const series = [{ hour: H(23, 20), weather: { windVecFromDeg: 270 }, cellsByPlace: { 올림픽수영장: { exhaust: ex("중") }, "올림픽공원 테니스경기장": { exhaust: ex("중") } } }];
  const out = buildForecastSentences({ series, now: NOW });
  ok(out[0] === "20~21시 서풍으로 발전차 배출가스가 수영장·테니스장 쪽으로 퍼질 수 있어요('중').", "장소 합치기", out[0]);
}
// 3) 아무것도 없음
{
  const series = [17, 18].map((h) => ({ hour: H(23, h), weather: { windVecFromDeg: 90 }, cellsByPlace: { 장미광장: { exhaust: ex(null), noise: no(null) } } }));
  const out = buildForecastSentences({ series, now: NOW });
  ok(out.length === 1 && out[0].includes("'약' 이상으로 예보된 소음·배출가스가 없어요"), "예보 없음 문장", out[0]);
}
// 4) 강이 먼저, 6줄 이상이면 5줄째가 '그 밖에'
{
  const names = ["올림픽수영장", "올림픽공원 테니스경기장", "장미광장", "평화의광장", "올림픽선수기자촌", "풍납극동아파트", "잠실파크리오아파트"];
  const lv = ["약", "약", "중", "약", "강", "약", "중"];
  const series = [{ hour: H(23, 20), weather: { windVecFromDeg: 0 }, cellsByPlace: {} }, { hour: H(23, 21), weather: { windVecFromDeg: 0 }, cellsByPlace: {} }];
  // 시간마다 다른 단계로 만들어 합쳐지지 않게
  names.forEach((n, i) => { series[0].cellsByPlace[n] = { exhaust: ex(lv[i]) }; series[1].cellsByPlace[n] = { noise: no(lv[(i + 1) % 7]) }; });
  const out = buildForecastSentences({ series, now: NOW });
  ok(out.length === 5 && out[0].includes("'강'") && out[4].startsWith("그 밖에"), "최대 5줄, 강 먼저, 넘치면 '그 밖에'", out.join(" / "));
}
// 5) 근거리: 하한등급 있으면 '이상', 없으면 보류
ok(cellState(ex(null, ["근거리불확실"], { value: 0.2, 하한등급: "강" })).atLeast === true, "근거리+하한등급 → '강 이상'");
ok(cellState(ex(null, ["근거리불확실"], { value: 0.2, 하한등급: null })).reason === "근거리", "근거리+하한 없음 → 보류");
// 6) 모름: 약풍·시간미확인
ok(cellState({ layer: "exhaust", value: null, level: null, flags: ["약풍미표시"] }).reason === "약풍", "약풍 → 모름(약풍)");
ok(cellState({ layer: "exhaust", value: null, level: null, flags: ["발전차시간미확인"] }).reason === "시간미확인", "시간 모름 → 모름(시간미확인)");
// 7) 해결책 문구가 없음(CLAUDE.md 규칙 4)
{
  const series = [{ hour: H(23, 20), weather: { windVecFromDeg: 0 }, cellsByPlace: { 올림픽수영장: { exhaust: ex("강"), noise: no("강") } } }];
  const all = buildForecastSentences({ series, now: NOW }).join(" ");
  ok(!/(하세요|닫으|피하|옮기|권장|주의하)/.test(all), "권고·해결책 문구 없음", all);
}
// 8) 자정 넘김
{
  const series = [23, 24].map((h, i) => ({ hour: i === 0 ? H(23, 23) : H(24, 0), weather: { windVecFromDeg: 0 }, cellsByPlace: { 장미광장: { noise: no("중") } } }));
  const out = buildForecastSentences({ series, now: NOW });
  ok(out[0].startsWith("23시~다음 날 1시"), "자정 넘기는 시간대 표기", out[0]);
}

console.log(fails ? `\n실패 ${fails}건` : "\n전부 통과");
if (fails) process.exitCode = 1;
