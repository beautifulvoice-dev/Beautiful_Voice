# 0006. 기술 스택 — TypeScript 모노레포 (React+Vite PWA / NestJS / PostgreSQL)

- 상태: **Accepted** (2026-11-17 개발팀 합의. 11/17 회의에서 "기술 스택은 개발팀이 정하고 PM에 통보"로 결정 — PM 통보 필요)
- 날짜: 2026-11-17
- 결정자: 개발팀 — 주드(리더)·옵마·해나 (제안: 옵마)
- 관련: D-06, COM-01~03, P1-02·08·09, P2-01~04, R7·R9·R12, 스파이크 S3·S4, [ADR-0001](0001-modular-monolith-single-postgres.md), [08 A3·A10](../kickoff/08-architecture-tradeoffs.md)

> 전제: 이 결정은 [ADR-0001](0001-modular-monolith-single-postgres.md)(모듈형 모놀리스 + PostgreSQL 1개)의 구성을 구체화한다. ADR-0001은 아직 Proposed이며 따로 확정한다 — 0001이 바뀌면 이 ADR도 다시 본다.

## 맥락
ADR-0001(모듈형 모놀리스 + PostgreSQL 1개)을 실제 프레임워크로 구체화해야 첫 주 작업(모노레포 초기화·CI·COM-01·03, S3·S4)을 시작할 수 있다.
이 서비스에서 스택이 감당해야 하는 것:
- 마이크가 웹앱을 거치지 않고 API로 직접 업로드(Q1 ✅)하고, 전사·구조화는 워커가 비동기로 처리(P1-02·03).
- 예약 겹침 금지·강제 RLS·시간 구간 타입을 DB에서 직접 써야 함(P2-04, COM-01, ADR-0003).
- 원장 웹앱은 로그인 뒤에서만 쓰는 화면, 스마트폰·매장 노트북 둘 다, 모바일 최적화 필수(P1-08, Q2 ✅) — 검색 노출 불필요.
- 개발 3명·8주, AI 코드 생성 비중이 큼(R12).

비슷한 오픈소스 서비스 조사(11/17, 2차 자료 기준·버전 미검증):

| 서비스 | 웹 | 서버·작업 | DB |
|---|---|---|---|
| Twenty (CRM) | React + Vite | NestJS + BullMQ | PostgreSQL |
| Comp AI CRM (에이전트 CRM) | Next.js | NestJS API + 에이전트 별도 배포 | PostgreSQL 공유 |
| Cal.com (예약) | Next.js(tRPC) | API v2 NestJS | PostgreSQL(Prisma) |
| Atomic CRM | React + Vite, shadcn/Tailwind | Supabase | PostgreSQL |

공통: TypeScript + React + PostgreSQL, 서버를 분리하면 NestJS, 에이전트·장시간 작업은 웹 요청과 분리. 구조는 Comp AI CRM(웹 / API / 에이전트가 Postgres 공유)이 우리 02·08 설계와 가장 가깝다.

## 고려한 선택지
1. **TS 모노레포: 웹 React+Vite PWA / API·워커 NestJS / PostgreSQL** — 웹·API가 계약 타입 공유, API를 기기·워커가 직접 쓰는 구조와 맞음, 레퍼런스(Twenty·Comp AI)가 가장 많음. 단점: 앱이 2종(웹·서버)이라 Next.js 단일 앱보다 초기 설정이 조금 많음.
2. **Next.js 하나로 웹+API** (Cal.com 방식) — 초기 설정 최소. 단점: 기기 업로드·워커가 웹 서버에 묶이고, 장시간 STT 작업은 어차피 별도 워커 필요 → 경계가 흐려짐.
3. **Supabase 중심** (Atomic CRM 방식) — 인증·RLS·스토리지 즉시 사용, 초기 속도 최고. 단점: 업체 종속, 음성 워커는 별도, 국내 리전 저장 검토 필요(Q9 ✅ 해외 AI 처리는 허용).

## 결정
1번. DB 접근 도구(Drizzle/Kysely)는 아래 표대로 S4(예약 충돌 검증, 분해표 C-05)에서 확정한다.
Phase 1은 PM이 별도 저장소(Next.js+Supabase)로 만들지만 이 결정과 무관하다 — 11/17 회의에서 Phase 1·2 기반을 분리하고 Phase 1은 플로우만 참고하기로 했다.

| 영역 | 선택 | 메모 |
|---|---|---|
| 언어·저장소 | TypeScript, pnpm 워크스페이스 + Turborepo | `apps/web`, `apps/server`(API·워커 진입점 2개), `packages/contracts`(OpenAPI·타입) |
| 웹 (옵마) | React + Vite, PWA, TanStack Query, shadcn/ui + Tailwind | 라우터·폼·캘린더 컴포넌트는 작은 선택 — 담당자가 PR로 결정 |
| API·워커 (주드·해나) | NestJS, 같은 코드베이스를 API·워커 두 프로세스로 실행 | ADR-0001의 배포 단위 2개 |
| DB | PostgreSQL | 범위 타입·`EXCLUDE`·강제 RLS (ADR-0003) |
| DB 접근 | **Drizzle 또는 Kysely** — S4에서 하나로 확정 | SQL을 그대로 쓰는 마이그레이션 필수. Prisma는 `tstzrange`·배타 제약·RLS 다루기가 불편할 수 있어 기본 후보에서 제외(미검증 — S4에서 확인) |
| 작업 큐 | Postgres 기반(pg-boss 등)으로 시작 | 처리량이 커지면 BullMQ(Redis)로 교체 — Twenty 방식 |
| 계약 | OpenAPI 3 단일 파일 → 서버 검증·웹 클라이언트 타입 생성 | `contract-change` 스킬 |
| 공통 | Docker Compose 로컬 환경, GitHub Actions CI(lint·typecheck·test) | 02 §5 고정 권고 그대로 |

ASSUMPTION: 런타임은 Node.js LTS. Bun은 이전 코드가 썼지만 별도 판단으로 두고 채택하지 않는다.

## 결과
- 좋아지는 점: 3명이 한 언어로 서로의 PR을 리뷰. 웹·서버가 계약 타입을 공유해 불일치가 컴파일 단계에서 드러남. NestJS 모듈 구조로 모듈형 모놀리스 경계를 지키기 쉬움. 유사 CRM 레퍼런스를 그대로 참고 가능.
- 감수하는 점: 파이썬 오디오·AI 라이브러리를 직접 쓰기 어려움(STT·LLM은 외부 API라 영향 작음, 필요 시 워커에 별도 프로세스 추가). NestJS 학습 비용.
- 되돌리는 비용: 웹 프레임워크(Vite↔Next)는 첫 2주 안이면 낮음. 서버 언어·DB는 코드가 쌓이면 높음 — 그래서 첫 주에 확정.
- 재검토 조건: ① S4에서 선택한 DB 도구로 배타 제약·RLS 테스트가 불편하면 다른 도구로 교체 ② S1·S2에서 파이썬 전용 모델·라이브러리가 필수로 나오면 워커만 Python 분리 검토 ③ 호스팅·예산(Q13) 결정으로 관리형 서비스(Supabase 등)가 명확히 유리해지면 3번 재검토.
