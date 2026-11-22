// 화면 설계서 §9.1: 가장 작은 글자 14px(본문 16px, 배지는 SEED Badge large + 14px).
// 화면 코드에 14px보다 작은 글자 지정이 다시 들어오지 않게 소스를 훑는다(Tailwind 글자 크기 클래스·CSS font-size).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// jsdom 환경이라 import.meta.url이 file:이 아니다 — vitest가 넣어 주는 __dirname을 쓴다.
const SRC = join(__dirname, '../src');
const MIN_PX = 14;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(tsx?|css)$/.test(name) ? [p] : [];
  });
}

/** 한 파일에서 14px보다 작은 글자 지정을 "줄: 찾은 글자"로 돌려준다. */
export function smallFonts(text: string): string[] {
  const found: string[] = [];
  text.split('\n').forEach((line, i) => {
    const hits = [
      ...line.matchAll(/\btext-(?:xs|2xs)\b/g),
      ...[...line.matchAll(/\btext-\[(\d+(?:\.\d+)?)px\]/g)].filter((m) => Number(m[1]) < MIN_PX),
      ...[...line.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].filter((m) => Number(m[1]) < MIN_PX),
      ...[...line.matchAll(/font-size:\s*(\d*\.\d+|\d+)rem/g)].filter((m) => Number(m[1]) * 16 < MIN_PX),
    ];
    for (const m of hits) found.push(`${i + 1}: ${m[0]}`);
  });
  return found;
}

describe('가장 작은 글자 14px(설계서 §9.1)', () => {
  it('검사 규칙: 12·13px·text-xs·0.75rem은 잡고 14px·text-sm은 통과', () => {
    expect(smallFonts("cn('text-xs', 'text-[13px]', 'text-[14px] text-sm')")).toEqual(['1: text-xs', '1: text-[13px]']);
    expect(smallFonts('.a { font-size: 12px; }\n.b { font-size: 0.75rem; }\n.c { font-size: 14px; }')).toEqual([
      '1: font-size: 12px',
      '2: font-size: 0.75rem',
    ]);
  });

  it('apps/web/src에 14px보다 작은 글자 지정이 없다', () => {
    const all = files(SRC);
    expect(all.length).toBeGreaterThan(20); // 경로가 틀려 아무것도 안 훑는 일이 없게
    const bad = all.flatMap((f) => smallFonts(readFileSync(f, 'utf8')).map((hit) => `${relative(SRC, f)}:${hit}`));
    expect(bad).toEqual([]);
  });
});
