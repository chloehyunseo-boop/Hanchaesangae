// 사례 재현 실험: 2024-06-15(토) 18~19시, 실제 기상관측(ASOS 서울 108) + 공단이 준 실측
// 소음 기록(docs/검증_20240615_소음실측.md, 할리스커피점 옥상/편익동 추정 좌표)을 엔진 계산과
// 직접 비교해요. 로드맵 §8 검증방침 "③ 사례 재현"을 이 날짜로 처음 돌려 본 실험용 스크립트.
// 실행: node validation/case_20240615_demo.mjs
//
// 기상: 기상자료개방포털(data.kma.go.kr) ASOS 서울(108) 시간자료, 2026-11-29 직접 조회(로그인
// 없이 공개 조회 화면에서 받음 — CLAUDE.md 2번대로 출처 명시, 가공 없이 그대로 옮김).
// validation/asos_seoul_20240615.csv에 원자료 저장.
//
// ⚠️ 가정인 것들(CLAUDE.md 2번대로 명시):
//  - 음원 세기(LW)·지면·스펙트럼은 시민/공단 화면이 실제로 쓰는 값(app/shared.js의
//    DEMO_BASE_LW_DB·DEMO_GROUND·DEMO_SPECTRUM)을 그대로 가져왔어요 — "편익동 쪽 순풍 조건에서
//    공단 기준 65dB가 나오는" 상한 가정값이고, 이날 실제 공연 음량이 아니에요.
//  - 그날 88잔디마당 '톤앤뮤직 페스티벌 2024'의 정확한 시작·종료 시각은 공개 출처를 못 찾았어요
//    — 측정기 1분값 자체가 18:01~19:00 내내 음악이 들렸다는 걸 보여주므로(L1 61.7dBA 등),
//    이 1시간 동안은 공연이 켜져 있었다고만 가정해요(그 전후는 모름 → 포함 안 함).
//  - ASOS는 기상청 단기예보 SKY 대신 전운량(0~10)을 줘요. 2024-10-12 사례 스크립트와 같은 근사로
//    맑음 0~5·구름많음 6~8·흐림 9~10 뭉뚱그림(엔진 코드가 아니라 이 데모 파일만의 가정).
//  - 측정지표 차이(공단 5분 평균 vs 엔진 1시간 평균)는 그대로 둬요 — docs/검증_20240615_소음실측.md
//    한계 2번 참고.

import { readFileSync } from "node:fs";
import { computeNoiseCellConcawe } from "../engine/combine.js";
import { stabilityFromForecast } from "../engine/plume.js";
import { CONCAWE_BANDS_HZ } from "../engine/noise.js";

// app/shared.js는 Leaflet(L)에 top-level로 기대고 있어 Node 검증 스크립트에서 바로 import가
// 안 돼요(2024-10-12 사례 스크립트와 같은 이유) — 그 파일의 상수(DEMO_BASE_LW_DB·DEMO_GROUND·
// DEMO_SPECTRUM, 2026-11-29 기준 값)를 그대로 베껴요. 값이 바뀌면 이 숫자도 같이 맞춰야 해요.
const DEMO_BASE_LW_DB = 135;
const DEMO_GROUND = { groundType: "soft", dSoftM: 300, hs: 1.5 };
const DEMO_SPECTRUM = Object.fromEntries(CONCAWE_BANDS_HZ.map((f) => [f, -10 * Math.log10(CONCAWE_BANDS_HZ.length)]));

const site = JSON.parse(readFileSync(new URL("../data/site.geojson", import.meta.url)));
const concaweData = JSON.parse(readFileSync(new URL("../data/concawe_4_81.json", import.meta.url)));
const byName = new Map(site.features.map((f) => [f.properties.name, f]));
const pt = (n) => { const [lon, lat] = byName.get(n).geometry.coordinates; return { lat, lon }; };

// 공단 11/26 답변 기준 측정 위치(만남의광장 인근 편익동, 할리스커피점 옥상) — 정확한 좌표는
// 공식 확인 안 됨, 할리스 올림픽공원역점 추정 좌표(decisions.md 2026-11-26 기록)
const RECEIVER = { lat: 37.5165625, lon: 127.1294375 };

