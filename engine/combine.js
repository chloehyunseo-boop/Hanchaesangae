// engine/combine.js — 엔진 연결 (친구 라인, 11/19 작성, 11/21 plume.js 동결에 맞춰 수정)
// 소음(noise.js)·배출가스(plume.js) 두 엔진을 한 시각·한 격자에 대해 돌려서
// engine/common.js의 OutputCell[] 모양으로 합쳐요. 계산 자체는 두 엔진이 하고,
// 여기는 "격자 만들기 + 둘을 같은 모양으로 합치기"만 해요(로드맵 M2 11/19).
//
// 소음은 11/21 결정대로 ISO 9613-2 "상한" 시나리오(거리 감쇠+공기 흡수+무대 지향성+바람
// 부채꼴, 지면 효과 제외 — noise.js 상단 주석 참고)로 dB를 내요. 다만 음원 세기(LW)가
// 아직 확정 안 된 무대는 source.lwDb/source.indoor를 안 넣으면 value:null로 빠져요.
// 배출가스는 plume.js의 calcExhaustAtReceiver()로 실제 ppm 값을 내요 — 수음점마다
// 그 시각에 가동 중인 발전차를 전부 모아 한 번만 불러요(합산·풍향 부채꼴·ARM2는
// 그 함수 안에서 처리, 11/21 하린 지시).
//
// 좌표는 아직 EPSG:5186(미터)이 아니라 위경도 그대로 둬요(common.js 3.5절과 같은 이유,
// OutputCell.x/y 주석도 11/21에 맞춰 고쳤어요).

import { CALC_GRID, mapDisplayFor, WIND_FAN_HALF_WIDTH_DEG } from "./common.js";
import {
  calcNoiseIso9613UpperOctave, indoorFacadeSourcePowerLevel, classifyNoiseLevel,
  stageActiveMinutes, timeWeightDb, calcConcaweBand, CONCAWE_BANDS_HZ, logSumDb, A_WEIGHT_DB,
  sourceReceiverGeometry, validateSpectrum,
} from "./noise.js";

const finite = (v) => typeof v === "number" && Number.isFinite(v);
import { classifyExhaustLevel } from "./plume.js";
// 11/24 하린 지시(배출가스 v2 연결, 커밋 813eef1): 발전차 입력을 "국내 현실"(발전기 2대,
// Cat XQ230 인증/DE200 GC 비인증)로 바꾼 v2를 써요. v1(calcExhaustAtReceiver)은 plume_v2.js
// 안에서 그대로 불려요 — 계산 자체(가우시안 플룸·ISC3·Turner·Briggs·ARM2·부채꼴·하한값)는
// 안 바뀌고 "발전차 1대 = 몇 kW짜리 엔진 몇 대"만 바뀌어요. v1으로 되돌리려면 이 import만
// calcExhaustAtReceiver(plume.js)로 바꾸면 돼요.
import { calcExhaustAtReceiverV2 } from "./plume_v2.js";

const DEG_PER_M_LAT = 1 / 111320;

/**
 * CALC_GRID.bounds 안을 cellSizeM 간격의 격자점으로 채워요(위경도 근사).
 * @param {number} [cellSizeM]
 * @returns {{lat: number, lon: number}[]}
 */
export function generateGridPoints(cellSizeM = CALC_GRID.cellSizeM) {
  if (!(cellSizeM > 0)) throw new Error(`격자 간격은 0보다 커야 해요(무한 반복 방지, 외부 검토 지적): ${cellSizeM}`);
  const { minLat, maxLat, minLon, maxLon } = CALC_GRID.bounds;
  const midLat = (minLat + maxLat) / 2;
  const latStep = cellSizeM * DEG_PER_M_LAT;
  const lonStep = cellSizeM * DEG_PER_M_LAT / Math.cos((midLat * Math.PI) / 180);
  const points = [];
  for (let lat = minLat; lat <= maxLat; lat += latStep) {
    for (let lon = minLon; lon <= maxLon; lon += lonStep) {
      points.push({ lat, lon });
    }
  }
  return points;
}

