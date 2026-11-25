// scripts/update-events.mjs
// GitHub Actions가 매시 50분에 실행해요(.github/workflows/update-data.yml).
// 공단 '올림픽공원 공연정보' API(KSCperf)를 받아 data/events.json을 갱신해요.
// 인증키는 환경변수(KCISA_SERVICE_KEY)로만 받아요 — 코드·커밋에는 절대 안 넣어요.

import { writeFile } from "node:fs/promises";
import { fetchPerformances, parsePerformanceResponse } from "../engine/events.js";

// 수동 입력은 이 파일이 아니라 agency.html(공단 화면)의 localStorage에 있어요(발전차 입력과
// 같은 방식 — "공단 화면 입력은 그 브라우저에만 저장되는 시연 기능", 로드맵 문서).
// 이 스크립트는 공단 API로 자동 수집한 것만 다뤄요.

async function main() {
  const serviceKey = process.env.KCISA_SERVICE_KEY;
  const now = new Date();
  const 실패기록 = [];

  let 공연 = [];
  const res = await fetchPerformances({ serviceKey });
  if (res.ok) {
    공연 = parsePerformanceResponse(res.raw);
    // 11/25 진단용(한시적): 날짜 필드 이름을 아직 몰라서(CLAUDE.md 5번 미확인), 첫 항목의
    // 실제 필드 이름을 Actions 로그에만 남겨요(공개 공연 정보라 민감하지 않음, 레포에는
    // 저장 안 함) — 이름을 확인하면 engine/events.js의 parsePerformanceResponse를 고치고
    // 이 로그는 지울게요.
    const firstRaw = res.raw?.response?.body?.items?.item?.[0];
    if (firstRaw) console.log("[진단] 첫 항목 필드 이름:", Object.keys(firstRaw).join(", "));
  } else {
    실패기록.push({ 시각: now.toISOString(), 사유: res.사유 });
  }

  const record = {
    _설명: "GitHub Actions가 매시 50분에 갱신해요(공단 공연정보 API 자동 수집만). 수동 입력은 agency.html의 이 브라우저 저장소(localStorage)에 따로 있어요.",
    저장시각: now.toISOString(),
    공연,
    실패기록,
  };

  await writeFile(new URL("../data/events.json", import.meta.url), JSON.stringify(record, null, 2) + "\n");

  if (공연.length === 0 && 실패기록.length > 0) {
    console.error("공연 일정을 하나도 못 받았어요:", 실패기록);
    process.exitCode = 1;
  } else {
    console.log(`공연 ${공연.length}건 자동 수집, 실패 ${실패기록.length}건`);
  }
}

main();