// --- ASOS 서울(108) 2024-06-15 15~20시, validation/asos_seoul_20240615.csv(data.kma.go.kr
// 공개 조회 화면에서 2026-11-29 직접 받음, 2024-10-12 사례와 같은 CSV 형식) ---
const asosText = readFileSync(new URL("./asos_seoul_20240615.csv", import.meta.url), "utf8");
const [header, ...asosRows] = asosText.trim().split("\n").map((l) => l.split(","));
const col = Object.fromEntries(header.map((h, i) => [h, i]));
const ASOS = {};
for (const row of asosRows) {
  const hh = Number(row[col["일시"]].split(" ")[1].slice(0, 2));
  ASOS[hh] = {
    tempC: Number(row[col["기온(°C)"]]),
    wsd10m: Number(row[col["풍속(m/s)"]]),
    windVecFromDeg: Number(row[col["풍향(16방위)"]]), // 컬럼 이름은 ASOS 원본 그대로, 값은 도(°)
    rhPercent: Number(row[col["습도(%)"]]),
    cloud10: Number(row[col["전운량(10분위)"]] || 0),
  };
}
function cloudToSky(cloud10) {
  if (cloud10 <= 5) return "맑음";
  if (cloud10 <= 8) return "구름많음";
  return "흐림";
}
function asosWeather(hh) {
  const rec = ASOS[hh];
  if (!rec) return null;
  const hourIso = `2024-06-15T${String(hh).padStart(2, "0")}:00:00+09:00`;
  const { stability } = stabilityFromForecast({
    sky: cloudToSky(rec.cloud10), wsd10m: rec.wsd10m, lat: RECEIVER.lat, lon: RECEIVER.lon, dateUtc: new Date(hourIso),
  });
  return { tempC: rec.tempC, tmp: rec.tempC, rhPercent: rec.rhPercent, windVecFromDeg: rec.windVecFromDeg, wsd10m: rec.wsd10m, stability };
}

// --- 음원: 88잔디마당 무대, 시민/공단 화면과 같은 데모 가정값(위 import) ---
const t = (h) => `2024-06-15T${String(h).padStart(2, "0")}:00:00+09:00`;
function stage(start, end) {
  return { ...pt("88잔디마당 무대"), lwDb: DEMO_BASE_LW_DB, ...DEMO_GROUND, spectrumRatiosDb: DEMO_SPECTRUM, time: { start, end, 출처: "측정기 1분값이 그 시간대 음악을 보여줘서 그 1시간은 켜져 있었다고 가정(공식 공연시간표 출처 없음)" } };
}
const stageSources = [stage(t(18), t(19))];

console.log("# 사례 재현 실험: 2024-06-15 18~19시 (실제 기상 ASOS 서울 + 공단 실측 소음 비교)\n");
console.log("가정값: 음원 세기·지면·스펙트럼은 시민/공단 화면과 같은 데모값(app/shared.js), 공연 시간은 측정기록 기반 가정(위 주석 참고).\n");

for (let h = 17; h <= 20; h++) {
  const weather = asosWeather(h);
  if (!weather) continue;
  const hourIso = t(h);
  const cell = computeNoiseCellConcawe({ stageSources, receiver: RECEIVER, weather, hour: hourIso, concaweData });
  const valueText = typeof cell.value === "number" ? `${cell.value.toFixed(1)}dB(A)`
    : cell.flags?.length ? "계산 불가" : "공연 없음(이 시간대는 켜져 있다고 가정 안 함)";
  console.log(`## ${h}시 — 바람 ${weather.windVecFromDeg}°에서 ${weather.wsd10m}m/s, 기온 ${weather.tempC}℃, 습도 ${weather.rhPercent}%, 안정도 ${weather.stability}`);
  console.log(`   엔진 계산(편익동, 1시간 평균): ${valueText}${cell.flags?.length ? ` [${cell.flags.join(",")}]` : ""}`);
}

console.log("\n## 공단 실측값(docs/검증_20240615_소음실측.md)");
console.log("   18:01~19:00 1시간 LAeq: 56.8 dB(A) (5분 최댓값 59.6, 측정기 표 값 기준 61.0)");

console.log("\n## 읽는 법");
console.log("- 18시: 엔진 65.8dB(A) vs 공단 실측 56.8dB(A) — 엔진이 약 9dB 더 높게 나왔어요. 그날 실제 바람(270°, 3.6m/s)은 무대→편익동 방위각(125°)과 정확히 같은 방향은 아니었는데도(부채꼴 ±22.5° 안에서 최댓값을 골랐는데도) 이 정도 차이가 났어요.");
console.log("- 왜 그런지 짐작: 데모 음원 세기(135dB)는 '편익동 쪽으로 정확히 부는 순풍·3m/s·중립 대기'라는 최악 조건에서 딱 65dB가 나오게 역산한 값(decisions.md 11/26)이에요 — 실제 톤앤뮤직 페스티벌 음향 출력이 그 역산값만큼 크지 않았거나, 최악 가정 자체가 실제보다 더 잘 퍼지는 조건이었을 수 있어요(둘 다 가능, 이 자료 하나로는 구분 못 함).");
console.log("- 이 비교는 지점 하나·공연 하나·1시간뿐이라 엔진 정확도를 증명하는 자료가 아니에요. CLAUDE.md §8대로 통과/실패를 정하지 않고 그대로 기록만 해요.");