/**
 * 발전차 하나가 그 시각에 가동 중인지 — time.setupStart(무대 셋업 시작, 선택)가 있으면 그때부터,
 * 없으면 연결된 공연 시작 2시간 전부터 종료까지예요.
 * 11/26 하린: 공단 답변("발전차는 무대가 설치됨과 동시에 사용, 셋업 일정에 따라 상이")으로
 * '2시간 전'은 발전차 가동 시간의 근거가 아님이 확인됐어요(대관운영 시행세칙 제20조 ④의
 * 공연당일 진행 시작 시각을 빌린 값). 셋업 기간 숫자는 공개 근거가 없어 만들지 않고, 공단이
 * 셋업 시작 시각을 입력하면 그때부터 계산해요. 입력이 없으면 '최소 가동 시간'(과소 추정)이에요.
 * 근거: docs/발전차_배출가스_가정값과_근거.md "가동 시간 (11/26 공단 답변 반영)".
 * "가동 안 함(확실)"과 "시간을 몰라서 못 판단함"을 구분해요(하린 11/22 요청) —
 * 둘 다 예전엔 똑같이 false였는데, 매연은 "모르면 발전차 하나 때문에 전체를 비운다"는
 * 설계(calcExhaustAtReceiver의 all-or-nothing 방식과 같은 원칙, 하린 11/22 확인)라서
 * computeExhaustCell이 이 둘을 다르게 처리해야 해요.
 * @param {{time?: {start: string|null, end: string|null, setupStart?: string|null, 출처: string}}} generator
 * @param {string} hourIso
 * @returns {"active"|"inactive"|"unknown"}
 */
export function generatorActivityAtHour(generator, hourIso) {
  const time = generator?.time;
  if (!time || time.출처 === "미확인" || !time.start) return "unknown"; // 정보 자체가 없음/명시적 미확인
  // 5차 외부 검토 지적(11/22, 하린): hourIso 자체가 깨진 문자열이면 hourMs가 NaN이 되는데,
  // 아래 두 비교(< , >=)가 NaN과 비교하면 항상 false라 "가동 중"으로 둔갑했어요. 호출하는
  // 쪽(combine.js 안)은 항상 유효한 hourIso를 주지만, 방어적으로 막아요.
  const hourStartMs = new Date(hourIso).getTime();
  if (!Number.isFinite(hourStartMs)) return "unknown";
  const hourEndMs = hourStartMs + 3600 * 1000;
  const startMs = new Date(time.start).getTime();
  // 4차 외부 검토 지적(11/22): 시작 시각이 파싱 안 되는 문자열(예: "bad")이면 startMs가
  // NaN이 되는데, "hourMs < activeFromMs"는 NaN과 비교하면 항상 false라 제외 로직을 그냥
  // 통과해서 "가동 중"으로 둔갑했어요(noise.js의 stageActiveMinutes에 11/22에 먼저 고친
  // 것과 똑같은 버그가 combine.js에도 있었음). 파싱 실패는 "모름"으로 둬요(값은 있는데
  // 못 믿는 거라, "가동 안 함"이라고 확신할 수 없음).
  if (!Number.isFinite(startMs)) return "unknown";
  let activeFromMs = startMs - 2 * 3600 * 1000;
  // 11/26 하린: 셋업 시작 시각(선택). 있으면 그때부터 가동. 못 읽히거나 공연 시작보다 늦으면
  // 입력 실수라 "모름"으로 둬요(start 파싱 실패와 같은 원칙 — 조용히 2시간 전으로 바꾸지 않음).
  // 셋업이 '공연 2시간 전'보다 늦게(예: 1시간 전) 입력돼도 그 시각부터예요 — 입력값이 우선이에요.
  if (time.setupStart !== undefined && time.setupStart !== null && time.setupStart !== "") {
    const setupMs = new Date(time.setupStart).getTime();
    if (!Number.isFinite(setupMs) || setupMs > startMs) return "unknown";
    activeFromMs = setupMs;
  }
  let endMs = null;
  if (time.end) {
    endMs = new Date(time.end).getTime();
    if (!Number.isFinite(endMs)) return "unknown"; // 종료 시각이 있는데 못 읽음 → 모름
    // 5차 외부 검토(11/22, 하린) + 6차 재검토(11/23, 하린): 종료가 시작보다 빠르면(예: 자정
    // 넘는 공연을 날짜 안 바꾸고 입력한 실수) "가동 안 함"으로 조용히 흘러가던 문제 — 모름으로
    // 둬요. 처음엔 activeFromMs(시작 2시간 전)와 비교했는데, 그러면 "시작 19:30·종료 18:00"
    // 같은 입력(activeFromMs=17:30)이 18:00<=17:30이 거짓이라 걸러지지 않고 17:30~18:00이
    // 조용히 "가동"으로 계산되는 구멍이 있었어요 — 역전 여부는 시작 시각(startMs) 자체와
    // 비교해야 맞아요.
    if (endMs <= startMs) return "unknown"; // 시간 역전
  }
  // 5차 외부 검토 지적(11/22, 하린): "이 시간대 칸의 시작 시각"만 activeFromMs와 비교해서,
  // 19:30 시작(가동 시작 17:30)인데 17:00~18:00 칸은 "칸 시작(17:00)이 17:30보다 이르다"는
  // 이유로 통째로 '안 함'이 됐어요 — 실제로는 그 칸의 절반(17:30~18:00)은 가동 중이에요.
  // 칸 전체(hourEndMs)가 가동 시작 전에 끝나야만 "확실히 안 함"이에요.
  if (hourEndMs <= activeFromMs) return "inactive";
  if (endMs !== null && hourStartMs >= endMs) return "inactive"; // 칸 전체가 종료 후
  return "active";
}

