// 설정 첫 화면(W13, BEA-166·167): 항목 목록 → 누르면 항목별 화면. SEED 부품으로 만든다(ADR-0008).
// ASSUMPTION(해나 11/21 결정): 폰은 한 화면에 다 펼치지 않고 목록 → 하위 화면. 웹은 카본 W13대로 왼쪽 내비 + 오른쪽 내용(11/22 옵마).
// 설정은 사람만 바꾼다. AI 실행기에는 설정 쓰기 권한이 없다(결정 R0).
import { List, SideNavigation } from '@seed-design/react';
import { useCallback } from 'react';
import { Link, Outlet, useLocation, useOutletContext } from 'react-router';
import { useShopName } from '@/components/layout/AppShell';
import { shopToday } from '@/features/customers/model';
import { useSettingsApi } from '@/features/settings/api';
import { closuresSummary } from '@/features/settings/closures';
import { hoursSummary, weeklyDaysOf } from '@/features/settings/hours';
import { useIsPhone } from '@/lib/useLayout';
import { useLoad } from '@/lib/useLoad';
import { ShopInfoPage } from './ShopInfoPage';

interface Entry {
  title: string;
  /** 없으면 M1 밖 화면 — 누를 수 없고 "곧 열려요"로 보인다. */
  to?: string;
  detail?: string;
}

/** 설정 항목(카본 W13 순서). 영업시간은 매장 정보 안에서 연다. */
function useEntries(): Entry[] {
  const api = useSettingsApi();
  const load = useCallback(
    () => Promise.all([api.getBusinessHours(), api.listClosures(), api.listMenus(), api.listStaff()]),
    [api],
  );
  const { state } = useLoad(load);
  // 요약을 못 불러와도 목록은 보인다 — 들어가서 다시 불러올 수 있다.
  const [hours, closures, menus, staff] = state.status === 'ok' ? state.data : [];
  const hoursDetail = state.status === 'ok' ? `영업시간 ${hoursSummary(hours ?? null, weeklyDaysOf(closures ?? []))}` : undefined;
  return [
    { title: '매장 정보', to: '/settings/shop-info', detail: hoursDetail },
    { title: '휴무·휴가', to: '/settings/closures', detail: closures ? closuresSummary(closures, shopToday()) : undefined },
    { title: '메뉴', to: '/settings/menus', detail: menus ? (menus.length ? `${menus.length}개` : '없음') : undefined },
    // W13 디자인 요약: 사용 중인 담당자 이름(예: "박원장, 이실장").
    { title: '담당자', to: '/settings/staff', detail: staff ? staff.map((s) => s.name).join(', ') || '없음' : undefined },
    // ASSUMPTION: M1 밖 항목은 자리만(AI 반영 방식 M5·문자 양식 M3·마이크 Phase 1 연동·내 정보) — 이번 범위 밖, 다음 스프린트.
    ...['AI 반영 방식', '문자 양식', '마이크', '내 정보'].map((title) => ({ title })),
  ];
}

/** 설정 칸(W13): 폰은 목록 → 하위 화면, 웹(≥768)은 왼쪽 SEED SideNavigation + 오른쪽 내용. */
export function SettingsLayout() {
  const phone = useIsPhone();
  // 셸이 넘긴 매장 이름 등을 하위 화면에 그대로 전한다(useShopName).
  const context = useOutletContext();
  if (phone) return <Outlet context={context} />;
  return (
    <div className="flex items-start gap-8 p-6">
      <SettingsNav />
      <div className="min-w-0 max-w-2xl flex-1">
        <Outlet context={context} />
      </div>
    </div>
  );
}

/** /settings: 폰은 항목 목록, 웹은 첫 항목(매장 정보)을 오른쪽에 연다. */
export function SettingsPage() {
  return useIsPhone() ? <SettingsList /> : <ShopInfoPage />;
}

function SettingsNav() {
  const entries = useEntries();
  const shopName = useShopName();
  const { pathname } = useLocation();
  const current = (to: string) => pathname === to || (to === '/settings/shop-info' && (pathname === '/settings' || pathname === '/settings/hours'));
  return (
    <SideNavigation.Provider>
      <SideNavigation.Root aria-label="설정 항목" className="w-60 shrink-0">
        <SideNavigation.Header>
          <p className="text-sm font-bold text-ink-soft">{shopName}</p>
          <p className="text-xl font-semibold text-ink">설정</p>
        </SideNavigation.Header>
        <SideNavigation.Content>
          <SideNavigation.Group>
            {entries.map((e) =>
              e.to ? (
                <SideNavigation.Item key={e.title} asChild current={current(e.to)}>
                  <Link to={e.to}>
                    <SideNavigation.ItemLabel>{e.title}</SideNavigation.ItemLabel>
                  </Link>
                </SideNavigation.Item>
              ) : (
                <SideNavigation.Item key={e.title} disabled>
                  <SideNavigation.ItemLabel>
                    {e.title} <span className="text-sm">· 곧 열려요</span>
                  </SideNavigation.ItemLabel>
                </SideNavigation.Item>
              ),
            )}
          </SideNavigation.Group>
        </SideNavigation.Content>
      </SideNavigation.Root>
    </SideNavigation.Provider>
  );
}

function SettingsList() {
  const entries = useEntries();
  const shopName = useShopName();
  return (
    <div className="flex flex-col gap-2 pt-6">
      <div className="px-4">
        <p className="text-sm font-bold text-ink-soft">{shopName}</p>
        <h1 className="text-xl font-semibold text-ink">설정</h1>
      </div>
      <List.Root aria-label="설정 항목">
        {entries.map((e) => (
          <li key={e.title}>
            {e.to ? (
              <List.Item asChild>
                <Link to={e.to}>
                  <List.Content>
                    <List.Title>{e.title}</List.Title>
                  </List.Content>
                  <List.Suffix>
                    {e.detail && <span>{e.detail}</span>}
                    <span aria-hidden>›</span>
                  </List.Suffix>
                </Link>
              </List.Item>
            ) : (
              <List.Item asChild aria-disabled="true">
                <div>
                  <List.Content>
                    <List.Title className="text-ink-soft">{e.title}</List.Title>
                  </List.Content>
                  <List.Suffix>곧 열려요</List.Suffix>
                </div>
              </List.Item>
            )}
          </li>
        ))}
      </List.Root>
    </div>
  );
}
