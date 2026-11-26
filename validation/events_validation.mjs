// validation/events_validation.mjs — 공연 일정 파싱 검증 (친구 라인, 11/25)
// ⚠️ 공단 API(KSCperf)를 실제 호출할 KCISA_SERVICE_KEY가 아직 없어서(결과: HTTP 403 "API Key
// is not valid", 2026-11-25 확인), 여기 쓰는 응답 모양은 CLAUDE.md 5번이 11/19 실제 호출로
// 확인했다는 필드(temporalCoverage·extent)만 사실이고, 나머지(spatial 등 필드 이름·
// response.body.items 경로)는 문화공공데이터광장의 다른 meta/ API들과 같은 공통 틀이라고
// 가정한 거예요 — 실제 키가 생기면 이 가정이 맞는지 꼭 다시 확인해야 해요(engine/events.js
// 하단 "확인할 것" 참고).
import { parseStartTime, parseDurationMinutes, matchSite, parsePerformanceResponse, parseApiResponseText, parseEventDate, parseDateRange, parseUpcomingScheduleHtml, parseDailyStartTimes } from "../engine/events.js";

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
  check("A: 장소·시각·소요시간 전부 정상(날짜 정보는 없어서 날짜미확인 플래그만 붙음)", parsed[0].site === "KSPO DOME" && parsed[0].시작 === "19:00" && parsed[0].소요분 === 120 && parsed[0].flags.length === 1 && parsed[0].flags[0] === "날짜미확인");
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
// 11/25 실제 재현된 버그: resultCode가 "00"이 아니어도 resultMsg가 "OK"면 진짜 성공이에요
// (그 시각 공연이 0건일 뿐). "00"만 성공으로 치던 첫 수정이 이걸 오류로 잘못 판정했었어요.
{
  const okButNonZeroCode = `<response><header><resultCode>200</resultCode><resultMsg>OK</resultMsg></header><body><items></items></body></response>`;
  const parsed = parseApiResponseText(okButNonZeroCode);
  check("resultCode≠00이어도 resultMsg가 'OK'면 성공(0건)으로 처리", parsed.ok === true && parsed.body.response.body.items.item.length === 0);
}
{
  const garbage = "이것도 저것도 아님";
  const parsed = parseApiResponseText(garbage);
  check("JSON도 XML도 아니면 실패로 처리(지어내지 않음)", parsed.ok === false);
}

// 날짜 파싱 — 11/25 실제 응답 확인: 날짜 전용 필드가 없어서 temporalCoverage나 description
// 문장 속에서 찾아야 해요.
check("YYYY-MM-DD", parseEventDate("2026-11-25") === "2026-11-25");
check("YYYY.MM.DD", parseEventDate("2026.11.5") === "2026-11-05");
check("한글 날짜(2026년 11월 25일)", parseEventDate("2026년 11월 25일") === "2026-11-25");
check("문장 속에 섞여 있어도 찾음", parseEventDate("2026년 11월 25일(수) 19:00 공연") === "2026-11-25");
check("못 찾으면 null(지어내지 않음)", parseEventDate("날짜 미정") === null);
check("null 입력 → null", parseEventDate(null) === null);

// 실제 재현된 사례(11/25, 100건 응답 중 하나): temporalCoverage가 시각만이면 날짜는 못
// 찾고 '날짜미확인' 플래그가 붙어야 해요(지어내지 않음).
{
  const realShapeRaw = {
    response: { body: { items: { item: [
      { title: "TOP FC8 : 하트오브어 챔피언", spatial: "올림픽홀", temporalCoverage: "17:00", extent: "270분", description: "" },
    ] } } },
  };
  const parsed = parsePerformanceResponse(realShapeRaw);
  check("날짜 정보가 전혀 없으면 날짜:null + 날짜미확인 플래그", parsed[0].날짜 === null && parsed[0].flags.includes("날짜미확인"));
  check("그래도 시작시각·소요시간·장소는 정상 추출", parsed[0].시작 === "17:00" && parsed[0].소요분 === 270 && parsed[0].site === "올림픽홀");
}

// 날짜 범위 파싱(일정안내 페이지의 "YYYY-MM-DD ~ YYYY-MM-DD")
check("날짜 범위 파싱", JSON.stringify(parseDateRange("2026-11-28 ~ 2027-01-03")) === JSON.stringify({ 기간시작: "2026-11-28", 기간끝: "2027-01-03" }));
check("하루짜리는 시작=끝", JSON.stringify(parseDateRange("2026-11-27")) === JSON.stringify({ 기간시작: "2026-11-27", 기간끝: "2026-11-27" }));
check("못 읽으면 둘 다 null", JSON.stringify(parseDateRange("미정")) === JSON.stringify({ 기간시작: null, 기간끝: null }));

