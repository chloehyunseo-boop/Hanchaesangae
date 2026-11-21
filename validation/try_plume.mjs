// validation/try_plume.mjs — 배출가스 엔진을 직접 돌려 보는 스크립트
// 사용법: node validation/try_plume.mjs <엔진출력kW> <하늘상태> <10m풍속> <거리m> "<날짜 시각>" [기온℃]
// 예:     node validation/try_plume.mjs 500 맑음 2 300 "2026-11-21 19:00" 10
// 하늘상태: 맑음 / 구름많음 / 흐림.  위치는 KSPO DOME(건물 옆 → 연기 상승 제외), 발전차 1대, 바람은 서풍, 수음점은 풍하 정면.
// 가정 4가지(기본추정·기존입력가정·연기상승제외·전량NO2)를 한 번에 보여 줘요. 기온을 주면 '개방된 곳'(연기 상승 적용)도 보여 줘요.
import { stabilityFromForecast, calcExhaustAtReceiver, classifyExhaustLevel } from "../engine/plume.js";

const [kw, sky, ws, dist, when, tempArg] = process.argv.slice(2);
const tempC = tempArg === undefined ? undefined : Number(tempArg);
if (!when || !["맑음", "구름많음", "흐림"].includes(sky)) {
  console.log('사용법: node validation/try_plume.mjs 500 맑음 2 300 "2026-11-21 19:00"');
  process.exit(1);
}
const DOME = { lat: 37.519163, lon: 127.127359 };
if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(when) || [kw, ws, dist].some((v) => !Number.isFinite(Number(v)))) {
  console.log(`입력 형식이 달라요. 받은 값: 출력=${kw}, 풍속=${ws}, 거리=${dist}, 시각=${JSON.stringify(when)}`);
  console.log('시각은 "2026-11-21 12:00"처럼 따옴표 안에 써 주세요.');
  process.exit(1);
}
const t = new Date(when.replace(" ", "T") + ":00+09:00");
const R = 6371000, d = Number(dist) / R, la = (DOME.lat * Math.PI) / 180;
const rec = { lat: DOME.lat, lon: DOME.lon + ((Math.atan2(Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) ** 2)) * 180) / Math.PI };

const s = stabilityFromForecast({ sky, wsd10m: Number(ws), lat: DOME.lat, lon: DOME.lon, dateUtc: t });
console.log(`${s.isNight ? "밤" : "낮"}, 태양 고도 ${s.solarElevation.toFixed(1)}°, 안정도 ${s.stability}`);
const runs = [["기본추정", {}], ["기존입력가정", {}], ["연기상승제외", {}], ["전량NO2", {}]];
if (tempC !== undefined) runs.push(["기본추정(개방된 곳으로 볼 때)", { 건물옆: false }]);
for (const [name, extra] of runs) {
  const 가정 = name.startsWith("기본추정") ? "기본추정" : name;
  const r = calcExhaustAtReceiver({ generators: [{ lat: DOME.lat, lon: DOME.lon, 엔진출력_kW: Number(kw), 출력종류: "엔진", ...extra }],
    receiverLat: rec.lat, receiverLon: rec.lon, stability: s.stability, wsd10m: Number(ws), windVecFromDeg: 270, fanHalfWidthDeg: 0, 가정, 대기온도_C: tempC });
  if (r.value === null) { console.log(`[${name}] 계산 불가: ${r.reason ?? r.flags.join(", ")}`); continue; }
  console.log(`[${name}] NO2 ${r.value.toFixed(4)} ppm (기준의 ${((r.value / 0.1) * 100).toFixed(0)}%) → ${classifyExhaustLevel(r.value) ?? "미표시"}` +
    (r.no2NoxRatio ? `, NO2/NOx ${r.no2NoxRatio.toFixed(2)}` : "") + (r.flags.length ? `  [${r.flags.join(", ")}]` : ""));
}
