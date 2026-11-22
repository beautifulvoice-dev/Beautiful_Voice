// 폰·웹에서 "부품 자체가 다른" 곳만 여기서 가른다(캘린더 PR 2 설계 D4). 배치 차이는 CSS(md:·lg:)로 한다.
// 기준은 SEED와 같은 md = 768px(@seed-design/css/breakpoints) — ResponsiveSidePanel도 같은 기준으로 시트·패널을 바꾼다.
import { useBreakpoint } from '@seed-design/react';

/** 768px 미만(폰)인가. */
export function useIsPhone(): boolean {
  const bp = useBreakpoint();
  return bp === 'base' || bp === 'sm';
}