/**
 * @deprecated generatorActivityAtHour를 쓰세요 — "모름"과 "확실히 안 함"을 구분 못 해요.
 * 외부에서 단순 가동 여부만 필요할 때를 위해 남겨뒀어요.
 */
export function isGeneratorActiveAtHour(generator, hourIso) {
  return generatorActivityAtHour(generator, hourIso) === "active";
}

/**
 * 한 수음점의 배출가스 OutputCell을 만들어요. 그 시각에 가동 중인 발전차를 전부 모아
 * plume.js의 calcExhaustAtReceiver를 한 번만 불러요(발전차별로 따로 안 부름 — 합산·풍향
 * 부채꼴·ARM2를 그 함수 안에서 다 처리해요. 하린 11/21 지시 1번).
 * generators 배열의 각 원소는 발전차(트럭) 한 대예요(v2, 11/24) — 트럭 안에 발전기가
 * 몇 대인지(기본 2대)는 plume_v2.js의 expandTrucksV2가 펼쳐서 세요. 가동 시간 판정은
 * 지금처럼 트럭 단위로 해요(하린 11/24 지시).
 * @param {{ generators: any[], receiver: {lat:number, lon:number}, weather: {stability, wsd10m, windVecFromDeg, tmp?: number|null}, hour: string, 가정?: "기본추정"|"기존입력가정"|"연기상승제외"|"전량NO2", 배출시나리오?: "인증"|"비인증" }} p
 * @returns {import("./common.js").OutputCell}
 */
