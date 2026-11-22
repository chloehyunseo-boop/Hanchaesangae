// 문장 예보 데모 (하린 라인, 11/22). 실행: node validation/forecast_text_demo.mjs
// ⚠️ 공연·발전차·음량은 전부 시연용 가정이에요(실제 공연 아님). 기상은 저장소의 실제 예보(data/weather.json).
import { readFileSync } from "node:fs";
import { placeCellsForHour, buildForecastSentences, DEFAULT_PLACE_NAMES } from "../engine/forecast_text.js";
import { stabilityFromForecast, skyCodeToName } from "../engine/plume.js";

const site = JSON.parse(readFileSync(new URL("../data/site.geojson", import.meta.url)));
const concaweData = JSON.parse(readFileSync(new URL("../data/concawe_4_81.json", import.meta.url)));
const wj = JSON.parse(readFileSync(new URL("../data/weather.json", import.meta.url)));
const byName = new Map(site.features.map((f) => [f.properties.name, f]));
const pt = (n) => { const [lon, lat] = byName.get(n).geometry.coordinates; return { lat, lon }; };
const places = DEFAULT_PLACE_NAMES.map((name) => ({ name, ...pt(name) }));

// 기상: 같은 시각에 초단기(ultra)가 있으면 그걸, 없으면 단기(vilage)
const recs = new Map();
for (const it of wj.예보) {
  const k = it.fcstDate + it.fcstTime.slice(0, 2);
  const r = recs.get(k) || {};
  if (r[it.category] === undefined || it.source === "ultra") r[it.category] = it.value;
  recs.set(k, r);
}
const toWeather = (k, iso) => {
  const r = recs.get(k);
  if (!r || [r.TMP ?? r.T1H, r.REH, r.VEC, r.WSD, r.SKY].some((v) => v === undefined)) return null;
  const tempC = Number(r.TMP ?? r.T1H), wsd10m = Number(r.WSD), windVecFromDeg = Number(r.VEC);
  const P = pt("KSPO DOME");
  const { stability } = stabilityFromForecast({ sky: skyCodeToName(r.SKY), wsd10m, lat: P.lat, lon: P.lon, dateUtc: new Date(iso) });
  return { tempC, tmp: tempC, rhPercent: Number(r.REH), windVecFromDeg, wsd10m, stability };
};

const DOME = pt("KSPO DOME"), STAGE = pt("88잔디마당 무대");
const EQ = -10 * Math.log10(7);
const spectrum = Object.fromEntries([63, 125, 250, 500, 1000, 2000, 4000].map((f) => [f, EQ]));

function run(date, label, weatherOverride) {
  const t = (h) => `${date}T${String(h).padStart(2, "0")}:00:00+09:00`;
  const show = { start: t(19), end: t(22), 출처: "시연용가정" };
  const generators = [0, 1, 2, 3, 4].map((i) => ({ lat: DOME.lat - 0.0006, lon: DOME.lon + (i - 2) * 0.00011, 엔진출력_kW: 500, 출력종류: "엔진", 정보출처: "시연용가정", time: show }));
  const stages = [{ ...STAGE, lwDb: 120, groundType: "soft", dSoftM: 300, hs: 1.5, spectrumRatiosDb: spectrum, time: { start: t(18), end: t(21), 출처: "시연용가정" } }];
  const series = [];
  for (let h = 16; h <= 23; h++) {
    const iso = t(h);
    const weather = weatherOverride ?? toWeather(date.replaceAll("-", "") + String(h).padStart(2, "0"), iso);
    if (!weather) continue;
    series.push({ hour: iso, weather, cellsByPlace: placeCellsForHour({ places, stageSources: stages, generatorSources: generators, weather, hour: iso, concaweData }) });
  }
  console.log(`\n## ${label}`);
  for (const s of series) console.log(`   (${s.hour.slice(11, 13)}시 바람 ${s.weather.windVecFromDeg}° ${s.weather.wsd10m}m/s, 안정도 ${s.weather.stability})`);
  buildForecastSentences({ series, now: `${date}T15:00:00+09:00` }).forEach((l, i) => console.log(`${i + 1}. ${l}`));
}

run("2026-11-23", "11/23 실제 예보 기상 + 가상 공연(DOME 19~22시 발전차 5대, 88잔디마당 18~21시)");
run("2026-11-23", "같은 공연 + 바람 고정: 북서풍 3m/s, 안정도 D", { tempC: 5, tmp: 5, rhPercent: 60, windVecFromDeg: 315, wsd10m: 3, stability: "D" });
run("2026-11-23", "같은 공연 + 바람 고정: 북풍 0.8m/s(약풍), 안정도 F", { tempC: 3, tmp: 3, rhPercent: 70, windVecFromDeg: 0, wsd10m: 0.8, stability: "F" });
