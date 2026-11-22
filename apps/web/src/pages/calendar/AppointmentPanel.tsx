// 예약 보기 W2 (화면 설계서 §5 W2, 디자인 w2.png·phase2-screens.html .panel/.sheet): 폰은 아래 시트, 웹은 오른쪽 패널.
// 예정이면 주 버튼 완료, 보조 노쇼·문자 보내기, 더보기. 완료·노쇼·취소면 상태 고치기 하나(결정 S5).
// 완료·노쇼·상태 고치기는 가짜 저장소에서 실제로 바뀐다(@bv/scheduling changeStatus, 11/21 옵마 결정).
// 문자 보내기(M3)·더보기(바꾸기·예약 취소)는 아직 꺼 둔다.
import { ActionButton, AlertDialog, Icon, PrefixIcon, Badge, Callout, ResponsiveSidePanel } from '@seed-design/react';
import { ChevronRight, Ellipsis, MessageSquare, X } from 'lucide-react';
import { useState } from 'react';
import { shortDate } from '@/features/calendar/bookingText';
import { Link } from 'react-router';
import {
  appointmentPanelTime,
  overlappingBlocks,
  shopDate,
  shopTime,
  STATUS_TEXT,
  type AppointmentStatus,
  type CalendarAppointment,
  type CalendarBlock,
} from '@/features/calendar/model';
import { useIsPhone } from '@/lib/useLayout';
import { cn } from '@/lib/utils';
import { CalendarSheet, sheetBodyClass, sheetFootClass, sheetHeadClass, titleClass } from './Sheet';
import { STATUS_TONE } from './styles';

export { PANEL_WIDTH } from './Sheet';

interface Props {
  appointment: CalendarAppointment | null;
  staffName: string;
  blocks: readonly CalendarBlock[];
  onClose: () => void;
  /** 상태 바꾸기. 실패하면 이유 문구를 돌려준다. */
  onStatus: (a: CalendarAppointment, to: AppointmentStatus) => Promise<string | null>;
}

export function AppointmentPanel({ appointment: a, staffName, blocks, onClose, onStatus }: Props) {
  return (
    <CalendarSheet open={a !== null} onClose={onClose}>
      {a && <Body key={`${a.id}-${a.status}`} a={a} staffName={staffName} blocks={blocks} onStatus={onStatus} />}
    </CalendarSheet>
  );
}

const PHONE_DIGITS = /^(\d{3})(\d{3,4})(\d{4})$/;
const phoneText = (p: string) => p.replace(PHONE_DIGITS, '$1-$2-$3');

