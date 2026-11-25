// validation/events_validation.mjs — 공연 일정 파싱 검증 (친구 라인, 11/25)
// ⚠️ 공단 API(KSCperf)를 실제 호출할 KCISA_SERVICE_KEY가 아직 없어서(결과: HTTP 403 "API Key
// is not valid", 2026-11-25 확인), 여기 쓰는 응답 모양은 CLAUDE.md 5번이 11/19 실제 호출로
// 확인했다는 필드(temporalCoverage·extent)만 사실이고, 나머지(spatial 등 필드 이름·
// response.body.items 경로)는 문화공공데이터광장의 다른 meta/ API들과 같은 공통 틀이라고
// 가정한 거예요 — 실제 키가 생기면 이 가정이 맞는지 꼭 다시 확인해야 해요(engine/events.js
// 하단 "확인할 것" 참고).
import { parseStartTime, parseDurationMinutes, matchSite, parsePerformanceResponse, parseApiResponseText } from "../engine/events.js";

let failCount = 0;
function check(name, condition, detail) {
  const ok = Boolean(condition);
  if (!ok) failCount++;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}

// 시작 시각 파싱 — CLAUDE.md 5번이 실제로 본 깨끗한 형식과 지저분한 형식 둘 다.
check("깨끗한 형식 19:00", parseStartTime("19:00") === "19:00");
check("한 자리 시 9:30 → 09:30", parseStartTime("9:30") === "09:30");
check("오후4시 → 16:00", parseStartTime("오후4시") === "16:00");
check("오전 9시 30분 → 09:30", parseStartTime("오전 9시 30분") === "09:30");
check("오후12시 → 12:00(정오)", parseStartTime("오후12시") === "12:00");
check("오전12시 → 00:00(자정)", parseStartTime("오전12시") === "00:00");
check("지저분한 실제 사례(CLAUDE.md 5번): '2015년 4월5일(일) 오후4시' → 16:00", parseStartTime("2015년 4월5일(일) 오후4시") === "16:00");
check("못 읽는 값 → null(지어내지 않음)", parseStartTime("미정") === null);
check("빈 문자열 → null", parseStartTime("") === null);
check("null 입력 → null", parseStartTime(null) === null);

// 소요시간 파싱
check("120분 → 120", parseDurationMinutes("120분") === 120);
check("2시간 → 120", parseDurationMinutes("2시간") === 120);
check("2시간 30분 → 150", parseDurationMinutes("2시간 30분") === 150);
check("숫자만(단위 없음) → 그대로 분", parseDurationMinutes("90") === 90);
check("못 읽는 값 → null", parseDurationMinutes("미정") === null);
check("0분 → null(0은 소요시간 없다는 뜻과 구분 안 되니 모름으로)", parseDurationMinutes("0분") === null);

// 장소 매칭 — 애매한 곳(평화의광장 무대 A/B)은 추측하지 않고 확인 필요 플래그만.
check("KSPO DOME 매칭", matchSite("올림픽공원 KSPO DOME").site === "KSPO DOME");
check("핸드볼경기장 키워드 매칭", matchSite("SK올림픽핸드볼경기장").site === "티켓링크 라이브 아레나(SK올림픽핸드볼경기장)");
check("평화의광장은 무대 A/B 선택이 필요해서 site:null + 플래그", matchSite("평화의광장").site === null && matchSite("평화의광장").flags.includes("무대선택필요_평화의광장"));
check("모르는 장소 → site:null + 장소미확인", matchSite("어딘지모를곳").site === null && matchSite("어딘지모를곳").flags.includes("장소미확인"));
check("장소 텍스트가 없음(null) → 장소미확인", matchSite(null).flags.includes("장소미확인"));

