# 직접 테스트하기

> 대상: 팀원이 자기 PC에서 지금 들어와 있는 코드를 확인하는 방법. CI(`verify`)가 PR마다 같은 검사를 자동으로 돌리지만, 로컬에서 먼저 돌려 보면 빠르다.
> 준비: [README 로컬 개발](../../README.md#로컬-개발)대로 `corepack enable pnpm` → `pnpm install --frozen-lockfile`.

## 1. 전체 검사 — CI와 같은 순서

```bash
pnpm lint
```

```bash
pnpm typecheck
```

```bash
pnpm build
```

```bash
pnpm test
```

하나라도 실패하면 PR이 main에 머지되지 않는다(`verify` 필수 체크, [04 §2](../kickoff/04-dev-rules.md)).

## 2. 앱 직접 띄워 보기

```bash
docker compose up -d --wait db
```

```bash
pnpm dev
```

- 웹: http://127.0.0.1:5173 → **API 연결 확인** 버튼 → "연결 정상"
- API: http://127.0.0.1:3000/api/health → `{"status":"ok"}`
- 끝나면 `docker compose down`

Docker가 없으면 DB 없이 `pnpm build` 후 API만 띄워 확인할 수 있다: `node apps/server/dist/main.js`.

## 3. 예약 도메인 로직 (`packages/scheduling`)

예약 충돌 판정(C-05)·상태 전이(C-04)는 DB 없이 도는 순수 함수다. 테스트가 곧 규칙 명세다.
(11/18 기준 PR #19·#20·#23 리뷰 중 — 머지 전에는 아래 `gh pr checkout`으로 확인)

```bash
pnpm --filter @bv/scheduling test
```

| 테스트 파일 | 확인하는 규칙 |
|---|---|
| `test/conflict.test.ts` | 동시 최대 2건, 일반 저장은 겹치면 거절, 강제 저장 자리 재배정, 영업시간·휴무·임시 차단, 서머타임 전환일 |
| `test/status.test.ts` | 상태 5종 전이 표(상태 × 동작 × 시각), 원장 생성 = 확정, 자동 완료, 노쇼 정정 |
| `test/db.test.ts` | 실제 PostgreSQL 배타 제약 — 아래 4번 |

규칙을 바꿔 보고 싶으면 테스트의 기대값을 먼저 고치고 실패를 확인한 뒤 코드를 고친다(수용 기준 → 테스트 → 구현).

> 리뷰 중인 PR의 코드를 미리 보려면 그 브랜치로 바꾼다: `gh pr checkout <PR번호>` → `pnpm install` → 위 명령.

## 4. DB 통합 테스트 (예약 충돌 배타 제약)

`TEST_DATABASE_URL`이 있을 때만 돈다. 없으면 건너뛴다(CI에서도 아직 건너뜀 — [04 §6](../kickoff/04-dev-rules.md)). `psql` CLI가 필요하다.

Docker Compose DB를 쓰는 경우(.env를 바꿨다면 그 값으로):

```bash
TEST_DATABASE_URL=postgresql://bv_local:bv_local_only@127.0.0.1:5432/beautifulvoice pnpm --filter @bv/scheduling test
```

확인하는 것: 같은 자리 겹침 거절, 3건째 거절, 취소·요청·노쇼는 자리 미점유, 매장 간 독립, 강제 저장 재배정 트랜잭션, **병렬 저장 100회 후 정확히 2건**. 테스트마다 임시 스키마를 만들고 지우므로 로컬 DB 데이터는 건드리지 않는다.

## 데이터 규칙

테스트·픽스처에는 **합성 데이터만** 쓴다. 실제 원장·고객 이름, 전화번호, 녹음은 넣지 않는다(CLAUDE.md 절대 규칙 8).
