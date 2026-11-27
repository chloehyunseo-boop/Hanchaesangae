// 발전차 대수 민감도 (하린 라인, 11/27): KSPO DOME 5대 고정, 올림픽홀·우리금융아트홀을 1/3/5대로(실제 11/28 일정). 11/28 19~22시 공연, 바람 8방향×(1.5m/s F, 3m/s D) 중 장소별 최댓값.
import { readFileSync } from "node:fs";
const R = new URL("../", import.meta.url).pathname;
const { placeCellsForHour, DEFAULT_PLACE_NAMES } = await import(R+"engine/forecast_text.js");
const site = JSON.parse(readFileSync(R+"data/site.geojson"));
const concaweData = JSON.parse(readFileSync(R+"data/concawe_4_81.json"));
const assumptions = JSON.parse(readFileSync(R+"data/assumptions.json"));
const { generatorPosition } = await import(R+"engine/event_generators.js");
const by = new Map(site.features.map(f=>[f.properties.name,f]));
const pt = n => { const [lon,lat]=by.get(n).geometry.coordinates; return {lat,lon}; };
const places = DEFAULT_PLACE_NAMES.map(name=>({name,...pt(name)}));
const hour = "2026-11-28T19:00:00+09:00";
const time = { start: "2026-11-28T19:00:00+09:00", end: "2026-11-28T22:00:00+09:00", 출처: "민감도" };
const others = ["올림픽홀","우리금융아트홀"]; // 11/27: 실제 11/28 일정(KSPO DOME·올림픽홀·우리금융아트홀)만. 핸드볼은 그날 공연 없음
const gp = s => { const g = generatorPosition(s, by.get(s), assumptions); return { lat: g.lat, lon: g.lon }; }; // 11/27 공단 회신 위치 반영
const gens = n => [...Array(5)].map(()=>({...gp("KSPO DOME"),time})).concat(others.flatMap(s=>[...Array(n)].map(()=>({...gp(s),time}))));
const res = {};
for (const ws of [1.5, 3]) for (const dir of [0,45,90,135,180,225,270,315]) {
  const weather = { tempC: 5, tmp: 5, rhPercent: 60, windVecFromDeg: dir, wsd10m: ws, stability: ws<2?"F":"D" };
  for (const n of [1,3,5]) {
    const c = placeCellsForHour({ places, stageSources: [], generatorSources: gens(n), weather, hour, concaweData, 배출시나리오: "인증" });
    for (const p of places) { const e=c[p.name].exhaust; const v=e?.value ?? 0; const k=`${p.name}|${n}`; if(!res[k]||v>res[k].v) res[k]={v,l:e?.level??'기준미만',f:(e?.flags??[]).join(',')}; }
  }
}
const lvl = r => r>=0.5?"강":r>=0.1?"중":r>=0.02?"약":"기준미만";
console.log("장소 | 1대 | 3대 | 5대  (16개 바람 조건 중 최댓값, NO2 ppm·단계)");
for (const p of places) console.log(p.name, [1,3,5].map(n=>{const r=res[`${p.name}|${n}`];return `${r.v.toPrecision(2)}ppm ${r.l}`}).join(" | "));
