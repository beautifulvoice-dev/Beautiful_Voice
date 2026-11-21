// 좌우로 밀기(폰). 폰 캘린더는 디자인에 ‹ › 버튼이 없어 7일 띠·달력을 밀어 이전·다음 주(달)로 간다(11/21 옵마 결정).
import { useRef, type TouchEvent } from 'react';

/** 가로로 48px 넘게, 세로보다 크게 밀면 왼쪽 밀기 = 다음(+1), 오른쪽 밀기 = 이전(−1). */
export function useSwipe(onStep: (n: 1 | -1) => void) {
  const start = useRef<{ x: number; y: number } | null>(null);
  return {
    onTouchStart: (e: TouchEvent) => {
      const t = e.touches[0];
      start.current = t ? { x: t.clientX, y: t.clientY } : null;
    },
    onTouchEnd: (e: TouchEvent) => {
      const s = start.current;
      const t = e.changedTouches[0];
      start.current = null;
      if (!s || !t) return;
      const dx = t.clientX - s.x;
      if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(t.clientY - s.y)) onStep(dx < 0 ? 1 : -1);
    },
  };
}
