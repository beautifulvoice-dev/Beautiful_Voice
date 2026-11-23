// 매장 정보(W13) 링크 입력 보완. 계약(#42)은 http(s) 주소만 저장한다 — 원장이 디자인 예시처럼 `naver.me/abc`·`@raon.beauty`를
// 넣으면 화면에서 https:// 주소로 바꿔 보낸다(11/22 옵마 결정: 자동 보완). 저장된 주소를 칸에 다시 보여 준다.
import type { ShopInfo } from '@bv/contracts';

export type LinkField = 'naverPlaceUrl' | 'instagramUrl' | 'landingUrl';

const SCHEME = /^https?:\/\//i;

/** 빈 칸은 null. `@아이디`(인스타그램 칸)는 instagram.com 주소로, 그 밖에 주소 앞부분이 없으면 https://를 붙인다. */
export function completeLink(field: LinkField, raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  if (SCHEME.test(text)) return text;
  if (field === 'instagramUrl' && text.startsWith('@')) return `https://instagram.com/${text.slice(1)}`;
  return `https://${text.replace(/^\/+/, '')}`;
}

export const SHOP_INFO_LABEL: Record<keyof ShopInfo, string> = {
  locationText: '위치',
  naverPlaceUrl: '네이버 플레이스',
  instagramUrl: '인스타그램',
  landingUrl: '홈페이지',
  refundPolicy: '환불 정책',
};

export const SHOP_INFO_ERROR: Record<string, string> = {
  INVALID_URL: '주소를 확인해 주세요. 예: naver.me/abc, @아이디',
  INVALID_TEXT: '글자를 확인해 주세요.',
};