export function computeExhaustCell({ generators, receiver, weather, hour, 가정 = "기본추정", 배출시나리오 = "인증" }) {
  const baseCell = { x: receiver.lon, y: receiver.lat, hour, layer: "exhaust" };
  const scenario = `v2_${배출시나리오}_가우시안플룸_ISC3도시형확산계수_풍향부채꼴최대_${가정}`;

  const activeGenerators = [];
  let unknownCount = 0;
  const extraFlags = new Set();
  for (const g of generators) {
    const status = generatorActivityAtHour(g, hour);
    if (status === "active") activeGenerators.push(g);
    else if (status === "unknown") {
      unknownCount++;
      // 5차 외부 검토 지적(11/22, 하린): "시간 정보가 아예 없음/파싱 실패"와 "종료가 시작
      // 보다 빠름(입력 실수로 보이는 시간 역전)"은 원인이 달라서 따로 표시해요.
      const s = g?.time?.start ? new Date(g.time.start).getTime() : NaN;
      const e = g?.time?.end ? new Date(g.time.end).getTime() : NaN;
      if (Number.isFinite(s) && Number.isFinite(e) && e <= s) extraFlags.add("발전차시간역전");
    }
  }

  // 하린 11/22 요청: 발전차 하나라도 "가동 중인지 몰라서" 뺀 거라면, 그 하나 때문에
  // 전체 농도가 과소평가될 수 있어요(매연은 발전차 하나 이상이면 전체를 비우는 설계와
  // 같은 원칙 — ARM2가 전체 NOx 합으로 계산돼서 일부만 빼면 비율 자체가 틀려짐).
  // "확실히 가동 안 함"(시간을 알고 그 시간엔 꺼져 있음)과는 구분해요.
  if (unknownCount > 0) {
    return { ...baseCell, value: null, level: null, flags: ["발전차시간미확인", ...extraFlags], scenario };
  }
  if (activeGenerators.length === 0) {
    return { ...baseCell, value: null, level: null, flags: ["가동중발전차없음"], scenario };
  }
  const result = calcExhaustAtReceiverV2({
    trucks: activeGenerators,
    배출시나리오,
    receiverLat: receiver.lat,
    receiverLon: receiver.lon,
    stability: weather.stability,
    wsd10m: weather.wsd10m,
    windVecFromDeg: weather.windVecFromDeg,
    // 기상청 TMP. 없으면 undefined/null 그대로 — calcExhaustAtReceiver가 null을 undefined로
    // 받아들이고, 기온 없음은 연기 상승을 빼는 쪽으로 처리해요(하린 11/21 지시 3번).
    대기온도_C: weather.tmp,
  });
  // 11/22 결정(사용자+하린, "근거리불확실" 표시 방식 B안): 발전차 중 일부가 100m 이내라
  // 전체 값이 불확실(근거리불확실)해도, 그 발전차들을 뺀 합계(하한값)는 실제 농도의
  // 진짜 하한이에요(NO2는 ARM2 환산이라도 NOx가 늘면 줄지 않으니, 빼면 값이 줄 수밖에
  // 없음 — 외부 검토가 확인). plume.js(하린)가 calcExhaustAtReceiver 결과에 `하한값`을
  // 실제로 넣어줘요(11/23, "근거리불확실"이 붙을 때만 숫자, 그 외엔 null) — 여기서는
  // 그대로 받아 등급만 매겨서 화면에 "빗금 + ○○ 이상"으로 보여줄 수 있게 해요.
  const 하한값 = typeof result.하한값 === "number" ? result.하한값 : null;
  return {
    ...baseCell,
    value: result.value,
    level: classifyExhaustLevel(result.value),
    flags: result.flags,
    scenario: result.scenario,
    하한값,
    하한등급: 하한값 !== null ? classifyExhaustLevel(하한값) : null,
  };
}

/**
 * 무대 음원 하나 × 수음점 하나의 소음 OutputCell을 만들어요(ISO 9613-2 **상한 추정, 공단
 * 화면 비교용** — 로드맵 §2 표. 시민·공단 메인 지도는 computeNoiseCellConcawe()를 써요).
 * 실내 공연장은 source.indoor={lpIndoorDb, R, S}를 주면 indoorFacadeSourcePowerLevel로
 * LW를 구해요. 실외 무대나 아직 LW를 모르는 음원은 source.lwDb를 직접 주거나, 둘 다
 * 없으면 value:null("음원세기미확인")로 빠져요 — 지어낸 숫자를 넣지 않아요.
 * source.time이 있으면 그 시간 중 실제로 가동된 분만큼 에너지 가중(LAeq,1h)을 더해요
 * (30분만 가동 → 약 −3dB, 로드맵 2번 공통 조건·11/21 추가).
 * @returns {import("./common.js").OutputCell}
 */
