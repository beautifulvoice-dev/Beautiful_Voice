// 캘린더의 시트 틀: 폰은 아래 시트(BottomSheet, 손잡이·뒤 어둡게), 웹은 오른쪽 패널(SidePanel) — SEED ResponsiveSidePanel이 md(768px)에서 바꾼다.
// 웹 패널은 격자를 가리지 않도록 모달이 아니게 열고, 캘린더 화면이 패널만큼 오른쪽을 비운다(CalendarPage).
// 안쪽 간격은 디자인 HTML(.sheet-h·.sheet-b·.sheet-f / .panel-h·.panel-b·.panel-f) 값.
import { ResponsiveSidePanel } from '@seed-design/react';
import type { ReactNode } from 'react';
import { useIsPhone } from '@/lib/useLayout';
import { cn } from '@/lib/utils';

/** 웹 패널 폭(디자인 .panel 400px). 캘린더 화면이 이만큼 오른쪽을 비운다. */
export const PANEL_WIDTH = 400;

interface Props {
  open: boolean;
  onClose: () => void;
  /** 폰에서 화면 위 52px까지 채우는 큰 시트(디자인 .sheet.full — 예약 넣기). */
  full?: boolean;
  children: ReactNode;
}

export function CalendarSheet({ open, onClose, full = false, children }: Props) {
  const phone = useIsPhone();
  return (
    <ResponsiveSidePanel.Root
      open={open}
      onOpenChange={(o) => !o && onClose()}
      sidePanelRootProps={{ modal: false, closeOnInteractOutside: false }}
    >
      {/* 폰 시트만 뒤를 어둡게 — 웹 패널은 격자를 보며 쓰므로 배경막 없음 */}
      {phone && <ResponsiveSidePanel.Backdrop />}
      <ResponsiveSidePanel.Positioner>
        <ResponsiveSidePanel.Content
          width={`${PANEL_WIDTH}px`}
          maxWidth="full"
          className={cn(phone && 'rounded-t-[22px]', phone && full && 'h-[calc(100dvh-52px)]')}
        >
          {phone && <ResponsiveSidePanel.Handle />}
          {children}
        </ResponsiveSidePanel.Content>
      </ResponsiveSidePanel.Positioner>
    </ResponsiveSidePanel.Root>
  );
}

/** 머리: 폰 12/20/6, 웹 20/24/8. 제목(ResponsiveSidePanel.Title)의 SEED 좌우 여백은 titleClass로 지운다. */
export const titleClass = 'px-0';
export const sheetHeadClass = (phone: boolean) =>
  phone ? 'grid w-full grid-cols-1 gap-1 px-5 pt-3 pb-1.5' : 'grid w-full grid-cols-1 gap-1.5 px-6 pt-5 pb-2';
/** 몸: 폰 10/20, 웹 8/24, 사이 16. */
export const sheetBodyClass = (phone: boolean) =>
  cn('grid min-h-0 flex-1 content-start gap-4 overflow-y-auto', phone ? 'px-5 py-2.5' : 'px-6 py-2');
/** 발: 폰 10/20/28, 웹 16/24/24 + 위 선. */
export const sheetFootClass = (phone: boolean) =>
  cn('flex flex-none flex-wrap gap-2', phone ? 'px-5 pt-2.5 pb-7' : 'border-t border-line px-6 pt-4 pb-6');
