// 웹셸: 모든 화면이 공유하는 틀 (P2-01, 분해표 C-10).
// 스마트폰은 하단 탭, 노트북(md 이상)은 왼쪽 메뉴. 각 화면은 <Outlet />에 들어온다.
import { CalendarDays, Settings, Users } from 'lucide-react';
import { NavLink, Outlet } from 'react-router';
import { cn } from '@/lib/utils';

// 메뉴 구성: 11/19 명세 M1 기준. 매출 화면은 어느 모듈에도 없어 뺐다(명세 3 §1).
// ASSUMPTION: 기록 검색(SRC-1~3)은 메뉴가 아니라 고객 화면 안에 둔다 — 명세에 위치가 없다(C-09에서 확정).
export const NAV_ITEMS = [
  { to: '/calendar', label: '캘린더', icon: CalendarDays },
  { to: '/customers', label: '고객', icon: Users },
  { to: '/settings', label: '설정', icon: Settings },
] as const;

export function AppShell() {
  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <nav
        aria-label="주 메뉴"
        className="fixed inset-x-0 bottom-0 z-10 border-t bg-background pb-[env(safe-area-inset-bottom)] md:static md:w-48 md:border-t-0 md:border-r md:pb-0"
      >
        <p className="hidden px-4 py-5 font-semibold md:block">BeautifulVoice</p>
        <ul className="grid grid-cols-3 md:grid-cols-1 md:gap-1 md:px-2">
          {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
            <li key={to}>
              <NavLink
                to={to}
                className={({ isActive }) =>
                  cn(
                    'flex flex-col items-center gap-1 py-2 text-xs text-muted-foreground md:flex-row md:gap-3 md:rounded-md md:px-3 md:text-sm',
                    isActive && 'font-semibold text-foreground md:bg-accent',
                  )
                }
              >
                <Icon aria-hidden className="size-5" />
                {label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <main className="flex-1 pb-20 md:pb-0">
        <Outlet />
      </main>
    </div>
  );
}