export function computeNoiseCell({ source, receiver, weather, hour }) {
  const { activeMinutes, flags: timeFlags } = stageActiveMinutes(source, hour);
  if (activeMinutes <= 0) {
    return { x: receiver.lon, y: receiver.lat, hour, layer: "noise", value: null, level: null, flags: [...timeFlags, "지면효과미적용"], scenario: "ISO9613-2_상한추정_지면효과미적용" };
  }
  const lwDb = source.indoor
    ? indoorFacadeSourcePowerLevel(source.indoor.lpIndoorDb, source.indoor.R, source.indoor.S)
    : source.lwDb;
  const result = calcNoiseIso9613UpperOctave({
    sourceLat: source.lat,
    sourceLon: source.lon,
    receiverLat: receiver.lat,
    receiverLon: receiver.lon,
    windVecFromDeg: weather.windVecFromDeg,
    lwDb,
    tempC: weather.tempC,
    rhPercent: weather.rhPercent,
    spectrumRatiosDb: source.spectrumRatiosDb,
    allowApprox: source.allowApprox === true, // 기본 false — 스펙트럼 없으면 계산 안 함(로드맵 §2 규칙)
  });
  let value = result.value;
  const flags = [...timeFlags, ...result.flags];
  if (value !== null) {
    const weight = timeWeightDb(activeMinutes);
    value += weight;
    if (activeMinutes < 60) flags.push(`시간가중_${Math.round(activeMinutes)}분`);
  }
  return {
    x: receiver.lon,
    y: receiver.lat,
    hour,
    layer: "noise",
    value,
    level: classifyNoiseLevel(value),
    flags,
    scenario: result.scenario,
  };
}

/**
 * 수음점 하나의 소음 OutputCell을 CONCAWE 전체(K1~K7)로 계산해요 — **시민·공단 메인
 * 지도**(로드맵 §2 표, 11/21에 ISO9613과 역할이 바뀐 걸 확인함). 동시에 여러 공연이
 * 있으면 로드맵 계산 순서(①시간가중 → ②같은 밴드 음원 합산 → ③A가중 → ④밴드 합산)
 * 그대로, 밴드마다 활성 음원들을 먼저 에너지 합산한 뒤 A가중·밴드합을 해요.
 *
 * 풍향 부채꼴(11/24 사용자 결정): 로드맵 §2 "공통 조건"이 "풍향 불확실성은 한 방향 선이
 * 아니라 부채꼴로 그린다"고 해서, 배출가스(plume.js)와 똑같이 예보 풍향 ±22.5°
 * (common.js WIND_FAN_HALF_WIDTH_DEG) 안에서 2.5° 간격으로 돌려 보고 합계(dB(A))가 가장
 * 큰 방향을 써요(플래그 '풍향부채꼴최대'). 거리·근거리 제외·스펙트럼 같은 "방향과 무관한"
 * 판정은 한 번만 하고, 방향에 따라 바뀌는 K4(기상범주)·결과값만 방향마다 다시 계산해요
 * (거리가 안 바뀌니 어느 음원이 포함/제외되는지는 방향에 안 바뀜 — 11/21 이전엔 예보 풍향
 * 하나만 썼어요, decisions.md 11/24 기록 참고).
 * @param {{ stageSources: any[], receiver: {lat:number, lon:number}, weather: { windVecFromDeg: number,
 *   wsd10m: number, stability: string, tempC: number, rhPercent: number }, hour: string, concaweData: object,
 *   fanHalfWidthDeg?: number, fanStepDeg?: number }} p
 *   각 stageSources 항목은 lat/lon/time 외에 lwDb(또는 indoor), spectrumRatiosDb(필수 — 없으면
 *   그 음원은 '옥타브스펙트럼필수_모양미확인'으로 빠짐), groundType("hard"|"soft"), dSoftM, hs(음원 높이), hr?.
 * @returns {import("./common.js").OutputCell}
 */
