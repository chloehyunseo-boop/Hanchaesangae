// 발전차 셋업 시작 시각(time.setupStart) 판정 검증 (하린 라인, 11/26). 실행: node validation/generator_setup_test.mjs
// 근거: 공단 답변(2026-11-26) "발전차는 무대가 설치됨과 동시에 사용, 셋업 일정에 따라 상이".
import { generatorActivityAtHour, computeExhaustCell } from "../engine/combine.js";

let fails = 0;
const ok = (c, m, extra = "") => { console.log(`${c ? "✓" : "✗"} ${m}${extra ? `  → ${extra}` : ""}`); if (!c) fails++; };
const t = (d, h, m = 0) => `2026-11-${d}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+09:00`;
const gen = (time) => ({ lat: 37.5186, lon: 127.1274, time: { 출처: "테스트", ...time } });
const show = { start: t(27, 19), end: t(27, 21) };

// 1) setupStart 없음 = 기존 규칙(공연 2시간 전~종료) 그대로
{
  const g = gen(show);
  ok(generatorActivityAtHour(g, t(27, 16)) === "inactive", "셋업 없음: 16~17시 칸 = 안 함");
  ok(generatorActivityAtHour(g, t(27, 17)) === "active", "셋업 없음: 17~18시 칸 = 가동 (2시간 전)");
  ok(generatorActivityAtHour(g, t(27, 21)) === "inactive", "셋업 없음: 21~22시 칸(종료 후) = 안 함");
  for (const empty of [null, ""]) ok(generatorActivityAtHour(gen({ ...show, setupStart: empty }), t(27, 16)) === "inactive", `setupStart ${JSON.stringify(empty)} = 없음과 같음`);
}

// 2) setupStart 있으면 그 시각부터
{
  const g = gen({ ...show, setupStart: t(27, 10) });
  ok(generatorActivityAtHour(g, t(27, 9)) === "inactive", "셋업 10시: 9~10시 칸 = 안 함");
  ok(generatorActivityAtHour(g, t(27, 10)) === "active", "셋업 10시: 10~11시 칸 = 가동");
  ok(generatorActivityAtHour(g, t(27, 14)) === "active", "셋업 10시: 14~15시 칸 = 가동 (예전 규칙이면 안 함)");
  ok(generatorActivityAtHour(g, t(27, 21)) === "inactive", "셋업 10시: 종료 후 = 안 함");
  const half = gen({ ...show, setupStart: t(27, 10, 30) });
  ok(generatorActivityAtHour(half, t(27, 10)) === "active", "셋업 10:30: 10~11시 칸 = 가동 (칸 일부만 겹쳐도)");
}

// 3) 공연 전날 셋업 → 전날 시간대도 가동
{
  const g = gen({ ...show, setupStart: t(26, 10) });
  ok(generatorActivityAtHour(g, t(26, 9)) === "inactive", "전날 10시 셋업: 전날 9시 = 안 함");
  ok(generatorActivityAtHour(g, t(26, 15)) === "active", "전날 10시 셋업: 전날 15시 = 가동");
  ok(generatorActivityAtHour(g, t(27, 3)) === "active", "전날 10시 셋업: 당일 새벽 3시 = 가동 (셋업~종료 계속 가동으로 봄)");
}

// 4) 잘못된 setupStart → 모름 (조용히 2시간 전으로 바꾸지 않음)
{
  ok(generatorActivityAtHour(gen({ ...show, setupStart: "bad" }), t(27, 18)) === "unknown", "못 읽는 setupStart → unknown");
  ok(generatorActivityAtHour(gen({ ...show, setupStart: t(27, 20) }), t(27, 18)) === "unknown", "setupStart가 공연 시작보다 늦음 → unknown");
  ok(generatorActivityAtHour(gen({ ...show, setupStart: t(27, 19) }), t(27, 18)) === "inactive", "setupStart = 공연 시작 → 그 시각부터 (18시 칸 안 함)");
}

// 5) 배출가스 칸 계산까지: 셋업 입력 시 공연 전날에도 값이 나오고, 없으면 그 시각은 가동 발전차 없음
{
  const weather = { stability: "D", wsd10m: 3, windVecFromDeg: 0, tmp: 10 };
  const receiver = { lat: 37.5186 - 300 / 111320, lon: 127.1274 }; // 남쪽 300m (북풍 풍하)
  const withSetup = computeExhaustCell({ generators: [gen({ ...show, setupStart: t(26, 10) })], receiver, weather, hour: t(26, 15) });
  const noSetup = computeExhaustCell({ generators: [gen(show)], receiver, weather, hour: t(26, 15) });
  ok(typeof withSetup.value === "number" && withSetup.value > 0, "셋업 입력: 전날 15시 배출가스 값 있음", `${withSetup.value?.toFixed(4)} ppm ${withSetup.level ?? "-"}`);
  ok(noSetup.value === null || noSetup.value === 0, "셋업 없음: 전날 15시 가동 발전차 없음", JSON.stringify({ value: noSetup.value, flags: noSetup.flags }));
}

console.log(fails ? `\n실패 ${fails}건` : "\n전부 통과");
if (fails) process.exitCode = 1;
