# 서버(API) 처음 만들기 — 웹 개발자를 위한 온보딩

> 대상: 화면은 만들어 봤지만 `apps/server`는 처음인 팀원(2차 스프린트 기능별 분담 — 화면 + 서버를 한 사람이).
> 표본: **고객 API**(`apps/server/src/customers/`). 이미 웹 화면이 쓰고 있는 API라 요청·응답 모양을 알고 시작할 수 있다.
> 관련 규칙: [CLAUDE.md 절대 규칙](../../CLAUDE.md) 4·5·6·8·10, [ADR-0003 매장 격리](../adr/0003-tenant-isolation-forced-rls.md), [ADR-0009 매장은 세션으로](../adr/0009-shop-scope-from-session-token.md), [직접 테스트하기](testing.md)

## 1. 요청 하나가 지나가는 길

```
웹 fetch (apps/web/src/lib/http.ts)
 → Guard: 로그인했고 이 매장 원장인가        common/owner-shop.guard.ts
 → Controller: 주소 → 함수 연결              customers/customer.controller.ts
 → (쓰기면) idempotentWrite: 같은 요청 한 번만 common/idempotent-write.ts
 → database.withShop: 매장 트랜잭션 시작      database.service.ts
 → Service: 입력 검사 → 잠금 → 저장 → 결과    customers/customer.service.ts
 → PostgreSQL: RLS·복합 FK·트리거가 마지막 방어 apps/server/db/migrations/*.sql
 → 오류는 ApiExceptionFilter가 { code, message, details }로 통일  common/api-exception.filter.ts
```

## 2. 꼭 지킬 다섯 가지
| 규칙 | 어떻게 | 왜 |
|---|---|---|
| **매장 트랜잭션 안에서만 쿼리** | 컨트롤러에서 `this.database.withShop(shopId, (client) => …)`로 감싸고, 서비스는 그 `client`만 쓴다 | DB가 `app.shop_id`로 다른 매장 행을 막는다(RLS) |
| **쿼리마다 `shop_id` 조건** | `WHERE shop_id = $1 AND id = $2` | RLS가 있어도 빠뜨리면 버그로 본다(절대 규칙 5) |
| **쓰기는 멱등** | 쓰기 핸들러는 `idempotentWrite(...)`로 감싼다. `Idempotency-Key` 없으면 400 | 응답이 끊겨 다시 보내도 한 번만 저장(절대 규칙 6) |
| **고칠 수 있는 행은 `version`** | `SELECT … FOR UPDATE` → 받은 `version`과 다르면 409 `VERSION_CONFLICT` (`customer.service.ts`의 `lock`) | 두 화면에서 동시에 고쳐도 덮어쓰지 않게 |
| **개인정보는 로그·오류에 넣지 않기** | 오류 `message`·`details`에 이름·전화번호 금지, 테스트는 합성 데이터 | 절대 규칙 8 |

## 3. API 하나 만드는 순서
1. **설계 초안(사람이 직접):** 하려는 일 / 데이터 / API 표(메서드·주소·성공 코드) / 요청·응답 예시 / 실패 표. 표본: 고객 API를 만든 계약 #42와 예약 설계 노트.
2. **계약 먼저:** `packages/contracts/*.openapi.yaml`과 `crm.d.ts`에 주소·요청·응답·오류를 적는다. [contract-change 스킬](../../.claude/skills/contract-change/SKILL.md) 절차를 따른다. 주소 규칙(ADR-0009, Accepted 뒤 적용 — 그 전에는 리더와 확인): **새 리소스 묶음**(지갑·카드·문자·템플릿 등)은 주소에 매장 ID를 넣지 않는다(세션에서 정함). **기존 리소스를 넓히는 일**(고객에 칸 추가, 고객 하위 기록 등)은 B단계 통일 전까지 기존 `/api/shops/{shopId}/…`를 그대로 쓴다. 웹은 `lib/http.ts`의 공용 경로 함수로 두 방식을 만든다(세션 기준 경로 함수는 S1에서 추가).
3. **DB가 필요하면 초안만:** 테이블·칸이 필요하면 설계 초안에 적고, 2차 스프린트는 **마이그레이션을 한 PR로 모아** 리더가 리뷰한다. 각자 마이그레이션 파일을 따로 만들지 않는다.
4. **컨트롤러:** `customer.controller.ts`를 그대로 따라 한다. 읽기 = `withShop`, 쓰기 = `idempotentWrite`. 새 컨트롤러는 `app.module.ts`의 `controllers`·`providers`에 등록.
5. **서비스:** 입력 검사(`unknown`을 받아 필드별로 확인, 실패는 422 `VALIDATION_FAILED` + `fields`) → 필요하면 잠금 → 저장 → 저장한 행을 다시 읽어 응답. 도메인 규칙(번호 정규화 등)은 DB 없이 도는 순수 함수로 `packages/*`에 두면 테스트가 쉽다(예: `packages/customers`).
6. **테스트(필수, 절대 규칙 10):**
   - 순수 함수: `packages/*/test` — DB 없이 `pnpm --filter <패키지> test`
   - API: `apps/server/test/*.test.cjs` — 실제 PostgreSQL + Nest 앱(표본 `m1-customers.test.cjs`). 새 파일은 `apps/server/package.json`의 `db:test` 목록에 추가
   - 최소: 성공 / 입력 오류 422 / 다른 매장 접근 거부 / 같은 키 재전송 / 오래된 version 409
7. **화면 연결:** `apps/web/src/features/<기능>/httpApi.ts`에 붙이고, 가짜 데이터(`mockData.ts`)와 모양을 맞춘다.
8. **PR:** ≤400줄, PR 템플릿 "AI 사용 범위", 계약 diff 요약, 서버 PR은 리더 또는 서버 경험자 리뷰.

## 4. 로컬에서 돌려 보기
- 전체 검사(CI와 같음): `pnpm lint` → `pnpm typecheck` → `pnpm build` → `pnpm test`
- DB 테스트: Docker DB를 띄우고 마이그레이션 후 `pnpm --filter @bv/server db:test` — 자세한 순서는 [testing.md](testing.md) 2·5절
- 서버 테스트는 빌드 결과(`apps/server/dist`)를 불러오므로 **`pnpm --filter @bv/server build` 후** 실행
- DB를 못 띄우면 PR을 올려 CI `verify`에서 확인해도 된다(CI가 PostgreSQL을 띄운다)

## 5. 처음 할 때 자주 막히는 곳
| 증상 | 확인 |
|---|---|
| 조회 결과가 항상 비어 있음 | `withShop` 밖에서 쿼리했거나 다른 `client`를 씀(RLS가 막음) |
| 쓰기가 400 `INVALID_IDEMPOTENCY_KEY` | 요청 헤더 `Idempotency-Key` 누락(웹 `http.send`의 `idempotencyKey`) |
| 같은 키로 다른 본문을 보내 422 | 키를 재사용함 — 입력이 바뀌면 새 키(`lib/retryKey.ts`) |
| 테스트가 옛 코드로 돎 | 서버 다시 빌드 안 함 |
| 다른 매장 데이터가 보임 | 즉시 리더에게 알림(격리 버그는 최우선) |

## 6. AI와 같이 만들 때
- 설계(데이터·API·결정)는 사람이 정하고, 코드는 AI에게 "**`customers/`와 같은 패턴으로**"라고 표본을 짚어 맡긴다.
- AI가 만든 서버 코드는 위 2절 다섯 가지를 직접 확인한다. 특히 `shop_id` 조건과 `withShop` 밖 쿼리.
