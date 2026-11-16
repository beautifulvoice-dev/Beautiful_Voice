# Beautiful Voice

1인 에스테틱 원장을 위한 음성 기록·CRM AI 비서. 원장이 마이크로 말하면 AI가 고객·예약·할 일을 정리하고, 변경은 원장이 승인한 뒤 반영한다.

| Phase | 내용 |
|---|---|
| 1 | 마이크 녹음 → STT → 구조화 → 웹앱 정리함·확인할 일·정정 (**일방향**) |
| 2 | 같은 웹앱의 CRM(고객·예약·충돌 확인) + 음성·채팅 조회·변경(승인 후) + 장부 낭독 입력 + 기초 인사이트 |
| 3 | AI 전화 수신·접수 → 승인 후 처리·고객 발송 |

> **현재 상태:** 개발 착수 준비 단계. 킥오프 회의 2026-11-17. 기술 스택 확정 전이라 실행 코드는 없다.
> 회의용 요약은 **[07. 개발팀 입장 정리](docs/kickoff/07-dev-position.md)**부터 본다.

## 문서

| 문서 | 내용 |
|---|---|
| [01. 백로그 검토](docs/kickoff/01-backlog-review.md) | Phase 2 중심 의존성·난도·불명확 사항 |
| [02. 아키텍처 초안](docs/kickoff/02-architecture.md) | 구조·데이터 모델·인터페이스·스택 후보·이전 코드 재사용 방침(§7) |
| [03. 기술 리스크](docs/kickoff/03-tech-risks.md) | 리스크·스파이크·eval 설계 원칙 |
| [04. 개발 규칙](docs/kickoff/04-dev-rules.md) | Git·PR·리뷰·AI 활용·CI/CD·토큰 등록 |
| [05. R&R](docs/kickoff/05-rnr.md) | 리더·역할 분담 초안 |
| [06. PM 질문](docs/kickoff/06-pm-questions.md) | 제품 결정 요청 목록(Q1~Q25) |
| [07. 개발팀 입장 정리](docs/kickoff/07-dev-position.md) | 회의 안건별 제안·첫 주 계획·온보딩 |
| [08. 아키텍처 트레이드오프](docs/kickoff/08-architecture-tradeoffs.md) | PM용 — 백로그 근거로 본 선택지·이점·포기하는 것 |
| [ADR](docs/adr/) | 기술 결정 기록 (0001~0005, 모두 Proposed) |

### 저장소에 없는 자료 (로컬 전용, git 제외)

| 경로 | 내용 | 받는 곳 |
|---|---|---|
| `docs/product/source/` | PM 원본 — 제품 백로그 v1.0, 회의 안건 | Slack 기획 자료 채널 |
| `.private/` | 이전 프로젝트 코드(비공개)와 분석 보고서 | 개발 리더에게 요청 |

이 저장소는 **공개 저장소**다. 위 자료와 실제 고객 데이터·비밀값은 커밋하지 않는다.

## 처음 합류했다면

1. Collaborator 초대 수락. fork 하지 말고 이 저장소에 브랜치로 작업
2. PM 원본을 `docs/product/source/`에 넣기
3. 본인 Claude 구독 토큰 등록 (AI 리뷰가 본인 구독으로 실행됨)
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
