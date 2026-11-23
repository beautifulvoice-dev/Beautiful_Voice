// 폰 화면 제목 위 매장 이름(디자인 .p-shop, w5·w13 캡처 "라온 뷰티 성수점"). 웹은 머리줄에 있어서 숨긴다(#64 셸).
// M1은 매장 전환이 없어 이름만 보인다(⌄ 없음, #64와 같음).
import { useShopName } from './AppShell';

export function PhoneShopName() {
  return <p className="text-sm font-semibold text-ink-soft md:hidden">{useShopName()}</p>;
}
