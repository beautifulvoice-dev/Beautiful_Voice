# 0008. 웹 UI 부품을 SEED Design으로

- 상태: Accepted
- 날짜: 2026-11-21
- 결정자: 옵마(웹 담당). 디자인 담당(카본)의 희망 "Phase 2도 SEED 기반"을 받아 결정
- 관련: ADR-0006(기술 스택 — 웹 UI 부품 줄을 이 ADR이 바꾼다), M1 손으로 쓰는 CRM(2A-1·2A-2·2A-3), 백로그 2F-B7(메뉴 구성)

## 맥락
ADR-0006은 웹 UI 부품을 shadcn/ui + Tailwind로 잡았다. 11/20 디자인 전달(화면 설계서·토큰)은 SEED Design 3.4.0(`@seed-design/react`·`@seed-design/css`), 보라 브랜드, Pretendard를 정본으로 한다. 11/21 디자인 담당이 "원래 SEED를 쓰려고 했다"고 확인했다.

shadcn으로 계속 가면 디자인의 부품(ActionButton·Badge·Chip·SegmentedControl·BottomSheet 등)과 상태 톤을 하나하나 비슷하게 다시 만들어야 하고, 디자인이 바뀔 때마다 두 벌을 맞춰야 한다. 반대로 지금 웹앱에는 shadcn·Tailwind로 만든 화면(로그인·고객·캘린더)이 이미 있고, 시연은 11/25다.

## 고려한 선택지
1. **SEED로 바꾸고, Tailwind는 배치 전용으로 남김** — 디자인의 부품·톤을 그대로 쓴다. 기존 화면은 한 번에 갈아엎지 않고 화면별 PR로 옮길 수 있다. 캘린더 격자처럼 SEED에 없는 부품의 배치를 쓰기 쉽다. / 두 도구가 한동안 같이 있어 "색은 어디서 정하나" 규칙이 필요하다.
2. **SEED로 바꾸고 Tailwind도 지금 제거** — 도구가 하나라 단순하다. / 모든 화면을 다시 써야 해 시연 전 위험이 크고 PR이 커진다.
3. **shadcn 유지 + 색·글꼴만 디자인 토큰으로** — 지금 코드를 거의 안 건드린다. / 부품 모양·상태 표현이 디자인과 계속 어긋나고, 디자인 쪽 부품 목록을 우리가 직접 만들어야 한다.

## 결정
1번.
- **SEED Design 3.4.0**(`@seed-design/react`·`@seed-design/css`, 버전 고정)과 **Pretendard 1.3.9**를 쓴다. 밝은 모드만(`data-seed-color-mode="light-only"`).
- **색은 `apps/web/src/styles/tokens.css`의 역할 토큰에서만 정한다.** SEED 브랜드(당근 주황)는 SEED 자체 보라 단계로 돌린다(여덟 줄). 화면 코드에 색 값을 직접 쓰지 않는다.
- **Tailwind는 배치 전용**(flex·grid·간격·크기·위치). 색 클래스는 역할 토큰 이름(`bg-paper`, `text-ink-soft`, `bg-brand-weak` …)만 쓴다.
- **CSS 층 순서**: `theme, base, seed-base, components, seed-components, utilities`. 이 선언(`styles/layers.css`)을 앱에서 **가장 먼저** 불러온다 — 층 순서는 처음 나온 선언이 정하므로, SEED 부품 CSS가 먼저 들어오면 SEED 부품이 맨 아래 층이 되어 Tailwind 기본 스타일에 덮인다.
- **SEED는 층 있는 판만**: `@seed-design/react` 부품은 자기 레시피 CSS를 스스로 불러온다. 패키지 기본 판은 층 없는 CSS라 모든 층을 이기므로, Vite `resolve.conditions`에 `seed-layered`를 넣어 층 있는 판(`@layer seed-components`)을 고른다.
- **레시피는 쓰는 것만 실린다**: 레시피를 우리가 따로 불러오지 않는다. 패키지가 CSS만 부수 효과로 표시(`sideEffects: *.css`)해서, 빌드에는 실제로 쓴 부품의 레시피만 남는다(개발 서버는 전부 내려받음). 글꼴은 빌드에 함께 싣고 외부에서 받지 않는다.
- **shadcn·radix·lucide는 화면을 옮길 때마다 뺀다.** 그동안은 shadcn 색 변수를 SEED 역할 토큰으로 이어 아직 안 옮긴 화면도 같은 브랜드로 보이게 한다. 마지막 화면을 옮기는 PR에서 `components/ui/button.tsx`·`radix-ui`·`class-variance-authority`·`lucide-react`를 지운다.
- 새 화면(예약 넣기·설정 등)은 처음부터 SEED로 만든다.

## 옮기기 체크리스트
shadcn이 남은 화면을 SEED로 옮길 때마다 체크한다. 모두 끝나면 마지막 PR에서 아래 "정리"를 한다.
- [x] 웹셸(`AppShell`) — 이 ADR의 기반 PR
- [ ] 캘린더 W1·W2(`pages/calendar/*`) — 예약 칸 하늘색을 `--cal-*` 토큰으로
- [ ] 로그인 W0(`LoginPage`) — 카카오 버튼 규칙
- [ ] 설정 W13(`SettingsPage`)
- [ ] 고객 W5·W6(`pages/customers/*`)
- [ ] 공통 상태 화면(`components/states/DataState`)
- [ ] 정리: `components/ui/button.tsx`, `radix-ui`·`class-variance-authority`·`lucide-react`·`tw-animate-css`·`shadcn/tailwind.css` 삭제, `index.css`의 shadcn 색 변수 블록 삭제

## 결과
- 좋아지는 점: 디자인 부품·톤을 그대로 써서 화면별 디자인 검수가 쉬워진다. 브랜드 색을 한 파일에서 바꿀 수 있다. 기존 화면을 멈추지 않고 하나씩 옮길 수 있다.
- 감수하는 점: 옮기는 동안 shadcn과 SEED가 같이 있다. 앱에 SEED 기본 CSS와 글꼴(동적 서브셋)이 늘어난다.
- 되돌리는 비용: 기반 PR만 들어간 상태면 낮다(토큰·불러오기·웹셸). 화면을 SEED 부품으로 옮길수록 커진다.
- 재검토 조건: SEED 4.x로 올릴 때(레시피·토큰 이름 변경), 레이어 충돌로 Tailwind 배치가 깨질 때, 다크 모드가 요구될 때.
