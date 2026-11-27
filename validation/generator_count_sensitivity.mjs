// 발전차 대수 민감도 (하린 라인, 11/27 다시 설계)
// 확인하려는 것: "공단 확인값이 없는 공연장의 발전차를 1대로 잡은 가정이 결과를 얼마나 바꾸나".
// 방법: 공연장마다 따로, 그 공연장 공연이 실제로 있는 날(data/events.json)의 실제 시작 시각으로
//   1/3/5대를 바꿔 봐요(가동 = 시작 2시간 전 ~ 종료, 엔진 규칙 그대로). 날씨는 두 가지:
//   (가) 그날 실제 기상청 단기예보(data/weather.json), (나) 바람 16조건(8방향 × 1.5m/s F, 3m/s D) 중 최댓값.
//   마지막으로 실제로 공연이 겹친 날(KSPO DOME 5대 + 나머지)도 같이 봐요.
// 실행: node validation/generator_count_sensitivity.mjs [날짜, 기본 2026-11-28]
import { readFileSync } from "node:fs";
globalThis.L = { Layer: { extend: (o) => o } }; // app/shared.js가 불러오는 순간 Leaflet을 써서 최소한만 흉내
const R = new URL("../", import.meta.url).pathname;
const { placeCellsForHour, DEFAULT_PLACE_NAMES } = await import(R + "engine/forecast_text.js");
const { buildRealEventGeneratorSources } = await import(R + "engine/event_generators.js");
const { buildWeatherByHour, toEngineWeather } = await import(R + "app/shared.js");
const J = (p) => JSON.parse(readFileSync(R + p));
const site = J("data/site.geojson"), concaweData = J("data/concawe_4_81.json"), events = J("data/events.json"), assumptions = J("data/assumptions.json");
const weatherByHour = buildWeatherByHour(J("data/weather.json").예보 ?? []);
const siteByName = new Map(site.features.map((f) => [f.properties.name, f]));
const places = DEFAULT_PLACE_NAMES.map((name) => { const [lon, lat] = siteByName.get(name).geometry.coordinates; return { name, lat, lon }; });
const DAY = process.argv[2] ?? "2026-11-28";
const hours = Array.from({ length: 24 }, (_, h) => `${DAY}T${String(h).padStart(2, "0")}:00:00+09:00`);
const RANK = { 기준미만: 0, 약: 1, 중: 2, 강: 3 };
const withCount = (n) => ({ ...assumptions, 발전차_기본대수: { ...assumptions.발전차_기본대수, 확인안된_공연장: n } });
const evOnly = (sites) => ({ 공연: events.공연.filter((e) => e.출처 === "공단일정페이지" && sites.includes(e.site)) });
const winds = [0, 45, 90, 135, 180, 225, 270, 315].flatMap((d) => [[d, 1.5, "F"], [d, 3, "D"]]);

function worst(sites, n, mode) {
  const best = Object.fromEntries(places.map((p) => [p.name, { v: 0, l: "기준미만", h: null }]));
  for (const hour of hours) {
    const gens = buildRealEventGeneratorSources(evOnly(sites), siteByName, withCount(n), hour);
    if (gens.length === 0) continue;
    let ws;
    if (mode === "예보") {
      const k = hour.slice(0, 10).replaceAll("-", "") + hour.slice(11, 13);
      const w = toEngineWeather(weatherByHour.get(k), hour);
      if (!w) continue;
      ws = [w];
    } else ws = winds.map(([d, s, st]) => ({ tempC: 5, tmp: 5, rhPercent: 60, windVecFromDeg: d, wsd10m: s, stability: st }));
    for (const weather of ws) {
      const c = placeCellsForHour({ places, stageSources: [], generatorSources: gens, weather, hour, concaweData, 배출시나리오: "인증" });
      for (const p of places) {
        const e = c[p.name].exhaust; const v = e?.value ?? 0;
        if (v > best[p.name].v) best[p.name] = { v, l: e?.level ?? "기준미만", h: hour.slice(11, 13) };
      }
    }
  }
  return best;
}
const fmt = (r) => `${r.v < 0.01 ? r.v.toFixed(4) : r.v.toFixed(3)} ${r.l}`;
function table(title, sites, mode, counts = [1, 3, 5]) {
  const res = counts.map((n) => worst(sites, n, mode));
  const lines = [`\n## ${title}`, `장소 | ${counts.map((n) => `${n}대`).join(" | ")} | 단계 바뀜`];
  for (const p of places) {
    const row = res.map((r) => r[p.name]);
    const changed = new Set(row.map((x) => x.l)).size > 1 ? "◀" : "";
    lines.push(`${p.name} | ${row.map(fmt).join(" | ")} | ${changed}`);
  }
  console.log(lines.join("\n"));
}

const day = evOnly(["올림픽홀", "우리금융아트홀", "티켓링크 라이브 아레나(SK올림픽핸드볼경기장)", "KSPO DOME"]).공연
  .filter((e) => DAY >= e.기간시작 && DAY <= e.기간끝);
console.log(`# 발전차 대수 민감도 — ${DAY} (NO2 ppm, 하루 중 장소별 최댓값)`);
console.log(`그날 실제 공연: ${day.map((e) => `${e.site} ${e.일자별시작?.[DAY] ?? "시간모름"}${e.일자별최종공연시작?.[DAY] ? `·${e.일자별최종공연시작[DAY]}` : ""}`).join(", ") || "없음"}`);
for (const v of ["올림픽홀", "우리금융아트홀", "티켓링크 라이브 아레나(SK올림픽핸드볼경기장)"]) {
  if (!day.some((e) => e.site === v)) { console.log(`\n## ${v}: 이날 공연 없음 — 계산 안 함`); continue; }
  table(`${v}만 (실제 예보)`, [v], "예보");
  table(`${v}만 (바람 16조건 최댓값)`, [v], "16조건");
}
const others = day.map((e) => e.site).filter((s) => s !== "KSPO DOME");
if (day.some((e) => e.site === "KSPO DOME") && others.length) {
  table(`실제로 겹친 날: KSPO DOME 5대 + ${others.join("·")} 각 n대 (실제 예보)`, ["KSPO DOME", ...others], "예보");
}
