# 올팍 바람지도

한국체육산업개발(주) 공공데이터 활용 경진대회 출품작. 기상청 예보와 공연 일정으로
올림픽공원의 공연 소음과 발전차 배출가스가 몇 시에 어디로 퍼질지 예보하는
웹앱이에요. 자세한 계획은 Claude Docs 로드맵과 `CLAUDE.md`를 보세요.

## 코딩을 몰라도 실행하는 법

지금은 뼈대만 있어서 실행할 게 없어요. M3(11/25)에 배포되면 이 자리에
"브라우저에서 이 링크를 열어 보세요"가 들어가요.

## 폴더 구조

- `index.html` — 시민 화면
- `agency.html` — 공단 화면
- `engine/` — 계산 코드 (common.js 공통 규격, noise.js 소음, plume.js 배출가스, weather.js 예보 파싱)
- `data/` — 좌표·가정값·갱신되는 날씨/공연 데이터
- `validation/` — 검증 스크립트
- `.github/workflows/` — 매시 자동 갱신 (`scripts/update-weather.mjs` 실행)
- `scripts/` — 데이터 갱신 스크립트 (Node, GitHub Actions에서만 실행)
- `decisions.md` — 작업마다 남기는 3줄 결정 기록 (기획서 '모델 설계'의 원재료)
