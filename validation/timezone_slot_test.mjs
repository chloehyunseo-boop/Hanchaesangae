// 시간대 검사 (11/28 최종 점검): 브라우저 시간대가 어디든 '지금' 칸이 KST 정시여야 해요.
// 실행: for tz in Asia/Seoul Europe/Berlin Asia/Kolkata America/New_York Australia/Adelaide; do TZ=$tz node validation/timezone_slot_test.mjs; done
// shared.js는 Leaflet(L)을 최상단에서 쓰므로 가짜 L을 먼저 둬요(지도는 안 그려요).
globalThis.L = { Layer: { extend: () => function () {} }, DomUtil: {}, setOptions() {}, Util: {} };
const { hourSlotDate, hourSlotIso, formatSlotLabel } = await import("../app/shared.js");
let fails = 0;
const ok = (c, m, x = "") => { console.log(`${c ? "✓" : "✗"} ${m}${x ? `  → ${x}` : ""}`); if (!c) fails++; };
const realNow = Date.now;
const kst = (iso) => new Date(iso).getTime();
const cases = [
  ["KST 23:10 (자정 직전)", "2026-11-28T23:10:00+09:00", "2026-11-28T23:00:00+09:00"],
  ["KST 23:40", "2026-11-28T23:40:00+09:00", "2026-11-28T23:00:00+09:00"],
  ["KST 00:20 (자정 직후)", "2026-11-29T00:20:00+09:00", "2026-11-29T00:00:00+09:00"],
  ["KST 18:05", "2026-11-30T18:05:00+09:00", "2026-11-30T18:00:00+09:00"],
];
for (const [label, now, want] of cases) {
  Date.now = () => kst(now);
  const RealDate = Date;
  globalThis.Date = class extends RealDate { constructor(...a) { a.length ? super(...a) : super(kst(now)); } static now() { return kst(now); } };
  const got0 = hourSlotIso(hourSlotDate(0));
  const got71 = hourSlotIso(hourSlotDate(71));
  const want71 = new RealDate(kst(want) + 71 * 3600e3);
  globalThis.Date = RealDate;
  ok(got0 === want, `${label}: 0번 칸이 KST 정시`, `${got0} (기대 ${want})`);
  const dKst = (d) => d.toISOString();
  ok(RealDate.parse(got71) === want71.getTime(), `${label}: 71번 칸(마지막)이 정확히 71시간 뒤`, got71);
}
Date.now = realNow;
console.log(fails ? `\n실패 ${fails}건 (TZ=${process.env.TZ ?? "기본"})` : `\n전부 통과 (TZ=${process.env.TZ ?? "기본"})`);
if (fails) process.exitCode = 1;
