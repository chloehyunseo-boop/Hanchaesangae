// app/day_slider.js — 휴대폰에서 시간 막대를 "하루씩" 보기 (하린 11/28 결정, 2안).
// 폭이 좁은 화면(640px 이하)에서는 72시간을 한 막대에 다 넣으면 한 시간이 4~5px라 손잡이(18px)보다
// 좁아 조작이 어려워요. 막대 위에 [오늘][내일][모레]… 날짜 버튼을 두고, 막대에는 고른 날의 시간만
// 보여줘요(한 시간 ≈ 15px). 막대 값(slider.value)은 지금처럼 "지금부터 몇 시간 뒤"(0~71)라서
// 지도 계산·캐시 코드는 그대로예요 — 바뀌는 건 막대의 min·max와 눈금, 색 칸 표시뿐이에요.
// 넓은 화면(컴퓨터)에서는 아무것도 안 바꿔요(72시간 전체).

const MOBILE_QUERY = "(max-width: 640px)";

export function setupDaySlider({ slider, bandEl, ticksEl, numHours, hourSlotDate, kstParts }) {
  const mq = window.matchMedia(MOBILE_QUERY);
  const ymd = (d) => { const { y, m, d: dd } = kstParts(d); return `${y}-${m}-${dd}`; };
  // 날짜별 offset 범위
  const days = [];
  for (let o = 0; o < numHours; o++) {
    const day = ymd(hourSlotDate(o));
    const last = days[days.length - 1];
    if (last && last.day === day) last.max = o;
    else days.push({ day, min: o, max: o });
  }
  // 11/29 하린: 휴대폰은 3일치(오늘·내일·모레)만. 넷째 날 새벽 몇 시간은 휴대폰에서 안 보여요.
  days.splice(3);
  const names = ["오늘", "내일", "모레"];
  const wk = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", weekday: "short" });
  days.forEach((d, i) => {
    const [, m, dd] = d.day.split("-");
    d.label = `${names[i] ?? `${Number(m)}/${Number(dd)}`}`;
    d.sub = `${Number(m)}/${Number(dd)}(${wk.format(new Date(`${d.day}T12:00:00+09:00`))})`;
  });

  const chips = document.createElement("div");
  chips.className = "day-chips";
  chips.setAttribute("role", "tablist");
  chips.setAttribute("aria-label", "날짜");
  // 11/29 하린: 큰 날짜 알약 대신 "오늘 · 내일 · 모레" 작은 글자 탭을 예측 시각 줄 오른쪽 끝에 둬요.
  chips.innerHTML = days.map((d, i) => `<button type="button" role="tab" data-i="${i}" title="${d.sub}">${d.label}</button>`).join("");
  const box = slider.closest(".time-box");
  const head = box?.querySelector(".tb-head");
  if (head) head.appendChild(chips); else slider.parentElement.insertAdjacentElement("beforebegin", chips);
  // 11/29 하린: 막대 색 설명(#band-note)은 휴대폰에서 눈금 아래로 내려요(넓은 화면은 제자리).
  const bandNote = box?.querySelector("#band-note");
  const noteHome = bandNote ? { parent: bandNote.parentElement, next: bandNote.nextSibling } : null;
  const ticksAnchor = box?.querySelector(".ticks");
  const placeNote = () => {
    if (!bandNote || !ticksAnchor) return;
    if (mq.matches) ticksAnchor.insertAdjacentElement("afterend", bandNote);
    else noteHome.parent.insertBefore(bandNote, noteHome.next && noteHome.next.parentElement === noteHome.parent ? noteHome.next : null);
  };
  const desktopTicks = ticksEl ? ticksEl.innerHTML : "";
  let cur = 0;

  const dayOf = (o) => { const i = days.findIndex((d) => o >= d.min && o <= d.max); return i >= 0 ? i : (o > days[days.length - 1].max ? days.length - 1 : 0); };
  const applyBand = () => {
    if (!bandEl) return;
    const on = mq.matches;
    [...bandEl.children].forEach((el, i) => { el.style.display = !on || (i >= days[cur].min && i <= days[cur].max) ? "" : "none"; });
  };
  const applyTicks = () => {
    if (!ticksEl) return;
    if (!mq.matches) { ticksEl.innerHTML = desktopTicks; return; }
    const { min, max } = days[cur];
    const span = Math.max(1, max - min);
    const marks = [];
    for (let o = min; o <= max; o++) {
      const h = Number(kstParts(hourSlotDate(o)).h);
      const first = o === min;
      if (first || h % 6 === 0) {
        if (!first && marks.length && (o - marks[marks.length - 1][0]) < 3) continue; // 겹침 방지
        marks.push([o, first && cur === 0 ? "지금" : `${h}시`]);
      }
    }
    ticksEl.innerHTML = marks.map(([o, t]) => `<span style="left:${((o - min) / span) * 100}%;${o === min ? "" : "transform:translateX(-50%)"}">${t}</span>`).join("");
  };
  const paintChips = () => {
    chips.style.display = mq.matches ? "" : "none";
    [...chips.children].forEach((b, i) => { b.classList.toggle("on", i === cur); b.setAttribute("aria-selected", i === cur ? "true" : "false"); });
  };
  const applyRange = () => {
    const v = Number(slider.value) || 0;
    if (mq.matches) { slider.min = String(days[cur].min); slider.max = String(days[cur].max); }
    else { slider.min = "0"; slider.max = String(numHours - 1); }
    slider.value = String(v); // 범위 안이면 그대로, 밖이면 브라우저가 끝값으로 맞춤
    paintChips(); applyBand(); applyTicks(); placeNote();
  };
  /** 다른 코드(공연 일정 '지도에서 보기' 등)가 시각을 옮길 때 — 그날로 먼저 바꾼 뒤 값을 넣어요. */
  const setOffset = (o) => {
    cur = dayOf(o);
    applyRange();
    slider.value = String(o);
    slider.dispatchEvent(new Event("input"));
    slider.dispatchEvent(new Event("change"));
  };
  chips.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-i]");
    if (!b) return;
    const i = Number(b.dataset.i);
    if (!days[i]) return;
    if (i === cur) return;
    // 같은 '시'가 그날에 있으면 그 시로, 없으면 그날 첫 시간으로
    const h = kstParts(hourSlotDate(Number(slider.value) || 0)).h;
    let target = days[i].min;
    for (let o = days[i].min; o <= days[i].max; o++) if (kstParts(hourSlotDate(o)).h === h) { target = o; break; }
    setOffset(target);
  });
  if (bandEl) new MutationObserver(applyBand).observe(bandEl, { childList: true });
  mq.addEventListener?.("change", () => { cur = dayOf(Number(slider.value) || 0); applyRange(); });
  cur = dayOf(Number(slider.value) || 0);
  applyRange();
  return { setOffset };
}
