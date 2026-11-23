# 올팍 바람지도

한국체육산업개발(주) 공공데이터 활용 경진대회 출품작. 기상청 예보와 공연 일정으로
올림픽공원의 공연 소음과 발전차 배출가스가 몇 시에 어디로 퍼질지 예보하는
웹앱이에요. 자세한 계획은 Claude Docs 로드맵과 `CLAUDE.md`를 보세요.

## 코딩을 몰라도 실행하는 법

지금은 지도·슬라이더 데모(M3, 11/22~)가 들어가 있어요. GitHub Pages 배포 전에
내 컴퓨터에서 미리 보려면, 터미널에서 이 폴더로 이동한 뒤:

```
python3 scripts/dev-server.py
```

그다음 브라우저에서 `http://localhost:8787`을 열면 돼요(파일을 더블클릭해서
직접 여는 건 안 돼요 — 데이터를 불러오는 방식 때문에 꼭 서버로 열어야 해요).
**`python3 -m http.server`를 바로 쓰지 마세요** — 캐시 헤더를 안 보내서 코드를
고쳐도 브라우저가 예전 버전을 계속 보여주는 문제가 있어요(2026-11-22 확인,
`scripts/dev-server.py`가 이 문제를 고친 버전이에요).
정식 배포(GitHub Pages) 링크는 M3 완료 시 이 자리에 추가해요.

## 폴더 구조

- `index.html` — 시민 화면
- `agency.html` — 공단 화면
- `app/` — 화면 쪽 코드(지도·슬라이더·데모 컨트롤). `main.js`가 화면을 그리고,
  `grid-worker.js`는 격자 전체 계산을 Web Worker에서 돌려요(엔진 코드 자체는
  `engine/`에 그대로 두고 그걸 부르기만 해요).
- `engine/` — 계산 코드 (common.js 공통 규격, noise.js 소음, plume.js 배출가스, weather.js 예보 파싱)
- `data/` — 좌표·가정값·갱신되는 날씨/공연 데이터 (site.geojson: 공연장·무대·주거지 좌표)
- `docs/` — 가정값·근거를 정리한 상세 문서 (발전차 배출가스, 공원 좌표, 민원 정리)
- `validation/` — 검증 스크립트
- `.github/workflows/` — 매시 자동 갱신 (`scripts/update-weather.mjs` 실행)
- `scripts/` — 데이터 갱신 스크립트 (Node, GitHub Actions에서만 실행)
- `decisions.md` — 작업마다 남기는 3줄 결정 기록 (기획서 '모델 설계'의 원재료)
