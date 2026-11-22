// 설정(W13, BEA-166·167). 디자인(11/20 인계 w13.png): 폰은 목록 → 하위 화면, 웹은 왼쪽 메뉴 + 오른쪽 내용.
// 설정은 사람만 바꾼다. AI 실행기에는 설정 쓰기 권한이 없다(결정 R0).
// ASSUMPTION: 디자인 목록의 AI 반영 방식·문자 양식·마이크·내 정보·로그아웃은 아직 화면·API가 없어 넣지 않는다
// ("쓰지 않는 기능은 화면에 두지 않는다" 원칙). 만들 때 SETTINGS_SECTIONS에 한 줄씩 더한다. 매장 이름·매장 전환은 앱 틀(#64) 몫.
import { List, useBreakpointValue } from '@seed-design/react';
import { useCallback } from 'react';
import { Link, Navigate, NavLink, Outlet, useLocation } from 'react-router';
import { shopToday } from '@/features/customers/model';
import { useSettingsApi } from '@/features/settings/api';
import { closuresSummary } from '@/features/settings/closures';
import { hoursSummary, weeklyDaysOf } from '@/features/settings/hours';
import { useLoad } from '@/lib/useLoad';
import { PhoneShopName } from '@/components/layout/PhoneShopName';

/** 설정 하위 화면. 폰 목록과 웹 왼쪽 메뉴가 같은 순서를 쓴다(디자인 순서). */
export const SETTINGS_SECTIONS = [
  { title: '영업시간', to: '/settings/hours' },
  { title: '휴무·휴가', to: '/settings/closures' },
  { title: '메뉴', to: '/settings/menus' },
  { title: '담당자', to: '/settings/staff' },
] as const;

/** 웹 = SEED md(768px) 이상. 그보다 좁으면 폰 배치. */
const useIsWeb = () => useBreakpointValue({ base: false, md: true }) ?? false;

/** /settings 아래 모든 화면의 틀. 웹에서는 왼쪽 메뉴를 늘 보인다. */
export function SettingsLayout() {
  const isWeb = useIsWeb();
  if (!isWeb) return <Outlet />;
  return (
    <div className="grid grid-cols-[12rem_minmax(0,1fr)] gap-8 px-6">
      {/* ASSUMPTION: SEED SideNavigation은 앱 전체 사이드바(접기·고정 위치)용이라, 설정 안 메뉴는 같은 모양의 링크 목록으로 둔다. */}
      <nav aria-label="설정 메뉴" className="pt-6">
        <ul className="flex flex-col gap-1">
          {SETTINGS_SECTIONS.map((s) => (
            <li key={s.to}>
              <NavLink
                to={s.to}
                className={({ isActive }) =>
                  `block rounded-md px-3 py-2 text-base ${isActive ? 'bg-brand-weak font-semibold text-ink' : 'text-ink-soft hover:bg-neutral-weak'}`
                }
              >
                {s.title}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <Outlet />
    </div>
  );
}

/** /settings 첫 화면. 폰은 항목 목록, 웹은 첫 항목을 바로 연다(왼쪽 메뉴가 목록 역할). */
export function SettingsPage() {
  const isWeb = useIsWeb();
  const { pathname } = useLocation();
  if (isWeb && pathname === '/settings') return <Navigate to={SETTINGS_SECTIONS[0].to} replace />;
  return <SettingsList />;
}

function SettingsList() {
  const api = useSettingsApi();
  const load = useCallback(
    () => Promise.all([api.getBusinessHours(), api.listClosures(), api.listMenus(), api.listStaff()]),
    [api],
  );
  const { state } = useLoad(load);
  // 요약을 못 불러와도 목록은 보인다 — 들어가서 다시 불러올 수 있다.
  const [hours, closures, menus, staff] = state.status === 'ok' ? state.data : [];
  // 요약은 디자인 목록 줄 아래 회색 글자(w13.png): "10:00–20:00 · 수요일 정기 휴무", "다음 휴가 12/24–12/26", "4개", "박원장, 이실장".
  const details: Record<(typeof SETTINGS_SECTIONS)[number]['to'], string | undefined> = {
    '/settings/hours': state.status === 'ok' ? hoursSummary(hours ?? null, weeklyDaysOf(closures ?? [])) : undefined,
    '/settings/closures': closures ? closuresSummary(closures, shopToday()) : undefined,
    '/settings/menus': menus ? (menus.length ? `${menus.length}개` : '없음') : undefined,
    '/settings/staff': staff ? staff.map((s) => s.name).join(', ') || '없음' : undefined,
  };

  return (
    <div className="flex flex-col gap-2 pt-6">
      <div className="px-4">
        <PhoneShopName />
        <h1 className="text-2xl font-bold text-ink">설정</h1>
      </div>
      <List.Root aria-label="설정 항목">
        {SETTINGS_SECTIONS.map((s) => (
          <li key={s.to} className="border-b border-line last:border-b-0">
            <List.Item asChild>
              <Link to={s.to}>
                <List.Content>
                  <List.Title className="font-semibold">{s.title}</List.Title>
                  {details[s.to] && <List.Detail>{details[s.to]}</List.Detail>}
                </List.Content>
                <List.Suffix>
                  <span aria-hidden className="text-lg">
                    ›
                  </span>
                </List.Suffix>
              </Link>
            </List.Item>
          </li>
        ))}
      </List.Root>
    </div>
  );
}