// 응답 전체 파싱(가정한 모양의 모의 응답 — 위 경고 참고)
{
  const mockRaw = {
    response: {
      body: {
        items: {
          item: [
            { title: "모의 공연 A", spatial: "KSPO DOME", temporalCoverage: "19:00", extent: "120분" },
            { title: "모의 공연 B(지저분한 시각)", spatial: "SK올림픽핸드볼경기장", temporalCoverage: "오후7시", extent: "" },
            { title: "모의 공연 C(장소 모름)", spatial: "알수없는장소", temporalCoverage: "", extent: "90분" },
          ],
        },
      },
    },
  };
  const parsed = parsePerformanceResponse(mockRaw);
  check("3건 전부 파싱됨", parsed.length === 3);
  check("A: 장소·시각·소요시간 전부 정상", parsed[0].site === "KSPO DOME" && parsed[0].시작 === "19:00" && parsed[0].소요분 === 120 && parsed[0].flags.length === 0);
  check("B: 시각은 읽었지만(오후7시→19:00) 소요시간 없음 → 시작시각없음 플래그 안 붙고 소요시간 관련은 없음(정상)", parsed[1].시작 === "19:00" && parsed[1].소요분 === null);
  check("C: 장소 모름 + 시작시각없음 플래그", parsed[2].site === null && parsed[2].flags.includes("장소미확인") && parsed[2].flags.includes("시작시각없음"));
}

// 응답이 아예 다른 모양이어도(배열이 바로 top-level items인 경우 등) 깨지지 않는지
{
  const altRaw = { items: [{ title: "다른 모양", spatial: "장미광장", temporalCoverage: "20:00", extent: "60분" }] };
  const parsed = parsePerformanceResponse(altRaw);
  check("다른 응답 모양(items 바로)도 파싱됨", parsed.length === 1 && parsed[0].site === "장미광장");
}
{
  const emptyRaw = {};
  check("빈 응답 → 빈 배열(에러 안 던짐)", parsePerformanceResponse(emptyRaw).length === 0);
}

// 11/25 실제 키로 호출해 확인: type=json을 줘도 XML이 와요 — JSON 파서가 "Unexpected
// token '<'"로 깨지던 것(실제 실패기록으로 재현)을 고쳤어요. XML도 읽을 수 있는지 확인.
{
  const xml = `<response><header><resultCode>00</resultCode><resultMsg>NORMAL SERVICE</resultMsg></header><body><items><item><title>모의 공연 XML</title><spatial>KSPO DOME</spatial><temporalCoverage>19:00</temporalCoverage><extent>120분</extent></item><item><title>CDATA &amp; 특수문자 테스트</title><spatial><![CDATA[장미광장]]></spatial><temporalCoverage>오후4시</temporalCoverage><extent></extent></item></items></body></response>`;
  const parsed = parseApiResponseText(xml);
  check("XML 응답도 파싱됨(에러 안 던짐)", parsed.ok === true);
  const items = parsed.ok ? parsed.body.response.body.items.item : [];
  check("XML에서 2건 추출", items.length === 2);
  check("XML 필드값 그대로 읽힘", items[0]?.title === "모의 공연 XML" && items[0]?.spatial === "KSPO DOME" && items[0]?.extent === "120분");
  check("CDATA·& 이스케이프 풀림", items[1]?.title === "CDATA & 특수문자 테스트" && items[1]?.spatial === "장미광장");
  // parsePerformanceResponse까지 그대로 이어지는지(실제 fetchPerformances가 쓰는 경로)
  const records = parsePerformanceResponse(parsed.body);
  check("XML → parsePerformanceResponse까지 끝까지 연결됨", records.length === 2 && records[0].site === "KSPO DOME" && records[0].시작 === "19:00");
}
{
  const errorXml = `<response><header><resultCode>30</resultCode><resultMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</resultMsg></header></response>`;
  const parsed = parseApiResponseText(errorXml);
  check("XML 에러 응답(resultCode≠00)은 실패로 처리", parsed.ok === false && parsed.사유.includes("SERVICE_KEY_IS_NOT_REGISTERED_ERROR"));
}
{
  const garbage = "이것도 저것도 아님";
  const parsed = parseApiResponseText(garbage);
  check("JSON도 XML도 아니면 실패로 처리(지어내지 않음)", parsed.ok === false);
}

console.log(failCount === 0 ? "\n전체 통과 (실패 0)" : `\n실패 ${failCount}건`);
process.exitCode = failCount === 0 ? 0 : 1;