function Body({
  a,
  staffName,
  blocks,
  onStatus,
}: {
  a: CalendarAppointment;
  staffName: string;
  blocks: readonly CalendarBlock[];
  onStatus: Props['onStatus'];
}) {
  const phone = useIsPhone();
  const [time, prep] = appointmentPanelTime(a);
  const overlaps = overlappingBlocks(a, blocks);
  const scheduled = a.status === 'scheduled';
  const [fixing, setFixing] = useState(false);
  // 예약 취소는 캘린더에서 빠지므로 한 번 더 묻는다(설계서 W2 확인, 원칙 8 — #68 리뷰).
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const size = phone ? 'large' : 'medium';

  const run = async (to: AppointmentStatus) => {
    setBusy(true);
    setError(await onStatus(a, to));
    setBusy(false);
  };

  const name = (
    <span className="inline-flex items-center gap-1">
      {a.customerName}
      <ChevronRight aria-hidden size={20} strokeWidth={2} />
    </span>
  );

  return (
    <>
      <ResponsiveSidePanel.Header className={sheetHeadClass(phone)}>
        <div className="flex items-center justify-between">
          <span className="flex gap-1.5">
            <Badge.Root tone={STATUS_TONE[a.status] ?? 'neutral'} variant="weak" size="large">
              <Badge.Label>{STATUS_TEXT[a.status]}</Badge.Label>
            </Badge.Root>
            {/* 영역 배지(§9.3 예약 = brand) — 폰 시트 디자인 */}
            {phone && (
              <Badge.Root tone="brand" variant="weak" size="large">
                <Badge.Label>예약</Badge.Label>
              </Badge.Root>
            )}
          </span>
          {!phone && (
            <ResponsiveSidePanel.CloseButton asChild>
              <ActionButton variant="ghost" size="small" layout="iconOnly" aria-label="닫기">
                <Icon svg={<X />} />
              </ActionButton>
            </ResponsiveSidePanel.CloseButton>
          )}
        </div>
        <div className="flex items-center justify-between gap-2">
          <ResponsiveSidePanel.Title className={cn(titleClass, phone ? 'text-xl font-bold tracking-[-0.02em]' : 'text-[22px] font-bold')}>
            {/* 고객 상세(W6)로. 고객 id가 없는 예약(테스트 데이터)은 이름만. */}
            {a.customerId ? (
              <Link to={`/customers/${a.customerId}`} className="text-inherit">
                {name}
              </Link>
            ) : (
              a.customerName
            )}
          </ResponsiveSidePanel.Title>
          {phone && scheduled && (
            <ActionButton variant="ghost" size="small" layout="iconOnly" aria-label="더보기" disabled>
              <Icon svg={<Ellipsis />} />
            </ActionButton>
          )}
        </div>
        {a.customerPhone && <p className="text-[15px] text-ink-soft tabular-nums">{phoneText(a.customerPhone)}</p>}
      </ResponsiveSidePanel.Header>
      <ResponsiveSidePanel.Body className={sheetBodyClass(phone)}>
        <div className="grid gap-1">
          <b className="text-lg tabular-nums">{time}</b>
          {prep && <span className="text-[15px] text-ink-soft">{prep}</span>}
        </div>
        <dl className="m-0 grid grid-cols-[76px_minmax(0,1fr)] gap-x-2.5 gap-y-2 text-[15px]">
          <dt className="text-ink-soft">메뉴</dt>
          <dd className="m-0">{a.menuName ?? '메뉴 없음'}</dd>
          <dt className="text-ink-soft">담당자</dt>
          <dd className="m-0">{staffName}</dd>
          <dt className="text-ink-soft">메모</dt>
          <dd className="m-0 whitespace-pre-wrap">{a.memo ?? '메모 없음'}</dd>
        </dl>
        {overlaps.map((b) => (
          // 결정 R50: 관리 불가와 겹쳐도 예약은 그대로 두고 알린다.
          <Callout.Root key={b.id} tone="critical">
            <Callout.Content>
              <Callout.Description>
                관리 불가 시간({shopTime(b.startAt)}–{shopTime(b.endAt)}
                {b.memo ? ` ${b.memo}` : ''})과 겹쳐요. 예약은 그대로 있어요.
              </Callout.Description>
            </Callout.Content>
          </Callout.Root>
        ))}
        {error && (
          <Callout.Root tone="critical">
            <Callout.Content>
              <Callout.Title>바꾸지 못했어요</Callout.Title>
              <Callout.Description>{error}</Callout.Description>
            </Callout.Content>
          </Callout.Root>
        )}
      </ResponsiveSidePanel.Body>
      <ResponsiveSidePanel.Footer className={sheetFootClass(phone)}>
        {fixing ? (
          // 상태 고치기: 예정·완료·노쇼·취소 중 고른다(결정 S5). 지금 상태는 뺀다.
          <div role="group" aria-label="상태 고치기" className="flex w-full flex-wrap gap-2">
            {(['scheduled', 'completed', 'no_show', 'cancelled'] as const)
              .filter((s) => s !== a.status)
              .map((s) => (
                <ActionButton
                  key={s}
                  variant="neutralWeak"
                  size={size}
                  flexGrow={1}
                  loading={busy}
                  onClick={() => (s === 'cancelled' ? setConfirmCancel(true) : run(s))}
                >
                  {STATUS_TEXT[s]}
                </ActionButton>
              ))}
          </div>
        ) : scheduled ? (
          <div className="flex w-full gap-2">
            <ActionButton variant="brandSolid" size={size} flexGrow={phone ? 2 : 1} loading={busy} onClick={() => run('completed')}>
              완료
            </ActionButton>
            <ActionButton variant="neutralWeak" size={size} flexGrow={phone ? 1 : 0} disabled={busy} onClick={() => run('no_show')}>
              노쇼
            </ActionButton>
            {/* 문자 보내기는 M3(2D-2) — 자리만 */}
            {phone ? (
              <ActionButton variant="neutralWeak" size="large" layout="iconOnly" flexGrow={1} aria-label="문자 보내기" disabled>
                <Icon svg={<MessageSquare />} />
              </ActionButton>
            ) : (
              <>
                <ActionButton variant="neutralWeak" size="medium" disabled>
                  <PrefixIcon svg={<MessageSquare />} />
                  문자 보내기
                </ActionButton>
                <ActionButton variant="ghost" size="medium" layout="iconOnly" aria-label="더보기" disabled>
                  <Icon svg={<Ellipsis />} />
                </ActionButton>
              </>
            )}
          </div>
        ) : (
          <ActionButton variant="neutralWeak" size={size} flexGrow={1} onClick={() => setFixing(true)}>
            상태 고치기
          </ActionButton>
        )}
      </ResponsiveSidePanel.Footer>
      <AlertDialog.Root open={confirmCancel} onOpenChange={setConfirmCancel}>
        <AlertDialog.Backdrop />
        <AlertDialog.Positioner>
          <AlertDialog.Content>
            <AlertDialog.Header>
              <AlertDialog.Title>
                {shortDate(shopDate(Date.parse(a.startAt)))} {shopTime(a.startAt)} {a.customerName} 님 예약을 취소할까요?
              </AlertDialog.Title>
            </AlertDialog.Header>
            <AlertDialog.Footer>
              <AlertDialog.Action asChild>
                <ActionButton variant="neutralWeak" size="large" flexGrow={1}>
                  그만두기
                </ActionButton>
              </AlertDialog.Action>
              <ActionButton
                variant="criticalSolid"
                size="large"
                flexGrow={1}
                loading={busy}
                onClick={async () => {
                  await run('cancelled');
                  setConfirmCancel(false);
                }}
              >
                예약 취소
              </ActionButton>
            </AlertDialog.Footer>
          </AlertDialog.Content>
        </AlertDialog.Positioner>
      </AlertDialog.Root>
    </>
  );
}