export function computeNoiseCellConcawe({
  stageSources, receiver, weather, hour, concaweData,
  fanHalfWidthDeg = WIND_FAN_HALF_WIDTH_DEG, fanStepDeg = 2.5,
}) {
  const scenario = "CONCAWE_전체_시간별추정";
  const baseCell = { x: receiver.lon, y: receiver.lat, hour, layer: "noise" };

  // 2차 외부 검토 지적(11/22): 이 함수가 geometry·v를 raw weather/receiver로 직접 계산해서
  // noise.js의 validateNoiseInput을 전혀 거치지 않고 있었어요(leaf 함수만 검증되고 실제
  // 메인 지도가 부르는 이 함수는 뚫려 있던 구멍). null*숫자=0으로 조용히 무풍 처리되거나,
  // 범위 밖 각도가 모듈로 연산을 그냥 통과하는 일을 막기 위해 공통 입력을 맨 앞에서 한 번에
  // 검사해요 — 하나라도 틀리면 셀 전체를 계산 안 함(null)으로 둬요.
  if (!finite(receiver.lat) || receiver.lat < -90 || receiver.lat > 90) return { ...baseCell, value: null, level: null, flags: ["계산불가_수음점좌표"], scenario };
  if (!finite(receiver.lon) || receiver.lon < -180 || receiver.lon > 180) return { ...baseCell, value: null, level: null, flags: ["계산불가_수음점좌표"], scenario };
  if (!finite(weather.wsd10m) || weather.wsd10m < 0) return { ...baseCell, value: null, level: null, flags: ["계산불가_풍속"], scenario };
  if (!finite(weather.windVecFromDeg) || weather.windVecFromDeg < 0 || weather.windVecFromDeg > 360) return { ...baseCell, value: null, level: null, flags: ["계산불가_풍향"], scenario };
  if (!finite(weather.tempC) || weather.tempC < -50 || weather.tempC > 60) return { ...baseCell, value: null, level: null, flags: ["계산불가_기온"], scenario };
  if (!finite(weather.rhPercent) || weather.rhPercent < 0 || weather.rhPercent > 100) return { ...baseCell, value: null, level: null, flags: ["계산불가_습도"], scenario };
  if (!finite(fanHalfWidthDeg) || fanHalfWidthDeg < 0 || fanHalfWidthDeg > 180) return { ...baseCell, value: null, level: null, flags: ["계산불가"], scenario, reason: `부채꼴 반폭은 0~180°: ${fanHalfWidthDeg}` };
  if (!finite(fanStepDeg) || fanStepDeg <= 0) return { ...baseCell, value: null, level: null, flags: ["계산불가"], scenario, reason: `부채꼴 간격은 0보다 커야 해요: ${fanStepDeg}` };
  const MAX_FAN_DIRECTIONS = 1000; // plume.js와 같은 안전장치(11/22 외부 검토 지적)
  if (fanHalfWidthDeg > 0 && (2 * fanHalfWidthDeg) / fanStepDeg + 3 > MAX_FAN_DIRECTIONS) {
    return { ...baseCell, value: null, level: null, flags: ["계산불가"], scenario, reason: `부채꼴 방향 수가 너무 많아요(반폭 ${fanHalfWidthDeg}°, 간격 ${fanStepDeg}° → 상한 ${MAX_FAN_DIRECTIONS}개)` };
  }

  // 1단계: 방향과 무관한 판정(시간 겹침·좌표·음원세기·스펙트럼)을 한 번만 해서 "가동 중이고
  // 쓸 수 있는" 음원만 추려요. 거리가 안 바뀌니 이 결과는 어느 풍향으로 돌려도 똑같아요.
  const allFlags = new Set();
  let anyActive = false;
  let excludedCount = 0; // 가동은 했는데 데이터 문제로 합산에서 빠진 음원 수(부분 합계 표시, 외부 검토 지적)
  const usable = [];
  for (const source of stageSources) {
    const { activeMinutes, flags: timeFlags } = stageActiveMinutes(source, hour);
    timeFlags.forEach((f) => allFlags.add(f));
    if (activeMinutes <= 0) {
      // 4차 외부 검토 지적(11/22): "이 공연은 이 시간에 확실히 안 함"(겹침 0분, 플래그 없음)과
      // "이 공연이 이 시간에 했는지 몰라서 뺐음"(시간정보없음·공연시간미확인·시간파싱오류)이
      // 똑같이 조용히 continue돼서 구분이 안 됐어요 — 음량이 큰 공연이 후자라도 작은 공연만
      // 있을 때와 똑같은 등급이 그대로 나왔습니다. 몰라서 뺀 경우만 "일부음원제외"로 셈해요.
      const uncertain = ["공연시간미확인", "공연시간정보없음", "시간파싱오류", "시간역전"];
      if (timeFlags.some((f) => uncertain.includes(f))) excludedCount++;
      continue;
    }
    anyActive = true;

    if (!finite(source.lat) || source.lat < -90 || source.lat > 90 || !finite(source.lon) || source.lon < -180 || source.lon > 180) {
      allFlags.add("음원좌표미확인");
      excludedCount++;
      continue;
    }

    const lwDb = source.indoor
      ? indoorFacadeSourcePowerLevel(source.indoor.lpIndoorDb, source.indoor.R, source.indoor.S)
      : source.lwDb;
    if (typeof lwDb !== "number" || !Number.isFinite(lwDb)) { allFlags.add("음원세기미확인"); excludedCount++; continue; }
    const specBad = validateSpectrum(source.spectrumRatiosDb, CONCAWE_BANDS_HZ);
    if (specBad) { allFlags.add("옥타브스펙트럼필수_모양미확인"); excludedCount++; continue; } // 밴드 누락·빈 객체도 여기서 막힘(외부 검토 지적)

    const weightDb = timeWeightDb(activeMinutes) ?? 0; // ①시간가중: 음원별·밴드별 LW에 미리 더함
    if (activeMinutes < 60) allFlags.add(`시간가중_${Math.round(activeMinutes)}분`);

    usable.push({ source, lwDb, weightDb });
  }

  // 2단계: 부채꼴 방향마다(거리는 그대로, 풍향만 바꿔서) 전체를 다시 계산해 dB(A)가 가장
  // 큰 방향을 찾아요. 음원이 하나도 못 쓰면(usable이 비면) 방향을 돌려도 결과가 안 바뀌니
  // 한 번만(오프셋 0) 계산해요.
  const offsets = [];
  if (fanHalfWidthDeg === 0 || usable.length === 0) offsets.push(0);
  else {
    for (let o = -fanHalfWidthDeg; o < fanHalfWidthDeg - 1e-9; o += fanStepDeg) offsets.push(Math.round(o * 1e9) / 1e9);
    offsets.push(fanHalfWidthDeg);
    if (!offsets.some((o) => Math.abs(o) < 1e-9)) offsets.push(0); // 예보 방향(중심)은 항상 계산
    offsets.sort((a, b) => a - b);
  }

  let best = null; // { value, flags(Set) }
  for (const off of offsets) {
    const vec = (((weather.windVecFromDeg + off) % 360) + 360) % 360;
    const perBandLevels = Object.fromEntries(CONCAWE_BANDS_HZ.map((f) => [f, []]));
    const dirFlags = new Set();
    let anyExcludedThisDir = 0;
    for (const { source, lwDb, weightDb } of usable) {
      const geometry = sourceReceiverGeometry({
        sourceLat: source.lat, sourceLon: source.lon,
        receiverLat: receiver.lat, receiverLon: receiver.lon,
        windVecFromDeg: vec,
      });
      const v = weather.wsd10m * geometry.alignment; // 음원→수음점 쪽 벡터 풍속(+)

      let sourceContributed = false;
      for (const freqHz of CONCAWE_BANDS_HZ) {
        const bandLw = lwDb + source.spectrumRatiosDb[freqHz] + weightDb; // validateSpectrum이 이미 확인함
        const band = calcConcaweBand({
          concaweData, freqHz, lwDb: bandLw, d: geometry.distanceM,
          groundType: source.groundType, dSoftM: source.dSoftM,
          tempC: weather.tempC, rhPercent: weather.rhPercent,
          stability: weather.stability, v, hs: source.hs, hr: source.hr,
        });
        band.flags.forEach((f) => dirFlags.add(f));
        if (band.value !== null && Number.isFinite(band.value)) { // NaN 방어(외부 검토 지적)
          perBandLevels[freqHz].push(band.value);
          sourceContributed = true;
        }
      }
      // 3차 외부 검토 지적(11/22): 음원이 "가동 중"인데도 7밴드 전부 null이면(예: 거리<100m)
      // 제외로 셈해요 — 거리는 방향과 무관하니 이 판정은 모든 방향에서 같아요.
      if (!sourceContributed) anyExcludedThisDir++;
    }

    const bandLevelsDbA = CONCAWE_BANDS_HZ.map((freqHz) => {
      const levels = perBandLevels[freqHz];
      return levels.length === 0 ? null : logSumDb(levels) + A_WEIGHT_DB[freqHz];
    });
    const value = usable.length === 0 ? null : logSumDb(bandLevelsDbA);
    const thisExcludedCount = excludedCount + anyExcludedThisDir;
    if (best === null || (value !== null && (best.value === null || value > best.value))) {
      best = { value, flags: dirFlags, excludedCount: thisExcludedCount };
    }
  }

  if (best.excludedCount > 0) allFlags.add("일부음원제외"); // 전부 합산된 것과 구분 — 몇 개가 빠졌는지는 다른 flags로 알 수 있음
  best.flags.forEach((f) => allFlags.add(f));
  if (!anyActive) return { ...baseCell, value: null, level: null, flags: [...allFlags], scenario };
  if (best.value === null) return { ...baseCell, value: null, level: null, flags: [...allFlags], scenario };
  if (fanHalfWidthDeg > 0) allFlags.add("풍향부채꼴최대");
  return { ...baseCell, value: best.value, level: classifyNoiseLevel(best.value), flags: [...allFlags], scenario };
}

