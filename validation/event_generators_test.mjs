// 공연 일정 → 발전차 자동 생성 검증 (하린 라인, 11/26). 실행: node validation/event_generators_test.mjs
import { readFileSync } from "node:fs";
import { buildRealEventGeneratorSources, defaultGeneratorCount } from "../engine/event_generators.js";
import { generatorActivityAtHour } from "../engine/combine.js";

// app/shared.js는 Leaflet(L)을 불러오는 순간 쓰므로, 시간 규칙 비교용으로 최소한만 흉내 내요.
globalThis.L = { Layer: { extend: (o) => o } };
const { buildRealEventStageSources } = await import("../app/shared.js");

let fails = 0;
const ok = (c, m, extra = "") => { console.log(`${c ? "✓" : "✗"} ${m}${extra ? `  → ${extra}` : ""}`); if (!c) fails++; };

const assumptions = JSON.parse(readFileSync(new URL("../data/assumptions.json", import.meta.url)));
const site = JSON.parse(readFileSync(new URL("../data/site.geojson", import.meta.url)));
const siteByName = new Map(site.features.map((f) => [f.properties.name, f]));

// 1) 대수 규칙
ok(defaultGeneratorCount("KSPO DOME", assumptions) === 5, "KSPO DOME = 공단 확인값 5대");
ok(defaultGeneratorCount("올림픽홀", assumptions) === 1, "올림픽홀 = 확인된 최소 1대");
ok(defaultGeneratorCount("88잔디마당", assumptions) === 1, "야외(88잔디마당)도 1대");
ok(defaultGeneratorCount("올림픽공원 테니스경기장", assumptions) === 0, "테니스경기장 = 매연 계산 범위 밖 0대");
ok(defaultGeneratorCount("없는장소", assumptions) === 0, "모르는 장소 0대");
ok(defaultGeneratorCount("KSPO DOME", { ...assumptions, 발전차_기본대수: undefined }) === 0, "규칙이 없으면 만들지 않음");

// 2) 가짜 일정
const events = { 공연: [
  { 출처: "공단일정페이지", site: "KSPO DOME", 기간시작: "2026-11-27", 기간끝: "2026-11-29", 일자별시작: { "2026-11-27": "19:00" } },
  { 출처: "공단일정페이지", site: "올림픽홀", 기간시작: "2026-11-27", 기간끝: "2026-11-27", 일자별시작: {} },
  { 출처: "공단일정페이지", site: "88잔디마당", 기간시작: "2026-11-27", 기간끝: "2026-11-27", 일자별시작: { "2026-11-27": "19:30" } },
  { 출처: "공단API", site: "KSPO DOME", 기간시작: "2026-11-27", 기간끝: "2026-11-27", 일자별시작: { "2026-11-27": "10:00" } },
] };
const h = "2026-11-27T20:00:00+09:00";
const gens = buildRealEventGeneratorSources(events, siteByName, assumptions, h);
const by = (s) => gens.filter((g) => g.site === s);
ok(by("KSPO DOME").length === 5, "KSPO DOME 공연일 → 5대 (과거 기록 공단API는 무시)", `${by("KSPO DOME").length}`);
ok(by("올림픽홀").length === 1 && by("올림픽홀")[0].time.출처 === "미확인", "시작 시각 모르는 공연 → 1대, 시간 '미확인'");
ok(generatorActivityAtHour(by("올림픽홀")[0], h) === "unknown", "→ 엔진에서 '모름'(칸 비움)");
ok(by("88잔디마당")[0].time.end === new Date("2026-11-27T21:30:00+09:00").toISOString(), "야외는 21:30에서 끊음");
ok(by("KSPO DOME")[0].time.end === new Date("2026-11-27T22:00:00+09:00").toISOString(), "실내는 시작+3시간");
ok(generatorActivityAtHour(by("KSPO DOME")[0], "2026-11-27T17:00:00+09:00") === "active", "19:00 공연 → 17시대 가동(2시간 전부터)");
ok(generatorActivityAtHour(by("KSPO DOME")[0], "2026-11-27T16:00:00+09:00") === "inactive", "16시대는 가동 안 함");
ok(buildRealEventGeneratorSources(events, siteByName, assumptions, "2026-11-30T20:00:00+09:00").length === 0, "공연 없는 날 → 발전차 없음");
ok(by("KSPO DOME").every((g) => g.엔진출력_kW === undefined && g.인증등급 === undefined), "사양은 비워 둠 → v2 대표모델 가정");

