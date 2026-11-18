// validation/plume_stage1_test.mjs — 배출가스 엔진 1차(태양 위치·대기 안정도) 구현 테스트
// 실행: node validation/plume_stage1_test.mjs
// 로드맵 8번 검증방침 ① 구현 테스트. 통과/실패가 아니라 기대값과의 차이를 그대로 출력해요.
import {
  solarElevationDeg, sunriseSunset, isTurnerNight, estimateStabilityClass, stabilityFromForecast, skyCodeToName,
} from "../engine/plume.js";

const kst = (s) => new Date(s + "+09:00");
const hm = (d) => new Date(d.getTime() + 9 * 3600000).toISOString().slice(11, 16);
let fails = 0;
const check = (name, ok, detail) => { if (!ok) fails++; console.log(`${ok ? "✅" : "❌"} ${name}  ${detail}`); };

// 1) 일출·일몰: 한국천문연구원 2026 천문달력(서울 시청 기준)과 비교. 허용 ±2분
//    출처: https://www.kasi.re.kr/file/1764661238731_1.pdf
const CITY_HALL = [37.5665, 126.978];
const kasi = [
  ["2026-03-20", "06:36", "18:44"],
  ["2026-06-21", "05:11", "19:57"],
  ["2026-11-17", "07:13", "17:20"],
  ["2026-12-22", "07:43", "17:18"],
];
const toMin = (s) => +s.slice(0, 2) * 60 + +s.slice(3);
for (const [d, rise, set] of kasi) {
  const r = sunriseSunset(...CITY_HALL, kst(`${d}T12:00:00`));
  const dr = toMin(hm(r.sunrise)) - toMin(rise), ds = toMin(hm(r.sunset)) - toMin(set);
  check(`일출·일몰 ${d}`, Math.abs(dr) <= 2 && Math.abs(ds) <= 2, `계산 ${hm(r.sunrise)}/${hm(r.sunset)} · 천문연 ${rise}/${set} (차이 ${dr}분/${ds}분)`);
}

// 2) 남중 고도: 90 − 위도 + 적위. 하지(적위 +23.44°)·동지(−23.44°) 기대값과 ±0.3°
const DOME = [37.519163, 127.127359];
for (const [d, decl] of [["2026-06-21", 23.44], ["2026-12-22", -23.44]]) {
  const { solarNoon } = sunriseSunset(...DOME, kst(`${d}T12:00:00`));
  const elev = solarElevationDeg(...DOME, solarNoon);
  const expect = 90 - DOME[0] + decl;
  check(`남중 고도 ${d}`, Math.abs(elev - expect) <= 0.3, `계산 ${elev.toFixed(2)}° · 기대 ${expect.toFixed(2)}°`);
}

// 3) 표 6-4 대조: 원문 표의 몇 칸을 그대로 확인
const t64 = [
  [4, 0.5, "A"], [-2, 0.5, "F"], [-1, 0.5, "F"], [0, 1.0, "D"], [2, 2.0, "C"],
  [4, 3.0, "B"], [-1, 3.5, "D"], [-2, 4.0, "E"], [3, 6.5, "D"], [4, 6.5, "C"], [1, 2.8, "D"], [1, 2.9, "D"],
];
for (const [nri, ws, exp] of t64) {
  const got = estimateStabilityClass({ netRadiationIndex: nri, wsd10m: ws });
  check(`표 6-4 지수 ${nri}, 풍속 ${ws}`, got === exp, `계산 ${got} · 원문 ${exp}`);
}

// 4) 상식 시나리오 (KSPO DOME)
const cases = [
  ["맑은 여름 한낮, 약풍", "2026-07-15T13:00:00", 1, 1.5, "기본", ["A"]],
  ["맑은 겨울 한낮, 약풍", "2026-12-15T13:00:00", 1, 1.5, "기본", ["B"]],
  ["맑은 밤, 약풍", "2026-07-15T23:00:00", 1, 1.5, "기본", ["F"]],
  ["흐린 밤, 약풍", "2026-07-15T23:00:00", 4, 1.5, "기본", ["F"]],
  ["흐린 밤, 약풍 (비교: 지수 0)", "2026-07-15T23:00:00", 4, 1.5, "비교", ["D"]],
  ["흐린 낮, 강풍", "2026-07-15T13:00:00", 4, 7.0, "기본", ["D"]],
  ["공연 시간대 맑은 저녁 19시 (11월, 일몰 후)", "2026-11-21T19:00:00", 1, 2.0, "기본", ["F"]],
  ["공연 시간대 구름많은 저녁 19시 (11월)", "2026-11-21T19:00:00", 3, 3.0, "기본", ["E"]],
];
for (const [name, t, code, ws, sc, exp] of cases) {
  const r = stabilityFromForecast({ sky: skyCodeToName(code), wsd10m: ws, lat: DOME[0], lon: DOME[1], dateUtc: kst(t), scenario: sc });
  check(name, exp.includes(r.stability), `→ ${r.stability} (태양 고도 ${r.solarElevation.toFixed(1)}°, ${r.isNight ? "밤" : "낮"}, 순복사 ${r.netRadiationIndex}) 기대 ${exp.join("/")}`);
}

// 5) '밤' 경계: 일몰 1시간 전부터 밤
const ss = sunriseSunset(...DOME, kst("2026-11-17T12:00:00")).sunset;
check("일몰 61분 전은 낮", !isTurnerNight(...DOME, new Date(ss.getTime() - 61 * 60000)), `일몰 ${hm(ss)}`);
check("일몰 59분 전은 밤", isTurnerNight(...DOME, new Date(ss.getTime() - 59 * 60000)), "");

console.log(fails ? `\n기대와 다른 항목 ${fails}개 — 위 ❌ 확인` : "\n모든 항목이 기대값과 같아요");
