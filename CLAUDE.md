# Beautiful Voice — AI 작업 지침

1인 에스테틱 원장이 마이크로 업무를 말하면 AI가 고객·예약·할 일을 정리해 주는 비서 서비스.
Phase 1: 음성 기록 → 전사·구조화 → 웹앱 정리함 / Phase 2: 같은 웹앱의 CRM을 음성·채팅으로 조작 / Phase 3: AI 전화 수신.

## 반드시 읽을 문서
- 제품 요구사항(원천, **수정 금지**): `docs/product/source/product-backlog-v1.0.md`
  - 공개 저장소라 git에 포함되지 않는 로컬 전용 폴더다. 파일이 없으면 사용자에게 Slack 기획 자료 채널에서 받아 넣어 달라고 요청한다. 절대 커밋하지 않는다.
- 아키텍처: `docs/kickoff/02-architecture.md` · 개발 규칙: `docs/kickoff/04-dev-rules.md`
- 기술 결정: `docs/adr/` (새 결정은 `write-adr` 스킬로 작성)
- 회의 입장·첫 주 계획: `docs/kickoff/07-dev-position.md`

## 현재 단계
1차 스프린트(2026-11-18 ~ 11-25 자정): **Phase 2 모듈 2A CRM 기반**(P2-01·02·03·04·10 + COM-01~03) 완성. Phase 1은 PM이 별도 저장소에서 만들며, 여기서는 플로우·정책만 참고한다.
**기술 스택 확정: ADR-0006**(Accepted, 11/17) — TS 모노레포(pnpm+Turborepo) / React+Vite PWA / NestJS API·워커 / PostgreSQL. 로컬 실행은 README.md를 따른다. 빌드·검사는 pnpm build, pnpm lint, pnpm typecheck, pnpm test를 사용한다(직접 테스트 안내: `docs/dev/testing.md`). PR은 CI `verify` 통과가 머지 필수 조건이다. 호스팅은 AWS EC2 + RDS(ADR-0007).
역할: 리더·서버 기반 주드 / CRM·웹앱 옵마 / 음성·AI 해나 (`docs/kickoff/05-rnr.md`).
이전 프로젝트 코드는 **설계만 참고하고 새로 작성**한다(ADR-0005, Proposed). `.private/`의 이전 코드를 복사해 넣지 않는다.

## 절대 규칙
1. PM 문서(`docs/product/source/`)는 수정하지 않는다. 제품 질문은 `docs/kickoff/06-pm-questions.md` 형식으로 제안한다.
2. 문서에 없는 제품 요구사항을 만들지 않는다. 가정이 필요하면 코드 주석·PR에 `ASSUMPTION:`으로 표시한다.
3. AI(LLM)가 예약·고객 데이터를 **직접 변경하지 않는다.** `ActionProposal` → 원장 승인 → 도메인 서비스 실행 경로만 사용.
4. 웹·음성·전화의 모든 쓰기는 같은 도메인 서비스를 호출한다. 예약 충돌은 DB 제약으로 최종 보장한다.
5. 모든 데이터는 `shop_id`로 격리한다. 쿼리에 shop 조건이 빠진 코드는 버그다.
6. 쓰기 API는 `Idempotency-Key`를 지원한다. 원본(녹음·전사)은 불변, 정정은 `revision`으로 남긴다.
7. 시간은 UTC 저장, 표시·집계·'내일' 해석은 매장 시간대(기본 Asia/Seoul)와 녹음 시각 기준.
8. 로그·에러 메시지·테스트 픽스처에 실제 개인정보를 넣지 않는다. 합성 데이터만 사용.
   이 저장소는 **공개**다. `docs/product/source/`·`.private/`의 내용(PM 원본, 이전 코드·분석)을 커밋·PR·이슈·공개 문서에 옮기지 않는다.
9. 비밀값은 코드에 하드코딩하지 않는다. `.env.example`만 커밋.
10. 도메인 로직(예약·권한·멱등·상태 전이)은 테스트 없이 완료로 보지 않는다.

## 작업 방식
- 이슈의 백로그 ID와 수용 기준에서 출발한다. 수용 기준 → 테스트 → 구현 순서.
- 계약(OpenAPI) 변경은 `contract-change` 스킬 절차를 따른다.
- PR은 작게(≤400줄), Conventional Commits, PR 템플릿의 "AI 사용 범위"를 채운다.
- AI 리뷰는 PR을 열 때 1회. 🔴 필수만 반영 의무, 🟡·❔는 판단 후 반영하거나 "반영 안 함 + 이유". 재리뷰는 `/review`.
- 커밋할 때는 파일을 지정해서 추가한다(`git add -A` 지양).
