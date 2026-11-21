# Beautiful Voice — AI 에이전트 공통 지침 (Codex 등)

이 저장소의 규칙 원본은 [`CLAUDE.md`](CLAUDE.md)다. Codex·GPT 등 다른 에이전트도 **CLAUDE.md의 "반드시 읽을 문서", "현재 단계", "절대 규칙", "작업 방식"을 그대로 따른다.** 이 파일은 차이만 적는다.

## 공통
- 답변·PR·커밋 설명은 한국어. 코드 식별자·명령어는 원문.
- 프로젝트 skill 원본은 `.claude/skills/`(contract-change, write-adr, story-to-issue, legacy-code-analysis). 해당 작업이면 그 SKILL.md 절차를 따른다.
- 설계는 사람이 결정하고 코드는 AI가 쓴다: 구현 전에 데이터·API·상태 전이·화면 흐름의 선택지를 추천·이유와 함께 내고 결정을 받는다.
- PR ≤400줄, PR을 2단 넘게 쌓지 않는다. 커밋은 파일을 지정해 추가한다.
- PR 템플릿 "AI 사용 범위"에 어떤 에이전트가 무엇을 했는지 적는다.

## 리뷰 등급 (첫 LLM 리뷰)
🔴 필수(머지 전 반드시) / 🟡 제안 / ❔ 질문. 인라인은 🔴만, 요약 코멘트는 1개이고 첫 줄은 "🔴 필수 N건" 또는 "✅ 필수 지적 없음 — 머지 가능(사람 승인 필요)". 세부는 `.github/workflows/ai-review.yml` 프롬프트와 같다.

## 공개 저장소 주의
`docs/product/source/`(PM 원본)와 `.private/`(로컬 전용)의 내용을 커밋·PR·이슈·공개 문서에 옮기지 않는다.