// 일정안내 페이지 스크래핑 — 11/25 실제 페이지 구조로 만든 모의 HTML. <head>의 <script>
// 안에 똑같은 HTML 조각(AJAX 템플릿 문자열)이 들어있는 것까지 재현해요 — 처음엔 이것
//때문에 전체 페이지에서 찾으면 스크립트 템플릿까지 걸려서 "place"가 수만 자짜리 엉뚱한
// 값으로 깨지는 버그가 있었어요(실제로 겪음) — "rowSpace" 섹션 안에서만 찾게 고쳐서
// 이 테스트로 고정해요.
{
  const mockHtml = `<!DOCTYPE html><html><head>
<script>
function f(){
  var htmls = '';
  $.each(result[0], function (index,item){
    htmls += '<div class="col-sm-6">';
    htmls += '    <a href="x" class="item">';
    htmls += '        <div class="info">';
    htmls += '            <em class="place">'+item.plc+'</em>';
    htmls += '            <strong class="title">'+item.title+'</strong>';
    htmls += '            <span class="date">'+item.beginDt+'~'+item.endDt+'</span>';
    htmls += '            <small class="time" >'+item.tm+'</small>';
    htmls += '        </div>';
    htmls += '    </a>';
    htmls += '</div>';
  });
}
</script>
</head><body>
<div class="schedule_list thumb">
  <div class="row" id="rowSpace">
    <div class="col-sm-6">
      <a href="/view?evtSeq=1" class="item">
        <div class="info">
          <em class="place">KSPO DOME</em>
          <strong class="title">모의 콘서트</strong>
          <!-- <span class="date" th:text="|가짜|"></span> -->
          <span class="date">2026-11-27 ~ 2026-11-29</span>
          <small class="time">2026년 11월 27일(금) 오후 7시</small>
        </div>
      </a>
    </div>
    <div class="col-sm-6">
      <a href="/view?evtSeq=2" class="item">
        <div class="info">
          <em class="place">모르는장소</em>
          <strong class="title">장소 미확인 공연</strong>
          <span class="date">2026-12-01</span>
          <small class="time">저녁</small>
        </div>
      </a>
    </div>
  </div>
  <div class="last">
    <div class="box"><p>지난 공연은 아래에서 확인하실 수 있습니다.</p></div>
    <div class="schedule_list thumb last">
      <div class="row" id="rowSpacePass">
        <div class="col-sm-6">
          <a href="/view?evtSeq=999" class="item">
            <div class="info">
              <em class="place">KSPO DOME</em>
              <strong class="title">지난 공연(안 들어가야 함)</strong>
              <span class="date">2020-01-01</span>
              <small class="time">과거</small>
            </div>
          </a>
        </div>
      </div>
    </div>
  </div>
</div>
</body></html>`;
  const events = parseUpcomingScheduleHtml(mockHtml);
  check("스크립트 템플릿은 안 걸리고 실제 항목 2건만 파싱됨", events.length === 2);
  check("첫 항목: 장소·날짜·시간 정상(place 값이 스크립트 내용으로 안 깨짐)", events[0]?.site === "KSPO DOME" && events[0]?.기간시작 === "2026-11-27" && events[0]?.기간끝 === "2026-11-29" && events[0]?.원본시간텍스트.includes("오후 7시"));
  check("둘째 항목: 모르는 장소는 추측 안 하고 장소미확인", events[1]?.site === null && events[1]?.flags.includes("장소미확인"));
  check("'지난 공연'(class=last) 구간은 안 읽음", !events.some((e) => e.title.includes("지난 공연")));
  check("모든 항목 출처가 '공단일정페이지'", events.every((e) => e.출처 === "공단일정페이지"));
}

{
  // 11/26 "공연 일정 → 지도 연결" 1단계 — 실제 KSPO DOME 조용필 콘서트(11/27~29) 원문으로 검증.
  const real = "2026년 11월 27일(금) 오후 7시 2026년 11월 28일(토) 오후 6시 2026년 11월 29일(일) 오후 5시";
  const times = parseDailyStartTimes(real);
  check("조용필 콘서트 3일치 시작시각 전부 뽑힘", Object.keys(times).length === 3, JSON.stringify(times));
  check("11/27(금) 오후 7시 → 19:00", times["2026-11-27"] === "19:00", times["2026-11-27"]);
  check("11/28(토) 오후 6시 → 18:00", times["2026-11-28"] === "18:00", times["2026-11-28"]);
  check("11/29(일) 오후 5시 → 17:00", times["2026-11-29"] === "17:00", times["2026-11-29"]);
  check("오전 12시(자정) → 00:00", parseDailyStartTimes("2026년 1월 1일 오전 12시")["2026-01-01"] === "00:00");
  check("오후 12시(정오) → 12:00", parseDailyStartTimes("2026년 1월 1일 오후 12시")["2026-01-01"] === "12:00");
  check("날짜 없이 요일만 있는 표현(예: 수목금 19시 30분)은 지어내지 않고 빈 결과", Object.keys(parseDailyStartTimes("수목금 19시 30분 / 토 15시, 19시")).length === 0);
  check("null/undefined 입력도 안 터지고 빈 객체", Object.keys(parseDailyStartTimes(null)).length === 0 && Object.keys(parseDailyStartTimes(undefined)).length === 0);
}

console.log(failCount === 0 ? "\n전체 통과 (실패 0)" : `\n실패 ${failCount}건`);
process.exitCode = failCount === 0 ? 0 : 1;
