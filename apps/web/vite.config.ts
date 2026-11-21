import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defaultClientConditions } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    // SEED 레시피의 "층 있는 판"(@layer seed-components)을 고른다. 기본 판은 층 없는 CSS라 Tailwind 층 순서를 무시하고
    // 모든 층을 이긴다(ADR-0008 층 순서가 깨짐). 쓰는 부품의 레시피만 빌드에 남는다(패키지 sideEffects: *.css).
    conditions: ['seed-layered', ...defaultClientConditions],
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    // SEED 패키지는 Node가 바로 읽지 못하는 레시피 경로를 쓴다 → Vite가 풀어서 테스트에 넣는다(ADR-0008).
    server: { deps: { inline: [/@seed-design\//] } },
  },
});
