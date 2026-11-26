# Beautiful Voice

1인 에스테틱 원장을 위한 음성 기록·CRM AI 비서. 원장이 마이크로 말하면 AI가 고객·예약·할 일을 정리하고, 변경은 원장이 승인한 뒤 반영한다.

| Phase | 내용 |
|---|---|
| 1 | 마이크 녹음 → STT → 구조화 → 웹앱 정리함·확인할 일·정정 (**일방향**) |
| 2 | 같은 웹앱의 CRM(고객·예약·충돌 확인) + 음성·채팅 조회·변경(승인 후) + 장부 낭독 입력 + 기초 인사이트 |
| 3 | AI 전화 수신·접수 → 승인 후 처리·고객 발송 |

> **현재 상태:** 2A CRM 개발 착수. 로컬 개발환경은 아래 절차로 실행합니다.
> 회의용 요약은 **[07. 개발팀 입장 정리](docs/kickoff/07-dev-position.md)**부터 본다.


## 로컬 개발

Node.js는 .node-version, pnpm은 package.json의 packageManager 버전을 사용합니다. 로컬 DB에는 Docker와 Compose가 필요합니다.

```sh
corepack enable pnpm
pnpm install --frozen-lockfile
cp .env.example .env
docker compose up -d --wait db
docker compose exec -T db psql -U bv_local -d beautifulvoice -f /bv/local-role.sql
pnpm --filter @bv/server db:migrate
pnpm dev
```

브라우저에서 http://127.0.0.1:5173/settings 를 열고 **API 연결 확인**을 누릅니다. http://127.0.0.1:3000/api/health 응답으로 API 기동을 따로 확인할 수 있습니다. 로컬 PostgreSQL 기본 주소는 127.0.0.1:5432입니다. DB 설정을 바꾸면 `.env`의 URL과 위 명령에도 같은 값을 적용합니다.

```sh
docker compose exec -T db psql -U bv_local -d beautifulvoice -c "SELECT 1;"
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm --filter @bv/server db:test
docker compose down
```

마이그레이션은 `DATABASE_MIGRATION_URL`로 실행하고 적용 기록을 `crm.schema_migration`에 남깁니다. 새 SQL 파일은 `apps/server/db/migrations/`에 다음 번호로 추가합니다. DB 테스트는 합성 매장 두 곳을 만들 수 있는 로컬 DB에서 실행합니다.

앱은 `DATABASE_URL`로 접속합니다. 배포 환경에서는 마이그레이션 계정과 별도로 `bv_app` 권한 그룹 및 이 그룹을 상속하는 앱 로그인 역할을 프로비저닝합니다. 서버는 기동 시 앱 역할의 권한을 검사합니다. 인증된 매장 ID를 사용하는 트랜잭션만 해당 매장 행에 접근할 수 있습니다.

직접 테스트하는 방법(도메인 로직·DB 통합 테스트 포함)은 [docs/dev/testing.md](docs/dev/testing.md)를 본다.

### 로컬 카카오 로그인

카카오 Developers 앱에서 카카오 로그인을 활성화하고, 웹과 같은 주소의 콜백을 등록합니다. 로컬 기본값은 `http://127.0.0.1:5173/api/auth/kakao/callback`입니다. 브라우저에서도 `localhost` 대신 등록한 주소와 같은 호스트를 사용합니다.

1. `.env`에 카카오 앱 REST API 키(`KAKAO_CLIENT_ID`), 활성화한 클라이언트 시크릿(`KAKAO_CLIENT_SECRET`), 등록한 콜백 주소(`KAKAO_REDIRECT_URI`)를 설정합니다.
2. 아래 명령으로 세션 서명 키를 생성해 `BV_SESSION_SECRET`에 설정합니다. 배포 환경에서는 HTTPS 콜백을 사용합니다.

   ```sh
   node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

3. 로컬 DB를 마이그레이션한 뒤, 웹 개발 서버를 끈 상태에서 `pnpm --filter @bv/server db:register-local-owner`를 실행합니다. 터미널에 나온 주소를 열어 본인 카카오 계정으로 로그인하면, 로컬 합성 매장 한 곳에 원장이 연결됩니다. 기존 원장 연결은 덮어쓰지 않습니다.
4. 등록이 끝나면 `pnpm dev`를 실행하고 브라우저에서 `http://127.0.0.1:5173/api/auth/kakao/start`를 엽니다. 이후 `/api/auth/session`에서 소속 매장을 확인할 수 있습니다.

웹 연동 경로와 응답은 [로그인 API 계약](packages/contracts/auth.openapi.yaml)을 참고합니다.

## 문서

