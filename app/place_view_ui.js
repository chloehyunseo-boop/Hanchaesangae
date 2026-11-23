// app/place_view_ui.js — 장소별 보기 화면 (하린 라인, 11/23)
// engine/place_view.js의 buildPlaceTimeline 결과를 표로 그려요. 계산은 안 해요.
// 친구 라인(main.js)은 장소를 눌렀을 때 아래처럼 부르기만 하면 돼요:
//   import { renderPlaceTimeline } from "./place_view_ui.js";
//   renderPlaceTimeline(document.getElementById("place-view"), buildPlaceTimeline({ series, placeName }));
// 색은 main.js의 NOISE_PALETTE·EXHAUST_PALETTE와 같은 값이에요(바꾸면 palettes 인자로 넘기세요).

import { EXHAUST_LAYER_DISCLAIMER } from "../engine/common.js";

export const DEFAULT_PALETTES = {
  noise: { 강: "rgba(198,40,40,0.72)", 중: "rgba(251,140,0,0.62)", 약: "rgba(253,216,53,0.5)", uncertain: "rgba(120,120,120,0.45)" },
  exhaust: { 강: "rgba(106,27,154,0.72)", 중: "rgba(171,71,188,0.6)", 약: "rgba(206,147,216,0.48)", uncertain: "rgba(120,120,120,0.45)" },
};

const STYLE_ID = "place-view-style";
const CSS = `
.pv { font-size: 0.9rem; }
.pv h2 { font-size: 1rem; margin: 4px 0 6px; }
.pv .pv-sum { margin: 2px 0; }
.pv .pv-note { font-size: 0.78rem; color: #555; margin: 6px 0; }
.pv table { border-collapse: collapse; width: 100%; max-width: 420px; }
.pv th, .pv td { padding: 3px 6px; border-bottom: 1px solid #eee; text-align: left; white-space: nowrap; }
.pv .pv-date th { background: #f5f5f5; font-weight: 600; }
.pv .chip { display: inline-block; min-width: 2.2em; padding: 1px 6px; border-radius: 3px; color: #111; }
.pv .chip.unknown { background: repeating-linear-gradient(45deg, #ddd 0 4px, #f4f4f4 4px 8px); color: #333; }
.pv .chip.below { color: #777; }
.pv .chip.none { color: #aaa; }
.pv .pv-close { float: right; }
`;

function ensureStyle(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const st = doc.createElement("style");
  st.id = STYLE_ID;
  st.textContent = CSS;
  doc.head.appendChild(st);
}

function chip(doc, state, palette) {
  const span = doc.createElement("span");
  span.className = `chip ${state.kind}`;
  span.textContent = state.kind === "none" ? "–" : state.text;
  if (state.kind === "level") {
    span.style.background = palette[state.level];
    if (state.atLeast) span.style.outline = "2px dashed rgba(0,0,0,0.45)";
  }
  if (state.kind === "unknown") span.title = "계산하지 못했어요. 안전하다는 뜻은 아니에요.";
  return span;
}

/**
 * @param {HTMLElement} container  비워지고 다시 그려져요
 * @param {ReturnType<import("../engine/place_view.js").buildPlaceTimeline>} timeline
 * @param {{ palettes?: typeof DEFAULT_PALETTES, onClose?: () => void }} [opts]
 */
export function renderPlaceTimeline(container, timeline, opts = {}) {
  const doc = container.ownerDocument;
  ensureStyle(doc);
  const palettes = opts.palettes ?? DEFAULT_PALETTES;
  container.replaceChildren();
  const root = doc.createElement("div");
  root.className = "pv";

  if (opts.onClose) {
    const b = doc.createElement("button");
    b.className = "pv-close";
    b.type = "button";
    b.textContent = "닫기";
    b.addEventListener("click", opts.onClose);
    root.appendChild(b);
  }
  const h = doc.createElement("h2");
  h.textContent = `${timeline.place} — 시간별 예보`;
  root.appendChild(h);
  for (const layer of ["noise", "exhaust"]) {
    const p = doc.createElement("p");
    p.className = "pv-sum";
    p.textContent = timeline.summary[layer].text;
    root.appendChild(p);
  }

  const table = doc.createElement("table");
  const thead = doc.createElement("thead");
  thead.innerHTML = "<tr><th>시각</th><th>소음</th><th>배출가스</th></tr>";
  table.appendChild(thead);
  const tbody = doc.createElement("tbody");
  let lastDate = null;
  for (const r of timeline.rows) {
    if (r.date !== lastDate) {
      const tr = doc.createElement("tr");
      tr.className = "pv-date";
      const th = doc.createElement("th");
      th.colSpan = 3;
      th.textContent = `${Number(r.date.slice(5, 7))}월 ${Number(r.date.slice(8, 10))}일`;
      tr.appendChild(th);
      tbody.appendChild(tr);
      lastDate = r.date;
    }
    const tr = doc.createElement("tr");
    const td0 = doc.createElement("td");
    td0.textContent = `${r.hh}~${r.hh + 1}시`;
    tr.appendChild(td0);
    for (const layer of ["noise", "exhaust"]) {
      const td = doc.createElement("td");
      td.appendChild(chip(doc, r[layer], palettes[layer]));
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  root.appendChild(table);

  const note = doc.createElement("p");
  note.className = "pv-note";
  note.textContent = `'○ 이상'(점선 테두리)은 발전차 바로 옆이라 정확한 값을 모르지만 최소 그 단계라는 뜻이에요. 빗금은 계산하지 못한 시간이에요. '–'는 그 시간에 계산할 공연·발전차가 없다는 뜻이에요. 배출가스: ${EXHAUST_LAYER_DISCLAIMER}.`;
  root.appendChild(note);
  container.appendChild(root);
  return root;
}
