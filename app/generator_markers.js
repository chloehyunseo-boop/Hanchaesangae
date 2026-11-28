// app/generator_markers.js — 지도에 발전차 위치 표시(하린 11/28 회의 결정). 계산은 안 해요.
// 그 시각 가동 중(또는 가동 시간을 모르는) 발전차를 위치별로 묶어 작은 표식 + 대수로 보여줘요.
// 표식에 마우스를 올리면 대수·위치의 근거(공단 확인값/가정)를 알려줘요.

const COUNT_BASIS = { 공단확인값: "대수: 공단 확인값", 확인된최소: "대수: 최소 1대 가정" };
const POS_BASIS = { 공단회신: "위치: 공단 회신", 공연장좌표: "위치: 공연장 위치로 가정" };

export function createGeneratorMarkers(map, activityAtHour) {
  const group = L.layerGroup().addTo(map);
  let visible = true;
  return {
    update(gens, hourIso) {
      group.clearLayers();
      const byPos = new Map();
      for (const g of gens ?? []) {
        const st = activityAtHour(g, hourIso);
        if (st !== "active" && st !== "unknown") continue;
        const k = `${g.lat.toFixed(6)},${g.lon.toFixed(6)}`;
        const e = byPos.get(k) ?? { lat: g.lat, lon: g.lon, site: g.site, n: 0, unknown: false, g };
        e.n++;
        if (st === "unknown") e.unknown = true;
        byPos.set(k, e);
      }
      for (const e of byPos.values()) {
        const icon = L.divIcon({
          className: "gen-pin-wrap",
          html: `<span class="gen-pin${e.unknown ? " unk" : ""}">${e.n}</span>`,
          iconSize: [20, 20], iconAnchor: [10, 10],
        });
        const basis = e.g.공단입력 ? "공단 입력" : [COUNT_BASIS[e.g.대수근거], POS_BASIS[e.g.위치출처]].filter(Boolean).join(" · ");
        const tip = `${e.site ?? "발전차"} 발전차 ${e.n}대${e.unknown ? " (가동 시간 미확인)" : ""}${basis ? `<br><small>${basis}</small>` : ""}`;
        L.marker([e.lat, e.lon], { icon, keyboard: false }).bindTooltip(tip, { direction: "top", offset: [0, -10] }).addTo(group);
      }
      if (!visible) map.removeLayer(group);
    },
    setVisible(v) {
      visible = v;
      if (v) group.addTo(map); else map.removeLayer(group);
    },
  };
}
