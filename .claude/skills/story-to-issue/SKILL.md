---
name: story-to-issue
description: 제품 백로그 ID(예 P2-04)를 받아 수용 기준·가정·의존성이 포함된 GitHub story 이슈 초안을 만든다. 스프린트 백로그를 쪼개거나 이슈를 만들 때 사용.
---

# 백로그 → 이슈

1. `docs/product/source/product-backlog-v1.0.md`에서 해당 ID의 유저 스토리·수용 기준·우선순위·의존성을 찾는다. 파일이 없으면(로컬 전용 폴더) Slack 기획 자료 채널에서 받아 넣어 달라고 요청하고, ID가 없으면 멈추고 알린다. 공개 이슈에는 PM 원문을 통째로 복사하지 않는다.
2. `docs/kickoff/01-backlog-review.md`의 해당 행에서 불명확 사항과 PM 질문 번호를 확인한다.
3. 수용 기준을 **테스트 가능한 Given/When/Then**으로 바꾼다. 원문에 없는 조건은 `ASSUMPTION:`으로 별도 표시하고 기준에 섞지 않는다.
4. 하루~이틀 단위(≤400줄 PR)로 쪼갠다. 예: 스키마/계약 → 도메인 서비스+테스트 → API → UI.
5. `.github/ISSUE_TEMPLATE/story.yml` 필드 순서로 Markdown 초안을 출력한다. 라벨 제안: `phase:*`, `area:*`, 미결 질문이 있으면 `blocked:pm`.
6. 사용자가 요청한 경우에만 `gh issue create`로 생성한다(생성 전 내용을 보여주고 확인).
