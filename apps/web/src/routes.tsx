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
import { HoursPage } from '@/pages/settings/HoursPage';
import { MenusPage } from '@/pages/settings/MenusPage';
import { StaffPage } from '@/pages/settings/StaffPage';
import { SettingsPage } from '@/pages/settings/SettingsPage';

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
      { path: 'settings', element: <SettingsPage /> },
      { path: 'settings/hours', element: <HoursPage /> },
      { path: 'settings/closures', element: <ClosuresPage /> },
      { path: 'settings/menus', element: <MenusPage /> },
      { path: 'settings/staff', element: <StaffPage /> },
      { path: '*', element: <EmptyState title="없는 화면이에요" /> },
    ],
  },
];
