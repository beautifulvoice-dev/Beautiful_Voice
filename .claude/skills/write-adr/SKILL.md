---
name: write-adr
description: 기술 결정(스택·DB·벤더·패턴·스파이크 결과)을 docs/adr/에 ADR로 기록한다. 결정을 내렸거나 제안할 때 사용.
---

# ADR 작성

1. `docs/adr/`의 가장 큰 번호 + 1로 `NNNN-kebab-title.md`를 만든다. 형식은 `docs/adr/0000-template.md`.
2. 상태: 회의 합의 전이면 `Proposed`, 합의 후 `Accepted`(날짜·합의자 기록). 기존 결정을 바꾸면 이전 ADR을 `Superseded by NNNN`으로 갱신.
3. 맥락에는 근거가 된 백로그 ID·리스크 번호(`03-tech-risks.md`)·스파이크 결과를 링크한다.
4. 고려한 선택지는 2~3개, 각 장단점은 이 서비스 기준으로만 쓴다(일반론 금지).
5. 결과에 "되돌리는 비용"과 "재검토 조건"을 적는다.
6. `README.md`/`02-architecture.md`의 해당 표시(🟡)를 갱신해야 하는지 확인한다.
