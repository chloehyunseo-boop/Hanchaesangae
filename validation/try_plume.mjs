// validation/try_plume.mjs — 배출가스 엔진을 직접 돌려 보는 스크립트
// 사용법: node validation/try_plume.mjs <엔진출력kW> <하늘상태> <10m풍속> <거리m> "<날짜 시각>"
// 예:     node validation/try_plume.mjs 500 맑음 2 300 "2026-11-21 19:00"
// 하늘상태: 맑음 / 구름많음 / 흐림.  위치는 KSPO DOME, 바람은 서풍, 수음점은 바람 방향 정면이에요.
import { stabilityFromForecast, calcExhaustGaussianPlume, classifyExhaustLevel } from "../engine/plume.js";

const [kw, sky, ws, dist, when] = process.argv.slice(2);
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

for (const scenario of ["기본", "비교"]) {
  const s = stabilityFromForecast({ sky, wsd10m: Number(ws), lat: DOME.lat, lon: DOME.lon, dateUtc: t, scenario });
  const r = calcExhaustGaussianPlume({ sourceLat: DOME.lat, sourceLon: DOME.lon, receiverLat: rec.lat, receiverLon: rec.lon,
    enginePowerKW: Number(kw), stability: s.stability, wsd10m: Number(ws), windVecFromDeg: 270 });
  if (r.value === null) { console.log(`[${scenario}] 계산 불가: ${r.reason}`); continue; }
  console.log(`[${scenario}] ${s.isNight ? "밤" : "낮"}, 태양 고도 ${s.solarElevation.toFixed(1)}°, 안정도 ${s.stability}` +
    ` → NO2 ${r.value.toFixed(4)} ppm (기준의 ${((r.value / 0.1) * 100).toFixed(0)}%) → ${classifyExhaustLevel(r.value) ?? "미표시"}` +
    (r.flags.length ? `  [${r.flags.join(", ")}]` : ""));
}
