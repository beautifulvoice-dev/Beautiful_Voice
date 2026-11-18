import { Navigate, type RouteObject } from 'react-router';
import { AppShell } from '@/components/layout/AppShell';
import { EmptyState } from '@/components/states/DataState';
import { PlaceholderPage } from '@/pages/PlaceholderPage';
import { SettingsPage } from '@/pages/SettingsPage';

export const routes: RouteObject[] = [
  {
    element: <AppShell />,
    children: [
      // ASSUMPTION: 첫 화면은 메뉴 첫 칸인 캘린더 — 와이어프레임(11/21)으로 확인.
      { index: true, element: <Navigate to="/calendar" replace /> },
      { path: 'calendar', element: <PlaceholderPage title="캘린더" /> },
      { path: 'customers', element: <PlaceholderPage title="고객" /> },
      { path: 'revenue', element: <PlaceholderPage title="매출" /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: '*', element: <EmptyState title="없는 화면이에요" /> },
    ],
  },
];
