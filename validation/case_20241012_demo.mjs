// 사례 재현 실험: 2024-10-12(토) 17~20시, 실제 기상관측(ASOS 서울) + 실제 공연 시각.
// 실행: node validation/case_20241012_demo.mjs
//
// 로드맵 §8 검증방침 "③ 사례(2024-10-12 재현)"를 실제 공개 자료로 처음 돌려 본 실험용
// 스크립트예요. 공연 3개가 겹친 날(노컷뉴스 보도: 관객들이 "2막 중반부터" 외부 댄스음악을
// 들었다고 함)의 실제 공연 시각은 docs/사례_20241012_공연시각.md, 실제 기상은
// validation/asos_seoul_20241011-13.csv(기상청 ASOS 서울 지점 108, 2026-11-21 받음).
//
// ⚠️ 여전히 가정인 것들(CLAUDE.md 2번대로 명시):
//  - 음원 세기(LW)는 공단 측정 기준이 아직 없어서 가정값(100dB, "큰공연" 가중)이에요 — 실제
//    공연 음량이 아니에요. 스펙트럼도 7밴드 균등분배 가정이에요.
//  - BoA 공연 종료 시각은 공개 근거를 못 찾아 하린 기억(약 2시간20분)으로 18:00~20:20 가정.
//    88잔디마당은 공식 타임테이블(변동 가능 표기 있음)의 Lucky Daye 18:00~19:20만 이 시간대
//    분량으로 썼어요(그 전후 공연은 재현 창(17~20시) 밖이라 뺐어요).
//  - ASOS는 기상청 단기예보 SKY(맑음/구름많음/흐림) 대신 전운량(10분위, 0~10)을 줘요. 맑음
//    0~5·구름많음 6~8·흐림 9~10으로 뭉뚱그렸어요 — 기상청 공식 환산표가 아니라 이 스크립트만의
//    근사예요(엔진 코드가 아니라 이 데모 파일에만 있는 가정이라 engine/는 안 건드렸어요).
//  - 발전차(배출가스)는 이 사례가 소음 간섭 제보라 넣지 않았어요(발전차 민원은 2024-05
//    체조경기장 건으로 다른 사례예요, docs/민원_정리.md).

import { readFileSync } from "node:fs";
import { placeCellsForHour, buildForecastSentences, DEFAULT_PLACE_NAMES } from "../engine/forecast_text.js";
import { placeCellState } from "../engine/place_view.js";
import { stabilityFromForecast, skyCodeToName } from "../engine/plume.js";

const site = JSON.parse(readFileSync(new URL("../data/site.geojson", import.meta.url)));
const concaweData = JSON.parse(readFileSync(new URL("../data/concawe_4_81.json", import.meta.url)));
const byName = new Map(site.features.map((f) => [f.properties.name, f]));
const pt = (n) => { const [lon, lat] = byName.get(n).geometry.coordinates; return { lat, lon }; };

// --- ASOS 서울(108) 시간별 관측을 날짜·시각으로 바로 찾을 수 있게 파싱해요. ---
const asosText = readFileSync(new URL("./asos_seoul_20241011-13.csv", import.meta.url), "utf8");
const [header, ...asosRows] = asosText.trim().split("\n").map((l) => l.split(","));
const col = Object.fromEntries(header.map((h, i) => [h, i]));
const asosByIso = new Map();
for (const row of asosRows) {
  const [date, time] = row[col["일시"]].split(" ");
  const hh = time.slice(0, 2);
  asosByIso.set(`${date}T${hh}`, {
    tempC: Number(row[col["기온(°C)"]]),
    wsd10m: Number(row[col["풍속(m/s)"]]),
    windVecFromDeg: Number(row[col["풍향(16방위)"]]), // 실제로는 도(°) 단위 값이에요(컬럼 이름이 ASOS 원본 그대로)
    rhPercent: Number(row[col["습도(%)"]]),
    cloud10: Number(row[col["전운량(10분위)"]] || 0),
  });
}
function cloudToSky(cloud10) {
  if (cloud10 <= 5) return "맑음";
  if (cloud10 <= 8) return "구름많음";
  return "흐림";
}
function asosWeather(dateIso, hh) {
  const rec = asosByIso.get(`${dateIso}T${String(hh).padStart(2, "0")}`);
  if (!rec) return null;
  const P = pt("KSPO DOME");
  const hourIso = `${dateIso}T${String(hh).padStart(2, "0")}:00:00+09:00`;
  const { stability } = stabilityFromForecast({
    sky: cloudToSky(rec.cloud10), wsd10m: rec.wsd10m, lat: P.lat, lon: P.lon, dateUtc: new Date(hourIso),
  });
  return { tempC: rec.tempC, tmp: rec.tempC, rhPercent: rec.rhPercent, windVecFromDeg: rec.windVecFromDeg, wsd10m: rec.wsd10m, stability };
}

