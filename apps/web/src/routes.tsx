import { Navigate, type RouteObject } from 'react-router';
import { AppShell } from '@/components/layout/AppShell';
import { EmptyState } from '@/components/states/DataState';
import { PlaceholderPage } from '@/pages/PlaceholderPage';
import { SettingsPage } from '@/pages/SettingsPage';

export const routes: RouteObject[] = [
  {
    element: <AppShell />,
    children: [
      // ASSUMPTION: 첫 화면은 캘린더 — 명세서(11/19)로 확인.
      { index: true, element: <Navigate to="/calendar" replace /> },
      { path: 'customers', element: <PlaceholderPage title="고객" /> },
      { path: 'calendar', element: <PlaceholderPage title="캘린더" /> },
      { path: 'records', element: <PlaceholderPage title="기록" /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: '*', element: <EmptyState title="없는 화면이에요" /> },
    ],
  },
];
