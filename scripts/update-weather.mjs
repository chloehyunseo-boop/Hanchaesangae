// scripts/update-weather.mjs
// GitHub Actions가 매시 50분에 실행해요(.github/workflows/update-data.yml).
// 기상청 초단기예보·단기예보를 받아 data/weather.json을 갱신해요.
// 인증키는 환경변수(KMA_SERVICE_KEY)로만 받아요 — 코드·커밋에는 절대 안 넣어요.

import { writeFile } from "node:fs/promises";
import { fetchLatestForecast, parseForecastResponse, mergeForecasts } from "../engine/weather.js";

async function main() {
  const serviceKey = process.env.KMA_SERVICE_KEY;
  const now = new Date();
  const 실패기록 = [];

  let ultraItems = [];
  const ultra = await fetchLatestForecast({ serviceKey, kind: "ultra", now });
  if (ultra.ok) {
    ultraItems = parseForecastResponse(ultra.raw, "ultra");
  } else {
    실패기록.push({ 시각: now.toISOString(), 사유: `초단기예보: ${ultra.사유}` });
  }

  let vilageItems = [];
  const vilage = await fetchLatestForecast({ serviceKey, kind: "vilage", now });
  if (vilage.ok) {
    vilageItems = parseForecastResponse(vilage.raw, "vilage");
  } else {
    실패기록.push({ 시각: now.toISOString(), 사유: `단기예보: ${vilage.사유}` });
  }

  const 예보 = mergeForecasts(ultraItems, vilageItems, now);

  const record = {
    _설명: "GitHub Actions가 매시 50분에 갱신해요. 값이 없는 시각은 비워 둬요(임의로 채우지 않음).",
    저장시각: now.toISOString(),
    예보,
    실패기록,
  };

  await writeFile(new URL("../data/weather.json", import.meta.url), JSON.stringify(record, null, 2) + "\n");

  if (예보.length === 0 && 실패기록.length > 0) {
    console.error("예보를 하나도 못 받았어요:", 실패기록);
    process.exitCode = 1;
  } else {
    console.log(`예보 ${예보.length}건 저장, 실패 ${실패기록.length}건`);
  }
}

main();
