// app/events_notice.js — 공연 일정 자동 수집이 멈추거나 실패했을 때 화면에 알려요 (11/28 최종 점검, 하린 결정).
// 수집이 안 되는 걸 '공연 없음'으로 오해하지 않게, 갱신 멈춤 띠(setupWeatherFreshness)와 같은 방식으로 띄워요.
// 화면 문구는 개조식. 새 파일이라 캐시 때문에 옛 shared.js와 섞여 깨질 일이 없어요(import에 ?v= 사용).

const STALE_AFTER_MS = 3 * 3600 * 1000; // 날씨 띠와 같은 기준

function fmtKst(iso) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.month}/${p.day} ${p.hour === "24" ? "00" : p.hour}:${p.minute}`;
}

/** 앞으로 있을 공연('공단일정페이지')을 하나도 못 받은 채 실패 기록만 있는 상태인지 */
export function eventsCollectionFailed(events) {
  const upcoming = (events?.공연 ?? []).filter((e) => e.출처 === "공단일정페이지");
  return upcoming.length === 0 && (events?.실패기록 ?? []).length > 0;
}

/** 공연 목록이 비었을 때 보여줄 문구 — 수집 실패면 '공연 없음'이라고 하지 않아요. */
export function eventsEmptyMessage(events) {
  return eventsCollectionFailed(events) ? "공연 일정 수집 실패. 공연이 없다는 뜻은 아님" : "앞으로 2주 공연 없음";
}

/** 헤더 아래에 띠를 띄워요. 문제가 없으면 아무것도 안 해요. */
export function setupEventsNotice(events) {
  const lastOk = events?.일정마지막성공시각 ?? events?.저장시각 ?? null;
  const lastOkMs = Date.parse(lastOk);
  let text = null;
  if (eventsCollectionFailed(events)) {
    text = "공연 일정을 받지 못함. 지도의 공연 소음·발전차 표시가 빠졌을 수 있음. 공연이 없다는 뜻은 아님";
  } else if (Number.isFinite(lastOkMs) && Date.now() - lastOkMs > STALE_AFTER_MS) {
    text = `공연 일정이 ${fmtKst(lastOk)} 이후 갱신되지 않음. 이후 추가·변경된 공연은 반영되지 않았을 수 있음`;
  }
  if (!text) return;
  const header = document.querySelector("header.top");
  const bar = document.createElement("div");
  bar.className = "stale-banner events-banner";
  bar.setAttribute("role", "status");
  bar.style.cssText = "background:#FFF3DC;border-bottom:1px solid #F0B45A;color:#6B4300;font-size:13.5px;font-weight:600;padding:9px 20px;text-align:center;line-height:1.45";
  bar.textContent = text;
  header?.insertAdjacentElement("afterend", bar);
}
