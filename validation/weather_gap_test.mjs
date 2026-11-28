// 기상값 누락(지금 시각이 '계산 불가'가 되던 문제) 수정 검증 (하린 11/28). 실행: TZ=Asia/Seoul node validation/weather_gap_test.mjs
// 지난 갱신 파일들(git 기록)을 그대로 다시 돌려서, 고치기 전/후에 지금~2시간 뒤 칸이 계산 가능한지 비교해요.
import { execSync } from "node:child_process";
import { carryOverMissing } from "../engine/weather.js";
globalThis.L = { Layer: { extend: (o) => o } };
const { buildWeatherByHour, toEngineWeather, weatherKey, hourSlotIso } = await import("../app/shared.js");

let fails = 0;
const ok = (c, m, extra = "") => { console.log(`${c ? "✓" : "✗"} ${m}${extra ? `  → ${extra}` : ""}`); if (!c) fails++; };

// 1) 단위: 새 값이 있으면 새 값, 없을 때만 직전 값, 6시간 밖은 안 채움
{
  const now = new Date("2026-11-28T08:37:00+09:00");
  const it = (t, c, v, src = "vilage") => ({ fcstDate: "20261128", fcstTime: t, category: c, value: v, source: src });
  const out = carryOverMissing([it("0900", "TMP", "7")], [it("0800", "TMP", "5"), it("0900", "TMP", "6"), it("0700", "TMP", "4"), it("1500", "TMP", "9")], now);
  const get = (t) => out.find((x) => x.fcstTime === t && x.category === "TMP");
  ok(get("0800")?.value === "5" && get("0800")?.유지 === "직전갱신", "지금 시각(08시) 빠진 값은 직전 값으로 채움 + '직전갱신' 표시");
  ok(get("0900")?.value === "7" && !get("0900").유지, "새 값이 있으면 새 값이 이김");
  ok(!get("0700"), "지난 시각(07시)은 안 채움");
  ok(!get("1500"), "6시간 넘는 시각(15시)은 안 채움");
}
// 2) T1H 대체
{
  const base = { REH: "60", VEC: "270", WSD: "3", SKY: "1" };
  const iso = "2026-11-28T08:00:00+09:00";
  const a = toEngineWeather({ ...base, T1H: "5" }, iso);
  ok(a?.tempC === 5 && a.기온출처 === "초단기예보T1H", "TMP 없으면 T1H 기온 사용 + 출처 표시");
  const b = toEngineWeather({ ...base, TMP: "6", T1H: "5" }, iso);
  ok(b?.tempC === 6 && b.기온출처 === "단기예보TMP", "둘 다 있으면 TMP 우선");
  ok(toEngineWeather({ REH: "60", VEC: "270", WSD: "3", SKY: "1" }, iso) === null, "기온이 둘 다 없으면 여전히 계산 안 함(지어내지 않음)");
}
// 3) 실제 기록 재생
const log = execSync("git log --since=2026-11-26 --pretty=%H -- data/weather.json").toString().trim().split("\n");
const files = log.map((h) => { try { return JSON.parse(execSync(`git show ${h}:data/weather.json`).toString()); } catch { return null; } }).filter(Boolean);
let before = 0, after = 0, total = 0;
for (let i = 0; i < files.length - 1; i++) {
  const cur = files[i], prev = files[i + 1];
  const now = new Date(cur.저장시각);
  const fixed = carryOverMissing(cur.예보.filter((x) => !x.유지), prev.예보, now);
  const mapB = buildWeatherByHour(cur.예보), mapA = buildWeatherByHour(fixed);
  for (let k = 0; k < 3; k++) {
    const d = new Date(now); d.setMinutes(0, 0, 0); d.setHours(d.getHours() + k);
    total++;
    const rb = mapB.get(weatherKey(d));
    if (rb?.TMP !== undefined && toEngineWeather(rb, hourSlotIso(d))) before++; // 고치기 전 규칙: TMP 필수, 직전값 채움 없음
    if (toEngineWeather(mapA.get(weatherKey(d)), hourSlotIso(d))) after++;
  }
}
console.log(`· 실제 갱신 ${files.length - 1}회 × 지금~2시간 뒤: 고치기 전 ${before}/${total}칸 계산 가능 → 고친 뒤 ${after}/${total}칸`);
ok(after === total, "고친 뒤 지금~2시간 뒤 칸이 전부 계산 가능");
console.log(fails ? `\n실패 ${fails}건` : "\n전부 통과");
if (fails) process.exitCode = 1;