// --- 실제 공연 시각(docs/사례_20241012_공연시각.md) ---
const t = (h, m = 0) => `2024-10-12T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+09:00`;
const EQ_SPLIT_DB = -10 * Math.log10(7);
const SPECTRUM = Object.fromEntries([63, 125, 250, 500, 1000, 2000, 4000].map((f) => [f, EQ_SPLIT_DB]));
const DEMO_LW_DB = 100; // ⚠️ 가정값 — 실제 공연 음량 아님(LW 공단 답 대기, decisions.md 11/21)
const GROUND = { groundType: "soft", dSoftM: 300, hs: 1.5 };

function stage(siteName, start, end) {
  return { ...pt(siteName), lwDb: DEMO_LW_DB, ...GROUND, spectrumRatiosDb: SPECTRUM, time: { start, end, 출처: "실제공연시각(docs/사례_20241012_공연시각.md)" } };
}
const stageSources = [
  stage("KSPO DOME", t(17, 0), t(19, 0)), // 투란도트: 17:00 시작, 120분(인터미션 포함 여부 미기재)
  stage("티켓링크 라이브 아레나(SK올림픽핸드볼경기장)", t(18, 0), t(20, 20)), // BoA: 18:00 시작, 종료는 하린 기억(2h20m, 근거 없음 — 가정)
  stage("88잔디마당 무대", t(18, 0), t(19, 20)), // Lucky Daye(공식 타임테이블)
];

// 재현 창의 수음점: 8개 표준 장소 + 사건 당사자(투란도트 관객)가 있던 KSPO DOME 자체.
const places = [...DEFAULT_PLACE_NAMES, "KSPO DOME"].map((name) => ({ name, ...pt(name) }));

const series = [];
for (let h = 17; h <= 20; h++) {
  const weather = asosWeather("2024-10-12", h);
  if (!weather) continue;
  const hourIso = t(h);
  series.push({
    hour: hourIso, weather,
    cellsByPlace: placeCellsForHour({ places, stageSources, generatorSources: [], weather, hour: hourIso, concaweData }),
  });
}

console.log("# 사례 재현 실험: 2024-10-12 17~20시 (실제 기상 ASOS 서울 + 실제 공연 시각, 소음만)\n");
console.log("가정값: 음원 세기 100dB·7밴드 균등분배(실제 공연 음량 아님), BoA 종료시각·ASOS 전운량→SKY 변환은 위 주석 참고.\n");

for (const s of series) {
  console.log(`## ${s.hour.slice(11, 13)}시 — 바람 ${s.weather.windVecFromDeg}°에서 ${s.weather.wsd10m}m/s, 기온 ${s.weather.tempC}℃, 습도 ${s.weather.rhPercent}%, 안정도 ${s.weather.stability}`);
  for (const name of [...DEFAULT_PLACE_NAMES, "KSPO DOME"]) {
    const st = placeCellState(s.cellsByPlace[name]?.noise);
    console.log(`   ${name}: ${st.text}`);
  }
}

console.log("\n## 문장 예보 형식으로 보면:");
buildForecastSentences({ series, now: "2024-10-12T15:00:00+09:00" }).forEach((l, i) => console.log(`${i + 1}. ${l}`));

console.log("\n## 읽는 법");
console.log("- 노컷뉴스 보도대로면 18시 무렵부터 KSPO DOME 근처에서 외부 소음이 들렸다는 뜻이에요 — 위 'KSPO DOME' 줄의 18~19시 상태와 비교해 보세요.");
console.log("- '기준 미만'은 계산은 했지만 '약' 단계도 안 될 만큼 낮다는 뜻이에요(CLAUDE.md 2번) — 이 네 시간은 바람이 올림픽공원 밖 아파트 쪽(서·서북서풍 270~290°)이 아니라 다른 쪽으로 불어서, 표준 장소 8곳에서는 전부 '기준 미만'이 나왔어요.");
console.log("- KSPO DOME 줄이 17~18시 '계산 못 함'/'일부 정보 빠짐'인 이유: 수음점을 KSPO DOME 좌표 그대로 써서, KSPO DOME 음원 자체와 거리가 0m(100m 미만)이라 '근거리 계산 안 함' 규칙에 걸려요 — 모델이 '음원 바로 앞'은 신뢰 못 한다고 정직하게 비우는 거예요(CLAUDE.md 2번), 버그 아니에요.");
console.log("- 이 결과는 통과/실패를 정하지 않고 그대로 기록만 해요(CLAUDE.md §8 검증방침).");
