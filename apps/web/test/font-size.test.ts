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

/**
 * 14px 예외는 이것 하나뿐(카본 11/22 B안 승인): 캘린더 주 보기의 작은 칸 12px.
 * WeekView.tsx의 SMALL_CARD_TEXT·SMALL_CARD_BADGE 두 상수 줄만 허용한다 — 같은 파일의 다른 줄이나 다른 파일의 12px는 계속 실패.
 */
export const SMALL_FONT_EXCEPTIONS: readonly { file: string; line: RegExp }[] = [
  { file: join('pages', 'calendar', 'WeekView.tsx'), line: /^const SMALL_CARD_(TEXT|BADGE) = / },
];

/** 한 파일에서 14px보다 작은 글자 지정을 "줄: 찾은 글자"로 돌려준다. file(src 기준 경로)을 주면 예외 줄은 뺀다. */
export function smallFonts(text: string, file?: string): string[] {
  const found: string[] = [];
  const allowed = SMALL_FONT_EXCEPTIONS.filter((e) => e.file === file);
  text.split('\n').forEach((line, i) => {
    if (allowed.some((e) => e.line.test(line))) return;
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

  it('예외는 WeekView의 작은 칸 상수 두 줄뿐 — 같은 파일 다른 줄·다른 파일의 12px는 잡는다', () => {
    const file = join('pages', 'calendar', 'WeekView.tsx');
    const ok = "const SMALL_CARD_TEXT = 'text-xs leading-[15px]';\nconst SMALL_CARD_BADGE = '!text-xs !leading-[15px]';";
    expect(smallFonts(ok, file)).toEqual([]);
    expect(smallFonts("<b className='text-xs'>", file)).toEqual(['1: text-xs']);
    expect(smallFonts(ok, join('pages', 'calendar', 'MonthView.tsx'))).toEqual(['1: text-xs', '2: text-xs']);
  });

  it('apps/web/src에 14px보다 작은 글자 지정이 없다(위 예외 하나 빼고)', () => {
    const all = files(SRC);
    expect(all.length).toBeGreaterThan(20); // 경로가 틀려 아무것도 안 훑는 일이 없게
    const bad = all.flatMap((f) => smallFonts(readFileSync(f, 'utf8'), relative(SRC, f)).map((hit) => `${relative(SRC, f)}:${hit}`));
    expect(bad).toEqual([]);
  });
});
