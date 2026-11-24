"""data/raw의 공단 강좌정보 CSV 2개 → data/lessons.json (하린 라인, 11/24)
실행: python3 scripts/build_lessons.py
- 올림픽수영장 강좌정보(공공데이터포털 15101610): 전부 '올림픽수영장' 위치로 봐요(파일에 장소 열이 없음 — 가정).
  이 파일은 열이 한 칸 밀려 있어요: '시작일자' 칸에 "시작~끝" 기간, '종료일자' 칸에 시작일이 들어 있어요.
- 스포츠센터 강좌정보(20260601): '테니스'만 써요 → '올림픽공원 테니스경기장' 위치로 봐요(가정). 다른 종목은 장소를 몰라서 뺌.
- 이미 끝난 강좌는 빼요(실행한 날 기준) — 강좌정보가 갱신되면 다시 실행하세요.
- 하루 3시간 이상(예: 06:00-21:50)은 강습이 아니라 이용권으로 보고 뺌.
- 같은 강좌명·시간·요일은 한 줄로 합쳐요(1:1 테니스가 슬롯마다 여러 줄).
"""
import csv, json, re, collections, pathlib, datetime
R = pathlib.Path(__file__).resolve().parent.parent
DAYS = {"일": 0, "월": 1, "화": 2, "수": 3, "목": 4, "금": 5, "토": 6}
dropped = collections.Counter()

def parse_time(s):
    m = re.match(r"\s*(\d{1,2}):(\d{2})\s*[~-]\s*(\d{1,2}):(\d{2})", s or "")
    if not m: return None
    a, b = f"{int(m[1]):02d}:{m[2]}", f"{int(m[3]):02d}:{m[4]}"
    mins = (int(m[3]) * 60 + int(m[4])) - (int(m[1]) * 60 + int(m[2]))
    return (a, b, mins)

def parse_days(s):
    # "(토)"처럼 괄호 친 요일도 넣어요(뜻 미확인 — 넓게 잡음)
    return sorted({DAYS[c] for c in re.sub(r"[()\s]", "", s or "").split(",") if c in DAYS})

out = {}
def add(name, kind, site, time, days, start, end, source):
    t = parse_time(time)
    if not t: dropped["시간형식"] += 1; return
    if t[2] <= 0 or t[2] >= 180: dropped["3시간이상_이용권추정"] += 1; return
    d = parse_days(days)
    if not d: dropped["요일없음"] += 1; return
    key = (name.strip(), t[0], t[1], tuple(d), start, end)
    out.setdefault(key, {"name": name.strip(), "종목": kind, "site": site, "요일": d, "시작": t[0], "끝": t[1],
                         "기간시작": start, "기간끝": end, "출처": source})

for r in csv.DictReader(open(R / "data/raw/올림픽수영장_강좌정보_20250519.csv", encoding="utf-8")):
    a, _, b = r["시작일자"].partition("~")
    add(r["강좌명"], r["강좌코드명"], "올림픽수영장", r["시작종료시간"], r["요일"], a, b, "올림픽수영장 강좌정보")
for r in csv.DictReader(open(R / "data/raw/스포츠센터_강좌정보_20260601.csv", encoding="utf-8")):
    if r["종목"] != "테니스": dropped["테니스아님_장소모름"] += 1; continue
    add(r["강좌명"], "테니스", "올림픽공원 테니스경기장", r["수강시간"], r["수강요일"], r["수강시작일"], r["수강종료일"], "스포츠센터 강좌정보(20260601)")

TODAY = datetime.date.today().isoformat()
# 이미 끝난 강좌(기간끝이 오늘 전)는 빼요 — 지도는 오늘부터 3일만 보여줘요
for k in [k for k, v in out.items() if v["기간끝"] < TODAY]: del out[k]; dropped["이미끝난강좌"] += 1
lessons = sorted(out.values(), key=lambda x: (x["site"], x["기간시작"], x["시작"], x["name"]))
doc = {
    "_설명": "영향 강습 목록용 강좌 시간표. scripts/build_lessons.py가 data/raw의 공단 CSV로 만들어요. 손으로 고치지 마세요.",
    "_가정": ["장소 열이 없어 수영장 파일 전체=올림픽수영장, 테니스=올림픽공원 테니스경기장으로 봄",
             "3시간 이상 시간대는 이용권으로 보고 뺌", "'(토)'처럼 괄호 친 요일도 포함(뜻 미확인)",
             "기간끝 9999-12-31 = 종료일 없음(계속 운영). 화면은 기간시작~기간끝 안의 날짜만 써야 해요"],
    "_뺀_줄": dict(dropped),
    "강좌": lessons,
}
json.dump(doc, open(R / "data/lessons.json", "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
cur = [l for l in lessons if l["기간시작"] <= "2026-11-24" <= l["기간끝"]]
print(len(lessons), "강좌 /", len(cur), "개가 11/24에 운영 중", collections.Counter(l["site"] for l in cur), dict(dropped))
