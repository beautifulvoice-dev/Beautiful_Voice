// 관리 불가 시간 보기·지우기(화면 설계서 W4 "저장, 지우기 — 지우기는 확인 시트", BEA-179). 캘린더의 회색 빗금 칸을 누르면 연다.
// 지우면 그 시간에 다시 예약할 수 있고, 겹침 표시가 사라진다(설계 09). 바꾸기(PATCH)는 후속 PR.
import { ActionButton, AlertDialog, Callout, Icon, ResponsiveSidePanel } from '@seed-design/react';
import { X } from 'lucide-react';
import { useState } from 'react';
import { rejectText, shortDate } from '@/features/calendar/bookingText';
import { useCalendarApi } from '@/features/calendar/api';
import { shopDate, shopTime, type CalendarBlock, type CalendarData } from '@/features/calendar/model';
import { useRetryKey } from '@/lib/retryKey';
import { useIsPhone } from '@/lib/useLayout';
import { cn } from '@/lib/utils';
import { CalendarSheet, sheetBodyClass, sheetFootClass, sheetHeadClass, titleClass } from './Sheet';

interface Props {
  block: CalendarBlock | null;
  data: Pick<CalendarData, 'appointments' | 'staff'> | null;
  onClose: () => void;
  /** 지웠다 — 캘린더를 다시 불러온다. 그사이 바뀌었거나 이미 지워졌을 때도 다시 불러온다. */
  onRemoved: (reloadOnly?: boolean) => void;
}

/** "11/24(화) 14:00–16:00", 날을 넘으면 "11/24(화) 22:00–11/25(수) 01:00". */
export function blockPeriodText(b: Pick<CalendarBlock, 'startAt' | 'endAt'>): string {
  const [d1, d2] = [shopDate(Date.parse(b.startAt)), shopDate(Date.parse(b.endAt) - 1)];
  return d1 === d2
    ? `${shortDate(d1)} ${shopTime(b.startAt)}–${shopTime(b.endAt)}`
    : `${shortDate(d1)} ${shopTime(b.startAt)}–${shortDate(shopDate(Date.parse(b.endAt)))} ${shopTime(b.endAt)}`;
}

export function BlockPanel({ block, data, onClose, onRemoved }: Props) {
  return (
    <CalendarSheet open={block !== null} onClose={onClose}>
      {block && <Body key={block.id} b={block} data={data} onClose={onClose} onRemoved={onRemoved} />}
    </CalendarSheet>
  );
}

function Body({ b, data, onClose, onRemoved }: { b: CalendarBlock; data: Props['data']; onClose: () => void; onRemoved: Props['onRemoved'] }) {
  const api = useCalendarApi();
  const phone = useIsPhone();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRetryKey();
  const who = b.allStaff
    ? '모든 담당자'
    : b.staffIds.map((id) => data?.staff.find((s) => s.id === id)?.name ?? '숨긴 담당자').join(', ');
  // 이 차단과 겹친 예약(서버 blockedBy, 없으면 화면 판정은 캘린더 칸이 이미 보여 준다).
  const overlapped = (data?.appointments ?? []).filter((a) => a.blockedBy?.includes(b.id)).length;

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await api.removeBlock(b.id, b.version, { idempotencyKey: key.keyFor(`${b.id}|${b.version}`) });
    setBusy(false);
    setConfirm(false);
    if (r.ok) {
      key.settle();
      return onRemoved();
    }
    if (r.reason !== 'NETWORK') key.settle();
    if (r.reason === 'NOT_FOUND') {
      // 다른 곳에서 먼저 지웠다 — 원하는 상태라 닫고 다시 불러온다.
      return onRemoved(true);
    }
    if (r.reason === 'VERSION_CONFLICT') onRemoved(true);
    setError(
      r.reason === 'VERSION_CONFLICT'
        ? '그사이 다른 곳에서 이 관리 불가 시간이 바뀌었어요. 다시 불러왔으니 확인해 주세요.'
        : rejectText(r.reason),
    );
  };

  return (
    <>
      <ResponsiveSidePanel.Header className={sheetHeadClass(phone)}>
        <div className="flex items-center justify-between gap-2">
          <ResponsiveSidePanel.Title className={cn(titleClass, 'text-xl font-bold tracking-[-0.02em]')}>관리 불가 시간</ResponsiveSidePanel.Title>
          <ActionButton variant="ghost" size="small" layout="iconOnly" aria-label="닫기" disabled={busy} onClick={onClose}>
            <Icon svg={<X />} />
          </ActionButton>
        </div>
      </ResponsiveSidePanel.Header>
      <ResponsiveSidePanel.Body className={sheetBodyClass(phone)}>
        <b className="text-lg tabular-nums">{blockPeriodText(b)}</b>
        <dl className="m-0 grid grid-cols-[76px_minmax(0,1fr)] gap-x-2.5 gap-y-2 text-[15px]">
          <dt className="text-ink-soft">누구</dt>
          <dd className="m-0">{who}</dd>
          <dt className="text-ink-soft">메모</dt>
          <dd className="m-0">{b.memo ?? '메모 없음'}</dd>
        </dl>
        {overlapped > 0 && (
          <Callout.Root tone="critical">
            <Callout.Content>
              <Callout.Description>이 시간과 겹친 예약이 {overlapped}건 있어요. 예약은 그대로 있어요.</Callout.Description>
            </Callout.Content>
          </Callout.Root>
        )}
        {error && (
          <Callout.Root tone="critical" role="alert">
            <Callout.Content>
              <Callout.Title>지우지 못했어요</Callout.Title>
              <Callout.Description>{error}</Callout.Description>
            </Callout.Content>
          </Callout.Root>
        )}
      </ResponsiveSidePanel.Body>
      <ResponsiveSidePanel.Footer className={sheetFootClass(phone)}>
        <ActionButton variant="neutralWeak" size={phone ? 'large' : 'medium'} flexGrow={1} loading={busy} onClick={() => setConfirm(true)}>
          지우기
        </ActionButton>
      </ResponsiveSidePanel.Footer>
      {/* 지우기는 확인 시트(설계서 W4). 확인 창은 시트 안에 둔다 — 폰 아래 시트 뒤로 가려지지 않게. */}
      <AlertDialog.Root open={confirm} onOpenChange={(o) => !busy && setConfirm(o)}>
        <AlertDialog.Backdrop />
        <AlertDialog.Positioner>
          <AlertDialog.Content>
            <AlertDialog.Header>
              <AlertDialog.Title>{blockPeriodText(b)} 관리 불가 시간을 지울까요?</AlertDialog.Title>
              <AlertDialog.Description>지우면 이 시간에 다시 예약을 넣을 수 있어요.</AlertDialog.Description>
            </AlertDialog.Header>
            <AlertDialog.Footer>
              <AlertDialog.Action asChild>
                <ActionButton variant="neutralWeak" size="large" flexGrow={1} disabled={busy}>
                  그만두기
                </ActionButton>
              </AlertDialog.Action>
              <ActionButton variant="criticalSolid" size="large" flexGrow={1} loading={busy} onClick={remove}>
                지우기
              </ActionButton>
            </AlertDialog.Footer>
          </AlertDialog.Content>
        </AlertDialog.Positioner>
      </AlertDialog.Root>
    </>
  );
}
