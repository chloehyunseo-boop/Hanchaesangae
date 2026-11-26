// validation/weather_validation.mjs — engine/weather.js 손계산 대조
// mergeForecasts의 "6시간째 정각" 자릿수 비교 버그(11/26 발견) 재현·고정.
import { mergeForecasts } from "../engine/weather.js";

let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`OK   ${name}`);
  } else {
    fail++;
    console.log(`실패 1  ${name}  ${detail ?? ""}`);
  }
}

function item({ fcstDate, fcstTime, category, value, source }) {
  return { baseDate: fcstDate, baseTime: "0000", fcstDate, fcstTime, category, value: String(value), source };
}

// now = 2026-11-26 15:44 KST, 6시간 뒤 = 21:44 → cutoff 시(정각)는 21시.
const now = new Date("2026-11-26T15:44:00+09:00");

// 초단기예보가 정확히 cutoff와 같은 시각(21:00)에도 값을 준 경우.
const vilageItems = [
  item({ fcstDate: "20261126", fcstTime: "2100", category: "WSD", value: "9.9", source: "vilage" }),
];
const ultraItems = [
  item({ fcstDate: "20261126", fcstTime: "2100", category: "WSD", value: "1.1", source: "ultra" }),
  item({ fcstDate: "20261126", fcstTime: "2200", category: "WSD", value: "2.2", source: "ultra" }), // 6시간 지남 → 안 써야 함
];

const merged = mergeForecasts(ultraItems, vilageItems, now);
const at2100 = merged.find((it) => it.fcstTime === "2100" && it.category === "WSD");
const at2200 = merged.find((it) => it.fcstTime === "2200" && it.category === "WSD");

check(
  "6시간째 정각(21:00)도 초단기예보로 덮어써짐 (버그 전: 단기예보 9.9가 남아있었음)",
  at2100?.value === "1.1" && at2100?.source === "ultra",
  `실제: ${JSON.stringify(at2100)}`
);
check(
  "cutoff보다 늦은 22:00은 초단기예보를 안 씀(단기예보 없으면 그냥 빠짐)",
  at2200 === undefined,
  `실제: ${JSON.stringify(at2200)}`
);

console.log(fail === 0 ? "\n전체 통과 (실패 0)" : `\n전체 통과 아님 (실패 ${fail})`);
process.exit(fail === 0 ? 0 : 1);