| 문서 | 내용 |
|---|---|
| [01. 백로그 검토](docs/kickoff/01-backlog-review.md) | Phase 2 중심 의존성·난도·불명확 사항 |
| [02. 아키텍처 초안](docs/kickoff/02-architecture.md) | 구조·데이터 모델·인터페이스·스택(확정)·이전 코드 재사용 방침(§7) |
| [03. 기술 리스크](docs/kickoff/03-tech-risks.md) | 리스크·스파이크·eval 설계 원칙 |
| [04. 개발 규칙](docs/kickoff/04-dev-rules.md) | Git·PR·리뷰·AI 활용·CI/CD·토큰 등록 |
| [05. R&R](docs/kickoff/05-rnr.md) | 리더·역할 분담 초안 |
| [06. PM 질문](docs/kickoff/06-pm-questions.md) | 제품 결정 요청 목록(Q1~Q25) |
| [07. 개발팀 입장 정리](docs/kickoff/07-dev-position.md) | 회의 안건별 제안·첫 주 계획·온보딩 |
| [08. 아키텍처 트레이드오프](docs/kickoff/08-architecture-tradeoffs.md) | PM용 — 백로그 근거로 본 선택지·이점·포기하는 것 |
| [09. M1 작업 분해표](docs/kickoff/09-sprint1-2a-breakdown.md) | Phase 2 M1(손으로 쓰는 CRM) 이슈 BEA-155~179·선행·담당 제안, 옛 작업 ID 대응 |
| [ADR](docs/adr/) | 기술 결정 기록. 0001·0002·0003·0005·[0006 스택](docs/adr/0006-tech-stack-ts-monorepo.md)·[0007 호스팅](docs/adr/0007-hosting-aws-ec2-rds.md)·[0008 SEED](docs/adr/0008-web-ui-seed-design.md) Accepted, 0004(Phase 3 전화)·[0009 매장은 세션으로](docs/adr/0009-shop-scope-from-session-token.md) Proposed |

### 저장소에 없는 자료 (로컬 전용, git 제외)

| 경로 | 내용 | 받는 곳 |
|---|---|---|
| `docs/product/source/` | PM 원본 — 제품 백로그 v1.0, 회의 안건 | Slack 기획 자료 채널 |
| `.private/` | 이전 프로젝트 코드(비공개)와 분석 보고서 | 개발 리더에게 요청 |

이 저장소는 **공개 저장소**다. 위 자료와 실제 고객 데이터·비밀값은 커밋하지 않는다.

## 처음 합류했다면

1. Collaborator 초대 수락. fork 하지 말고 이 저장소에 브랜치로 작업
2. PM 원본을 `docs/product/source/`에 넣기
3. 본인 Claude 구독 토큰 등록 (AI 리뷰가 본인 구독으로 실행됨). Claude 구독이 없으면 본인 LLM 리뷰(예: Codex)를 켠다 — 공용 토큰은 없다
   ```bash
   claude setup-token
   ```
   ```bash
   bash scripts/register-claude-token.sh <GitHub 아이디>
   ```
   등록 스크립트는 저장소 관리자 권한이 있는 터미널에서 실행한다. 자세한 절차는 [04 §6](docs/kickoff/04-dev-rules.md).
4. [`CLAUDE.md`](CLAUDE.md)와 [04 개발 규칙](docs/kickoff/04-dev-rules.md) 읽기

## AI 개발 환경

| 구성 | 내용 |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | 모든 AI 코딩 도구가 따르는 프로젝트 규칙 |
| `.claude/skills/` | 팀 공용 스킬: `story-to-issue`(백로그→이슈), `write-adr`(결정 기록), `contract-change`(API 계약 변경), `legacy-code-analysis`(이전 코드 분석) |
| AI 자동 리뷰 (`ai-review.yml`) | PR을 **열 때 1회** 실행, 🔴 필수만 인라인, 제안·질문은 요약에. 수정 후 다시 보려면 PR에 `/review` 코멘트 |
| `@claude` (`claude.yml`) | 이슈·PR 코멘트에서 AI 에이전트 호출 |
| 인증 | 각자 본인 Claude 구독 토큰(`CLAUDE_TOKEN_<아이디>`), 추가 종량제 비용 없음 |

AI 리뷰는 보조다. 머지에는 사람의 판단이 필요하고, AI가 쓴 코드도 PR 작성자가 책임진다.

## PR 흐름

```
이슈(백로그 ID·수용 기준) → 브랜치 → 구현+테스트 → PR(템플릿) → AI 리뷰 1회
→ 🔴 필수 반영 → (필요 시 /review) → 사람 승인 → Squash merge
```

`main`은 보호되어 있어 직접 push할 수 없다. 워크플로 파일(`.github/workflows/`)을 바꾸는 PR은 AI 리뷰가 건너뛰어지므로 `needs-owner-check` 라벨을 붙이고 관리자가 직접 확인한다.
