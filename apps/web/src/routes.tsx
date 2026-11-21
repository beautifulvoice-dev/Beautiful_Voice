import { Navigate, type RouteObject } from 'react-router';
import { AppShell } from '@/components/layout/AppShell';
import { EmptyState } from '@/components/states/DataState';
import { RequireSession } from '@/features/auth/RequireSession';
import { CalendarPage } from '@/pages/calendar/CalendarPage';
import { LoginPage } from '@/pages/LoginPage';
import { CustomerDetailPage } from '@/pages/customers/CustomerDetailPage';
import { CustomerFormPage } from '@/pages/customers/CustomerFormPage';
import { CustomersPage } from '@/pages/customers/CustomersPage';
import { ClosuresPage } from '@/pages/settings/ClosuresPage';
import { MenusPage } from '@/pages/settings/MenusPage';
import { StaffPage } from '@/pages/settings/StaffPage';
import { SettingsLayout, SettingsPage } from '@/pages/settings/SettingsPage';
import { ShopInfoPage } from '@/pages/settings/ShopInfoPage';

export const routes: RouteObject[] = [
  { path: 'login', element: <LoginPage /> },
  {
    // 로그인한 원장만 매장 화면을 본다 (U-1·U-2, F-04).
    element: (
      <RequireSession>
        <AppShell />
      </RequireSession>
    ),
    children: [
      // ASSUMPTION: 첫 화면은 메뉴 첫 칸인 캘린더 — 와이어프레임(11/21)으로 확인.
      { index: true, element: <Navigate to="/calendar" replace /> },
      { path: 'calendar', element: <CalendarPage /> },
      {
        // 등록은 목록 위 시트(W5 디자인) — /customers/new 로 바로 들어와도 열린다.
        // 같은 화면을 두 주소가 함께 써서, 시트를 열고 닫아도 목록이 새로 만들어지지 않는다.
        path: 'customers',
        element: <CustomersPage />,
        children: [
          { index: true, element: null },
          { path: 'new', element: null },
        ],
      },
      { path: 'customers/:id', element: <CustomerDetailPage /> },
      { path: 'customers/:id/edit', element: <CustomerFormPage /> },
      {
        // 설정 틀: 웹은 왼쪽 메뉴 + 오른쪽 내용, 폰은 목록 → 하위 화면(W13 디자인).
        path: 'settings',
        element: <SettingsLayout />,
        children: [
          { index: true, element: <SettingsPage /> },
          { path: 'shop', element: <ShopInfoPage /> },
          // 예전 주소(영업시간 화면)는 매장 정보로 — 영업시간이 매장 정보 안으로 들어갔다(W13 디자인).
          { path: 'hours', element: <Navigate to="/settings/shop" replace /> },
          { path: 'closures', element: <ClosuresPage /> },
          { path: 'menus', element: <MenusPage /> },
          { path: 'staff', element: <StaffPage /> },
        ],
      },
      { path: '*', element: <EmptyState title="없는 화면이에요" /> },
    ],
  },
];
