// 매장 링크 칸의 글 ↔ 저장 값. 계약은 http·https 주소만 받는다(#42 ShopInfo.WebLink).
// ASSUMPTION: 디자인(W13)은 "naver.me/…", "@아이디"처럼 짧게 적는다 — 원장이 그렇게 적어도 저장할 수 있게 주소로 바꾸고, 보일 때는 다시 짧게 줄인다.
// 이 바꾸기는 화면 편의일 뿐 검사는 서버와 같은 validateShopInfo가 한다(절대 규칙 4).

const INSTAGRAM = 'https://www.instagram.com/';

/** 칸 글 → 저장 값. 비우면 null. 주소 모양이 아니면 그대로 넘겨 공용 검사가 이유와 함께 거부하게 한다. */
export function toWebLink(text: string, kind: 'instagram' | 'web' = 'web'): string | null {
  const t = text.trim();
  if (t === '') return null;
  if (/^https?:\/\//iu.test(t)) return t;
  if (kind === 'instagram' && /^@?[A-Za-z0-9._]+$/u.test(t)) return `${INSTAGRAM}${t.replace(/^@/u, '')}`;
  if (/^[^\s/]+\.[^\s]+$/u.test(t)) return `https://${t}`;
  return t;
}

/** 저장 값 → 칸 글. https:// 는 떼고, 인스타그램 주소는 "@아이디"로. */
export function fromWebLink(url: string | null, kind: 'instagram' | 'web' = 'web'): string {
  if (url === null) return '';
  if (kind === 'instagram' && url.startsWith(INSTAGRAM)) return `@${url.slice(INSTAGRAM.length).replace(/\/$/u, '')}`;
  return url.replace(/^https:\/\//u, '');
}
