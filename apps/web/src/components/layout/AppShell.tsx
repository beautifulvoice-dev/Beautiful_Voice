// 웹셸: 모든 화면이 공유하는 틀 (P2-01, 화면 설계서 §3.1, ADR-0008 SEED).
// 노트북: 머리줄 왼쪽 브랜드·매장 이름, 가운데 탭. 폰: 위에 브랜드·매장 이름, 아래 탭 바. 각 화면은 <Outlet />에 들어온다.
// 색은 tokens.css 역할(bg-paper, text-ink-soft, text-brand-text …)만, 배치는 Tailwind만 쓴다.
import { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import { BRAND_NAME, BRAND_TAGLINE } from '@/brand';
import { useSession } from '@/features/auth/session';
import { FALLBACK_SHOP_NAME, useShopNameLoader } from '@/features/shop/shopName';
import { cn } from '@/lib/utils';

// 메뉴: M1은 캘린더·고객·설정. 승인함은 M2에서 나타난다(§3.1, 2F-B7). 매출은 어느 모듈에도 없다(명세 3 §1).
// 아이콘 없이 글자만 — 설계서 §9.1은 글자 기호만 쓴다. 아이콘을 쓸지는 화면 옮기기 PR에서 정한다.
export const NAV_ITEMS = [
  { to: '/calendar', label: '캘린더' },
  { to: '/customers', label: '고객' },
  { to: '/settings', label: '설정' },
] as const;

export function AppShell() {
  const shopName = useShopName();
  return (
    <div className="min-h-dvh bg-paper text-ink">
      <header className="sticky top-0 z-30 border-b border-line bg-paper">
        <div className="mx-auto flex h-14 max-w-[1280px] items-center gap-4 px-4">
          <BrandLockup />
          <p className="truncate text-sm text-ink-soft" aria-label="매장">
            {shopName}
          </p>
          <nav
            aria-label="주 메뉴"
            className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-paper pb-[env(safe-area-inset-bottom)] md:static md:mx-auto md:border-t-0 md:pb-0"
          >
            <ul className="grid grid-cols-3 md:flex md:gap-2">
              {NAV_ITEMS.map(({ to, label }) => (
                <li key={to}>
                  <NavLink
                    to={to}
                    className={({ isActive }) =>
                      cn(
                        'flex h-14 items-center justify-center border-t-2 border-transparent px-4 text-sm text-ink-soft md:border-t-0 md:border-b-2',
                        isActive && 'border-brand font-semibold text-brand-text',
                      )
                    }
                  >
                    {label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-[1280px] pb-20 md:pb-0">
        <Outlet />
      </main>
    </div>
  );
}

function BrandLockup() {
  return (
    <p className="flex shrink-0 items-baseline gap-2">
      <span className="text-lg font-bold text-brand-text">{BRAND_NAME}</span>
      <span className="hidden text-sm text-ink-soft sm:inline">{BRAND_TAGLINE}</span>
    </p>
  );
}

/** 매장 이름. 받는 동안·못 받으면 자리 글자 — 이름은 보조 정보라 실패해도 화면을 막지 않는다. */
function useShopName(): string {
  const { shopId } = useSession();
  const load = useShopNameLoader();
  const [name, setName] = useState(FALLBACK_SHOP_NAME);
  const run = useCallback(() => load(shopId), [load, shopId]);
  useEffect(() => {
    let alive = true;
    run().then(
      (n) => alive && setName(n),
      () => alive && setName(FALLBACK_SHOP_NAME),
    );
    return () => {
      alive = false;
    };
  }, [run]);
  return name;
}
