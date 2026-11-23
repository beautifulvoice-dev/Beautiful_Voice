import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(cleanup);

// jsdom에는 ResizeObserver가 없다 — SEED 부품(SegmentedControl 표시 막대 등)이 크기를 잴 때 쓴다. 테스트에서는 아무것도 안 하는 판으로.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= NoopResizeObserver as unknown as typeof ResizeObserver;

// jsdom에는 matchMedia가 없다 — SEED 너비 판정(useBreakpoint·ResponsiveSidePanel)이 쓴다.
// 화면 너비는 setTestWidth(폭)으로 바꾼다. 기본은 매장 노트북 1280px(웹 배치).
// 테스트 파일에서 이 파일을 다시 import해도 같은 값을 보도록 globalThis에 둔다.
const state = globalThis as typeof globalThis & { __testWidth?: number; __mediaListeners?: Set<() => void> };
state.__testWidth = 1280;
state.__mediaListeners ??= new Set();
/** 화면 폭을 바꾼다. 그려진 화면이 있으면 SEED 너비 판정에 바뀜을 알린다(테스트 안에서는 act로 감싼다). */
export function setTestWidth(width: number) {
  state.__testWidth = width;
  for (const fn of state.__mediaListeners!) fn();
}
afterEach(() => {
  state.__testWidth = 1280;
});
globalThis.matchMedia ??= ((query: string) => {
  const min = Number(/min-width:\s*(\d+)px/.exec(query)?.[1] ?? 0);
  const wrappers = new Map<unknown, () => void>();
  return {
    get matches() {
      return (state.__testWidth ?? 1280) >= min;
    },
    media: query,
    onchange: null,
    // 듣는 쪽이 e.matches를 읽는다(SEED SideNavigation 접기) — 이 질의 기준 값을 담아 부른다.
    addEventListener(_type: string, fn: (e: { matches: boolean; media: string }) => void) {
      const wrapped = () => fn({ matches: (state.__testWidth ?? 1280) >= min, media: query });
      wrappers.set(fn, wrapped);
      state.__mediaListeners!.add(wrapped);
    },
    removeEventListener(_type: string, fn: () => void) {
      const wrapped = wrappers.get(fn);
      if (wrapped) state.__mediaListeners!.delete(wrapped);
      wrappers.delete(fn);
    },
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  } as unknown as MediaQueryList;
}) as typeof matchMedia;

// jsdom에는 포인터 캡처가 없다 — SEED 시트(react-drawer)가 시트 안을 누를 때 setPointerCapture를 부른다.
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.hasPointerCapture ??= () => false;
