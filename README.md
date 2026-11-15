# Beautiful Voice

1인 에스테틱 원장을 위한 음성 기록·CRM AI 비서.

> 현재 상태: **개발 착수 준비 단계** (킥오프 회의 2026-11-17). 기술 스택 확정 전이라 실행 코드는 없다.

## 문서

| 문서 | 내용 |
|---|---|
| 제품 백로그 v1.0 (PM 원본, **저장소 미포함**) | 제품 정의·Phase·35개 백로그 |
| 회의 안건 11/17 (PM 원본, **저장소 미포함**) | 화요일 회의 안건 |
| [01. 백로그 검토](docs/kickoff/01-backlog-review.md) | Phase 2 중심 의존성·난도·불명확 사항 |
| [02. 아키텍처 초안](docs/kickoff/02-architecture.md) | 시스템 구조·데이터 모델·인터페이스·스택 후보 |
| [03. 기술 리스크](docs/kickoff/03-tech-risks.md) | 리스크·스파이크 |
| [04. 개발 규칙](docs/kickoff/04-dev-rules.md) | Git·PR·리뷰·AI 활용·CI/CD |
| [05. R&R](docs/kickoff/05-rnr.md) | 리더·역할 분담 초안 |
| [06. PM 질문](docs/kickoff/06-pm-questions.md) | 제품 결정 요청 목록 |
| [ADR](docs/adr/) | 기술 결정 기록 |

> **PM 원본 문서는 공개 저장소에 올리지 않는다.** Slack 기획 자료 채널에서 받아 로컬의 `docs/product/source/`에 두면 AI 도구가 참조한다(이 폴더는 `.gitignore` 처리됨).
> - `docs/product/source/product-backlog-v1.0.md`
> - `docs/product/source/meeting-agenda-2026-11-17.md`

## AI 개발 환경
- `CLAUDE.md`: 모든 AI 코딩 도구가 따르는 프로젝트 규칙
- `.claude/skills/`: 팀 공용 스킬 (`story-to-issue`, `write-adr`, `contract-change`)
- `.github/workflows/ai-review.yml`: PR 자동 AI 리뷰 · `claude.yml`: PR/이슈에서 `@claude` 호출
  - 인증은 **Claude 구독 토큰** 방식(추가 종량제 비용 없음, 토큰 주인의 구독 사용량에서 차감)
  - 설정: 토큰 담당자가 `claude setup-token` 실행 → 저장소 Secrets에 `CLAUDE_CODE_OAUTH_TOKEN`으로 등록
