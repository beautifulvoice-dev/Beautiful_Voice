// 매장 링크 칸 ↔ 저장 값(W13 디자인은 "naver.me/…", "@아이디"로 짧게 적는다). 합성 주소만 쓴다.
import { describe, expect, it } from 'vitest';
import { fromWebLink, toWebLink } from '@/features/settings/links';

describe('매장 링크', () => {
  it('짧게 적어도 주소로 바꾼다', () => {
    expect(toWebLink('naver.me/example')).toBe('https://naver.me/example');
    expect(toWebLink('  ')).toBeNull();
    expect(toWebLink('http://example.com')).toBe('http://example.com');
    expect(toWebLink('@example.shop', 'instagram')).toBe('https://www.instagram.com/example.shop');
    expect(toWebLink('example.shop', 'instagram')).toBe('https://www.instagram.com/example.shop');
  });

  it('주소 모양이 아니면 그대로 넘겨 공용 검사가 거부하게 한다', () => {
    expect(toWebLink('우리 홈페이지')).toBe('우리 홈페이지');
    expect(toWebLink('javascript:alert(1)')).toBe('javascript:alert(1)');
  });

  it('보일 때는 https:// 를 떼고 인스타그램은 @아이디로', () => {
    expect(fromWebLink('https://naver.me/example')).toBe('naver.me/example');
    expect(fromWebLink('http://example.com')).toBe('http://example.com');
    expect(fromWebLink('https://www.instagram.com/example.shop/', 'instagram')).toBe('@example.shop');
    expect(fromWebLink(null)).toBe('');
  });
});
