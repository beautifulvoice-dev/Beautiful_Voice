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
