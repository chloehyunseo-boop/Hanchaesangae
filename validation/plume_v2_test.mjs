// 배출가스 v2 검증 (하린 라인, 2026-11-23). 실행: node validation/plume_v2_test.mjs
// v1 검증(plume_stage1~4, turner, lowerbound)은 v1 코드가 그대로라 그대로 유효해요. 여기선 v2가 더한 부분만 봐요.
import { calcExhaustAtReceiverV2, expandTrucksV2, nox계수V2, V2_ASSUMPTIONS } from "../engine/plume_v2.js";
import { calcExhaustAtReceiver, no2EmissionRateGPerS, noxEmissionFactorGPerKWh } from "../engine/plume.js";

let fails = 0;
const ok = (c, m, extra = "") => { console.log(`${c ? "✓" : "✗"} ${m}${extra ? `  → ${extra}` : ""}`); if (!c) fails++; };
const close = (a, b, tol = 1e-12) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

const D = { lat: 37.519163, lon: 127.127359 };
const mLon = 111320 * Math.cos((D.lat * Math.PI) / 180);
const at = (dx, dy) => ({ lat: D.lat + dy / 111320, lon: D.lon + dx / mLon });
const recv = at(0, -400); // 북풍이면 풍하
const W = { stability: "D", wsd10m: 3, windVecFromDeg: 0, 대기온도_C: 10 };

// 1) 배출률이 '엔진출력 × 0.43 × 목표 배출계수'와 정확히 같은지 (실효 부하율 방식 검증)
{
  const kw = V2_ASSUMPTIONS.엔진출력_kW;
  for (const grade of ["인증", "비인증"]) {
    const { generators } = expandTrucksV2([{ ...D, 발전기수: 1, 인증등급: grade }]);
    const g = generators[0];
    const got = kw * g.loadFactor * noxEmissionFactorGPerKWh(kw); // v1이 계산하는 곱
    const want = kw * 0.43 * nox계수V2(grade, kw);
    ok(close(got, want), `${grade}: 엔진출력×실효부하율×AP42 = 엔진출력×0.43×${nox계수V2(grade, kw)}`, `${got.toFixed(6)} g/h`);
  }
  ok(close(V2_ASSUMPTIONS.엔진출력_kW, 238.62395904), "엔진출력 320마력 = 238.62kW", V2_ASSUMPTIONS.엔진출력_kW.toFixed(5));
}

// 2) 배출계수 구간
ok(nox계수V2("인증", 238.6) === 0.40 && nox계수V2("인증", 600) === 0.67 && nox계수V2("인증", 50) === null, "인증 구간: 56~560kW 0.40, 560 초과 0.67, 56 미만 범위 밖");
ok(nox계수V2("비인증", 238.6) === 18.8 && nox계수V2("비인증", 500) === 14.6, "비인증 구간: 600마력 이하 18.8, 초과 14.6 (v1과 같음)");

// 3) 인증/비인증 농도비 = 배출계수비 (ARM2 없이 비교하려고 v1을 '전량NO2'로 직접 불러 확인)
{
  const gc = expandTrucksV2([{ ...D, 발전기수: 1, 인증등급: "인증" }]).generators;
  const gu = expandTrucksV2([{ ...D, 발전기수: 1, 인증등급: "비인증" }]).generators;
  // 배기 사양이 달라도 건물 옆(기본)이라 연기 상승이 없어 농도는 배출률에 정비례해요.
  const c = calcExhaustAtReceiver({ generators: gc, receiverLat: recv.lat, receiverLon: recv.lon, ...W, 가정: "전량NO2" }).value;
  const u = calcExhaustAtReceiver({ generators: gu, receiverLat: recv.lat, receiverLon: recv.lon, ...W, 가정: "전량NO2" }).value;
  ok(close(c / u, 0.40 / 18.8, 1e-10), "농도비(인증/비인증) = 0.40/18.8", (c / u).toFixed(6));
}

// 4) 발전차 펼치기: 5대 × 기본 2대 = 10대, 꼬리표
{
  const trucks = [0, 1, 2, 3, 4].map((i) => at((i - 2) * 10, 0));
  const ex = expandTrucksV2(trucks);
  ok(ex.generators.length === 10, "발전차 5대 → 발전기 10대(기본 2대씩)");
  for (const f of ["발전기수_가정(2대)", "인증등급미입력_인증가정", "배출계수_Tier4F한도", "엔진출력_대표모델가정(320마력)", "v2_대표모델사양"]) ok(ex.flags.includes(f), `꼬리표 ${f}`);
  const ex2 = expandTrucksV2([{ ...D, 발전기수: 1, 인증등급: "비인증", 엔진출력_kW: 150 }], "인증");
  ok(ex2.generators.length === 1 && !ex2.flags.includes("발전기수_가정(2대)") && ex2.flags.includes("배출계수_AP42비제어평균"), "입력한 값(1대·비인증·150kW)은 가정 꼬리표 없이 그대로");
}