/**
 * 한 시각의 지도 데이터를 만들어요 — 격자 전체에 대해 두 엔진을 돌려 OutputCell[]로
 * 합쳐요(로드맵 M2 11/19 완료 기준). 배출가스는 수음점마다 가동 중인 발전차를 전부
 * 모아 한 번만 계산해요(발전차별로 셀을 따로 안 만듦 — 11/21 바뀐 방식).
 *
 * `noiseScenario`를 **반드시** "concawe"(시민·공단 메인 지도, 로드맵 §2 표 — 수음점당 셀
 * 하나, 동시 음원 전부 합산) 또는 "iso"(공단 비교용 — 음원마다 셀을 따로 만듦)로 명시해야
 * 해요. 11/21엔 concaweData 유무로 조용히 자동 분기했는데, 표를 빠뜨리면 메인 지도가
 * 아무 경고 없이 비교용 엔진으로 바뀌는 문제가 있었어요(외부 검토 지적, 11/22 수정).
 * @param {{ stageSources: any[], generatorSources: any[], weather: any, hour: string,
 *   grid?: {lat:number, lon:number}[], 가정?: string, noiseScenario: "concawe"|"iso", concaweData?: object, 배출시나리오?: "인증"|"비인증" }} p
 * @returns {import("./common.js").OutputCell[]}
 */