// 2-1) 공단 '발전차 사용 안 함' / 실제 입력 우선 (11/27)
ok(defaultGeneratorCount("올림픽공원 K아트홀", assumptions) === 1, "K아트홀 = 1대 (11/27 포함 결정)");
const skipNo = buildRealEventGeneratorSources(events, siteByName, assumptions, h, { noGeneratorDays: [{ site: "올림픽홀", 날짜: "2026-11-27" }] });
ok(!skipNo.some((g) => g.site === "올림픽홀") && skipNo.some((g) => g.site === "KSPO DOME"), "'사용 안 함' 표시한 공연장·날짜만 빠짐");
const skipOtherDay = buildRealEventGeneratorSources(events, siteByName, assumptions, h, { noGeneratorDays: [{ site: "올림픽홀", 날짜: "2026-11-28" }] });
ok(skipOtherDay.some((g) => g.site === "올림픽홀"), "다른 날짜에 표시한 건 영향 없음");
const skipEntered = buildRealEventGeneratorSources(events, siteByName, assumptions, h, { enteredDays: [{ site: "KSPO DOME", 날짜: "2026-11-27" }] });
ok(!skipEntered.some((g) => g.site === "KSPO DOME"), "공단이 실제 입력한 날은 기본 대수 안 넣음(입력값 우선)");
const skipAll = buildRealEventGeneratorSources(events, siteByName, assumptions, h, { enteredAllDaysSites: ["KSPO DOME"] });
ok(!skipAll.some((g) => g.site === "KSPO DOME"), "날짜 없는(상시) 입력이 있으면 그 공연장은 자동 생성 안 함");
{
  const { buildCitizenGeneratorSources } = await import("../app/shared.js");
  const cg = buildCitizenGeneratorSources({ events, truckRecords: [{ site: "KSPO DOME", 시작시각: "2026-11-27T19:00", 발전기수: 2 }],
    noGeneratorDays: [{ site: "올림픽홀", 날짜: "2026-11-27" }], siteByName, assumptions, hourIso: h });
  ok(cg.length === 2 && cg.filter((g) => g.time?.출처 === "공단화면입력").length === 1 && cg.some((g) => g.site === "88잔디마당"),
    "시민 화면 함수: 공단 입력 1대 + 88잔디마당 자동 1대, 올림픽홀 빠짐", `${cg.length}대`);
}

// 3) 소음 쪽(buildRealEventStageSources)과 공연 시간이 똑같은지
const stages = buildRealEventStageSources(events, siteByName, "기본", assumptions, h);
const key = (t) => `${t.start}|${t.end}|${t.출처}`;
const stageTimes = stages.map((s) => key(s.time)).sort();
const genTimes = [...new Set(gens.map((g) => key(g.time)))].sort();
ok(JSON.stringify(stageTimes) === JSON.stringify(genTimes), "소음 음원과 발전차의 공연 시간 규칙이 같음", genTimes.join(" , "));

// 4) 실제 data/events.json으로 지금 어떻게 되는지(참고 출력)
const real = JSON.parse(readFileSync(new URL("../data/events.json", import.meta.url)));
for (const d of ["2026-11-27", "2026-11-28", "2026-11-29", "2026-11-30"]) {
  const g = buildRealEventGeneratorSources(real, siteByName, assumptions, `${d}T19:00:00+09:00`);
  const summary = Object.entries(g.reduce((m, x) => ((m[x.site] = (m[x.site] ?? 0) + 1), m), {}))
    .map(([s, n]) => `${s} ${n}대${g.find((x) => x.site === s).time.출처 === "미확인" ? "(시간 모름)" : ""}`).join(", ");
  console.log(`· ${d}: ${summary || "발전차 없음"}`);
}

console.log(fails ? `\n실패 ${fails}건` : "\n전부 통과");
if (fails) process.exitCode = 1;