// 5) 2대 = 1대의 두 배(같은 위치, 선형 구간 확인용으로 전량NO2)
{
  const one = calcExhaustAtReceiver({ generators: expandTrucksV2([{ ...D, 발전기수: 1 }]).generators, receiverLat: recv.lat, receiverLon: recv.lon, ...W, 가정: "전량NO2" }).value;
  const two = calcExhaustAtReceiver({ generators: expandTrucksV2([{ ...D, 발전기수: 2 }]).generators, receiverLat: recv.lat, receiverLon: recv.lon, ...W, 가정: "전량NO2" }).value;
  ok(close(two, 2 * one, 1e-12), "발전기 2대 = 1대 × 2");
}

// 6) 잘못된 입력은 계산 안 함(null + 이유)
for (const [bad, why] of [
  [{ trucks: [] }, "발전차 없음"],
  [{ trucks: [{ ...D, 인증등급: "Tier3" }] }, "인증등급 오타"],
  [{ trucks: [{ ...D, 발전기수: 0 }] }, "발전기 0대"],
  [{ trucks: [{ ...D, 엔진출력_kW: 30, 인증등급: "인증" }] }, "인증 56kW 미만"],
  [{ trucks: [{ ...D }], 배출시나리오: "모름" }, "시나리오 오타"],
]) {
  const r = calcExhaustAtReceiverV2({ ...bad, receiverLat: recv.lat, receiverLon: recv.lon, ...W });
  ok(r.value === null && r.flags.includes("계산불가"), `잘못된 입력(${why}) → null`, r.reason);
}

// 7) v1의 다른 동작이 그대로 살아 있는지: 근거리 하한값, 약풍, 시나리오 이름, 부하율 꼬리표
{
  const near = calcExhaustAtReceiverV2({ trucks: [at(0, -350)], receiverLat: recv.lat, receiverLon: recv.lon, ...W, 배출시나리오: "비인증" });
  ok(near.flags.includes("근거리불확실") && near.하한값 === 0, "근거리(50m) → 근거리불확실 + 하한값 0");
  const calm = calcExhaustAtReceiverV2({ trucks: [D], receiverLat: recv.lat, receiverLon: recv.lon, ...W, wsd10m: 0.5 });
  ok(calm.value === null && calm.flags.includes("약풍미표시"), "약풍 → null(약풍미표시)");
  const r = calcExhaustAtReceiverV2({ trucks: [D], receiverLat: recv.lat, receiverLon: recv.lon, ...W });
  ok(r.scenario.startsWith("v2_인증") && r.flags.includes("부하율EPA기본값") && r.flags.includes("ARM2"), "시나리오 이름 v2_인증, 꼬리표 부하율EPA기본값·ARM2", r.flags.join(","));
}

// 8) 기록(판정 없음): 11/26 10시(남풍 2.5m/s, C)·밤(북서풍 3m/s, E) 중심선 농도, DOME 발전차 5대
{
  const trucks = [0, 1, 2, 3, 4].map((i) => at((i - 2) * 10, 0));
  const lv = (v) => (v == null ? "?" : v >= 0.05 ? "강" : v >= 0.01 ? "중" : v >= 0.002 ? "약" : "-");
  for (const [name, vec, ws, st, T] of [["낮 남풍 2.5m/s C", 187, 2.5, "C", 9], ["밤 북서풍 3m/s E", 315, 3, "E", 5]]) {
    const to = ((vec + 180) * Math.PI) / 180;
    const row = [100, 300, 500, 1000, 2000].map((d) => {
      const p = { lat: D.lat + (d * Math.cos(to)) / 111320, lon: D.lon + (d * Math.sin(to)) / mLon };
      const v = ["인증", "비인증"].map((s) => calcExhaustAtReceiverV2({ trucks, 배출시나리오: s, receiverLat: p.lat, receiverLon: p.lon, stability: st, wsd10m: ws, windVecFromDeg: vec, 대기온도_C: T }).value);
      return `${d}m ${v.map((x) => x.toFixed(4) + lv(x)).join("/")}`;
    });
    console.log(`· ${name} (인증/비인증): ${row.join(" | ")}`);
  }
}

console.log(fails ? `\n실패 ${fails}건` : "\n전부 통과");
if (fails) process.exitCode = 1;