export function computeHourOutputCells({ stageSources, generatorSources, weather, hour, grid = generateGridPoints(), 가정 = "기본추정", noiseScenario, concaweData, 배출시나리오 = "인증" }) {
  if (noiseScenario !== "concawe" && noiseScenario !== "iso") {
    throw new Error(`noiseScenario은 "concawe" 또는 "iso" 중 하나를 꼭 넘겨야 해요(받은 값: ${noiseScenario}) — 메인 지도/공단 비교용이 조용히 안 바뀌게 11/22에 필수로 바꿨어요.`);
  }
  if (noiseScenario === "concawe" && !concaweData) {
    throw new Error("noiseScenario이 'concawe'면 concaweData(data/concawe_4_81.json)를 꼭 같이 넘겨야 해요.");
  }
  // 2차 외부 검토 지적(11/22): concaweData가 참(truthy)이기만 하면 통과시켰던 걸, {}같은
  // 빈 객체도 참이라 통과한 뒤 calcConcaweBand 안에서 없는 키를 읽다가 TypeError로 터지는
  // 문제가 있었어요 — 필수 최상위 키가 다 있는지 여기서 미리 확인해요.
  if (noiseScenario === "concawe") {
    const requiredKeys = ["K2_대기흡음_dB_per_km", "K3_지면효과_soft", "K4_기상보정", "K5_높이보정_gamma"];
    const missing = requiredKeys.filter((k) => !(k in concaweData));
    if (missing.length > 0) {
      throw new Error(`concaweData에 필수 키가 없어요(data/concawe_4_81.json 형식이 아닌 것 같아요): ${missing.join(", ")}`);
    }
  }
  const cells = [];
  for (const receiver of grid) {
    if (noiseScenario === "concawe") {
      cells.push(computeNoiseCellConcawe({ stageSources, receiver, weather, hour, concaweData }));
    } else {
      for (const source of stageSources) {
        cells.push(computeNoiseCell({ source, receiver, weather, hour }));
      }
    }
    cells.push(computeExhaustCell({ generators: generatorSources, receiver, weather, hour, 가정, 배출시나리오 }));
  }
  return cells;
}

export { mapDisplayFor, classifyNoiseLevel, classifyExhaustLevel };
