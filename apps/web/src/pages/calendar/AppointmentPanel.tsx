// 예약 보기 W2 (화면 설계서 §5 W2, 디자인 w2.png·phase2-screens.html .panel/.sheet): 폰은 아래 시트, 웹은 오른쪽 패널.
// 예정이면 주 버튼 "시술 완료"(11/22 옵마 결정 — 디자인 문구는 "완료"), 보조 노쇼·문자 보내기, 더보기. 완료·노쇼·취소면 상태 고치기 하나(결정 S5).
// 완료·노쇼·상태 고치기는 가짜 저장소에서 실제로 바뀐다(@bv/scheduling changeStatus, 11/21 옵마 결정). 저장되면 패널을 닫고 스낵바 + 되돌리기(CalendarPage).
// 더보기 → 바꾸기(W3 편집, 설계 06 ①)·예약 취소(확인 뒤). 문자 보내기(M3)는 아직 꺼 둔다.
// rev.3.1(설계 12 §5-1): 다른 예약과 겹치면 빨간 안내 + "요청 예약 | 기존 예약" 탭으로 두 예약을 비교한다.
import {
  ActionButton,
  AlertDialog,
  Icon,
  PrefixIcon,
  Badge,
  Callout,
  ResponsiveSidePanel,
  SegmentedControl,
  SegmentedControlItemHiddenInput,
} from '@seed-design/react';
import { ChevronRight, Ellipsis, MessageSquare, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { shortDate } from '@/features/calendar/bookingText';
import { Link } from 'react-router';
import {
  appointmentPanelTime,
  overlappingAppointmentIds,
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

/** 상세 탭: 이 예약(요청 예약) / 겹치는 예약(기존 예약). */
export type PanelTab = 'request' | 'existing';

interface Props {
  appointment: CalendarAppointment | null;
  staffName: (id: string | null) => string;
  /** 겹치는 예약을 찾아 비교 탭에 보인다(조회 범위 안의 예약). */
  appointments: readonly CalendarAppointment[];
  blocks: readonly CalendarBlock[];
  /** 저장 뒤 "새로 겹치는 예약" 안내로 열면 기존 예약 탭부터. */
  initialTab?: PanelTab;
  onClose: () => void;
  /** 상태 바꾸기. 실패하면 이유 문구를 돌려준다. */
  onStatus: (a: CalendarAppointment, to: AppointmentStatus) => Promise<string | null>;
  /** 예약 바꾸기(W3 편집)를 연다. 없으면 더보기가 꺼진다(저장할 곳이 없는 시안). */
  onEdit?: (a: CalendarAppointment) => void;
  editDisabled?: boolean;
}

export function AppointmentPanel({ appointment: a, staffName, appointments, blocks, initialTab = 'request', onClose, onStatus, onEdit, editDisabled = false }: Props) {
  return (
    <CalendarSheet open={a !== null} onClose={onClose}>
      {a && (
        <Body
          key={`${a.id}-${a.status}-${initialTab}`}
          a={a}
          staffName={staffName}
          appointments={appointments}
          blocks={blocks}
          initialTab={initialTab}
          onStatus={onStatus}
          onClose={onClose}
          onEdit={onEdit}
          editDisabled={editDisabled}
        />
      )}
    </CalendarSheet>
  );
}

const PHONE_DIGITS = /^(\d{3})(\d{3,4})(\d{4})$/;
const phoneText = (p: string) => p.replace(PHONE_DIGITS, '$1-$2-$3');

function Body({
  a,
  staffName,
  appointments,
  blocks,
  initialTab,
  onStatus,
  onClose,
  onEdit,
  editDisabled,
}: {
  a: CalendarAppointment;
  staffName: Props['staffName'];
  appointments: readonly CalendarAppointment[];
  blocks: readonly CalendarBlock[];
  initialTab: PanelTab;
  onStatus: Props['onStatus'];
  onClose: () => void;
  onEdit: Props['onEdit'];
  editDisabled: boolean;
}) {
  const phone = useIsPhone();
  const [time, cleanup] = appointmentPanelTime(a);
  const overlaps = overlappingBlocks(a, blocks);
  const overlapIds = overlappingAppointmentIds(a, appointments);
  // 조회 범위 밖이라 받지 못한 예약은 건수만 보인다.
  const others = overlapIds.map((id) => appointments.find((x) => x.id === id)).filter((x) => x !== undefined);
  const [tab, setTab] = useState<PanelTab>(overlapIds.length > 0 ? initialTab : 'request');
  const scheduled = a.status === 'scheduled';
  const [fixing, setFixing] = useState(false);
  // 더보기(예정 예약): 바꾸기·예약 취소를 보인다.
  const [more, setMore] = useState(false);
  const moreButton = (sz: 'small' | 'medium') => (
    <ActionButton
      variant="ghost"
      size={sz}
      layout="iconOnly"
      aria-label="더보기"
      aria-expanded={more}
      disabled={!onEdit || busy}
      onClick={() => setMore((m) => !m)}
    >
      <Icon svg={<Ellipsis />} />
    </ActionButton>
  );
  // 예약 취소는 캘린더에서 빠지므로 한 번 더 묻는다(설계서 W2 확인, 원칙 8 — #68 리뷰).
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const size = phone ? 'large' : 'medium';

  const run = async (to: AppointmentStatus) => {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    try {
      setError(await onStatus(a, to));
    } catch {
      setError('저장하지 못했어요. 잠시 뒤 다시 시도해 주세요.');
    } finally {
      saving.current = false;
      setBusy(false);
    }
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
          {/* 닫기 ×는 폰 시트에도 늘 보인다(11/22 옵마) */}
          <ResponsiveSidePanel.CloseButton asChild>
            <ActionButton variant="ghost" size="small" layout="iconOnly" aria-label="닫기">
              <Icon svg={<X />} />
            </ActionButton>
          </ResponsiveSidePanel.CloseButton>
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
          {phone && scheduled && moreButton('small')}
        </div>
        {a.customerPhone && <p className="text-[15px] text-ink-soft tabular-nums">{phoneText(a.customerPhone)}</p>}
      </ResponsiveSidePanel.Header>
      <ResponsiveSidePanel.Body className={sheetBodyClass(phone)}>
        {overlapIds.length > 0 && (
          <>
            <Callout.Root tone="critical">
              <Callout.Content>
                <Callout.Description>다른 예약 {overlapIds.length}건과 시간이 겹쳐요. 예약은 그대로 있어요.</Callout.Description>
              </Callout.Content>
            </Callout.Root>
            <SegmentedControl.Root aria-label="겹침 비교" value={tab} onValueChange={(v) => setTab(v as PanelTab)} className="w-full">
              <SegmentedControl.Indicator />
              <SegmentedControl.Item value="request">
                <SegmentedControlItemHiddenInput />
                요청 예약
              </SegmentedControl.Item>
              <SegmentedControl.Item value="existing">
                <SegmentedControlItemHiddenInput />
                기존 예약 {overlapIds.length}
              </SegmentedControl.Item>
            </SegmentedControl.Root>
          </>
        )}
        {tab === 'existing' && overlapIds.length > 0 ? (
          <ul aria-label="겹치는 기존 예약" className="m-0 grid gap-3 p-0">
            {others.map((o) => (
              <li key={o.id} className="grid list-none gap-1 rounded-xl p-3 shadow-[inset_0_0_0_2px_var(--cal-overlap)]">
                <b className="text-base tabular-nums">{appointmentPanelTime(o)[0]}</b>
                {appointmentPanelTime(o)[1] && <span className="text-sm text-ink-soft">{appointmentPanelTime(o)[1]}</span>}
                <span className="text-[15px]">
                  <b>{o.customerName}</b> · {o.menuName ?? '메뉴 없음'} · {staffName(o.staffId)} · {STATUS_TEXT[o.status]}
                </span>
              </li>
            ))}
            {others.length < overlapIds.length && (
              <li className="list-none text-sm text-ink-soft">보고 있는 기간 밖 예약 {overlapIds.length - others.length}건 — 그 날짜로 가서 확인해 주세요.</li>
            )}
          </ul>
        ) : (
          <>
            <div className="grid gap-1">
              <b className="text-lg tabular-nums">{time}</b>
              {cleanup && <span className="text-[15px] text-ink-soft">{cleanup}</span>}
            </div>
            <dl className="m-0 grid grid-cols-[76px_minmax(0,1fr)] gap-x-2.5 gap-y-2 text-[15px]">
              <dt className="text-ink-soft">메뉴</dt>
              <dd className="m-0">{a.menuName ?? '메뉴 없음'}</dd>
              <dt className="text-ink-soft">담당자</dt>
              <dd className="m-0">{staffName(a.staffId)}</dd>
              <dt className="text-ink-soft">메모</dt>
              <dd className="m-0 whitespace-pre-wrap">{a.memo ?? '메모 없음'}</dd>
            </dl>
          </>
        )}
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
        {more && scheduled && onEdit ? (
          <div role="group" aria-label="더보기" className="flex w-full gap-2">
            <ActionButton variant="neutralWeak" size={size} flexGrow={1} disabled={editDisabled} onClick={() => onEdit(a)}>
              바꾸기
            </ActionButton>
            <ActionButton variant="neutralWeak" size={size} flexGrow={1} disabled={busy} onClick={() => setConfirmCancel(true)}>
              예약 취소
            </ActionButton>
            <ActionButton variant="ghost" size={size} onClick={() => setMore(false)}>
              접기
            </ActionButton>
          </div>
        ) : fixing ? (
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
              시술 완료
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
                {moreButton('medium')}
              </>
            )}
          </div>
        ) : (
          <ActionButton variant="neutralWeak" size={size} flexGrow={1} onClick={() => setFixing(true)}>
            상태 고치기
          </ActionButton>
        )}
      </ResponsiveSidePanel.Footer>
      {/* 그만두기(·Esc·바깥 누르기)는 아무것도 바꾸지 않고 패널까지 닫아 캘린더로 돌아간다(11/22 옵마).
          "예약 취소"는 저장 뒤 CalendarPage가 패널을 닫는다 — 실패하면 확인 창만 닫고 패널에 이유를 보인다. */}
      <AlertDialog.Root
        open={confirmCancel}
        closeOnInteractOutside={!busy}
        onOpenChange={(open) => {
          if (saving.current) return;
          setConfirmCancel(open);
          if (!open) onClose();
        }}
      >
        <AlertDialog.Backdrop />
        <AlertDialog.Positioner>
          <AlertDialog.Content>
            <AlertDialog.Header>
              <AlertDialog.Title>
                {shortDate(shopDate(Date.parse(a.startAt)))} {shopTime(a.startAt)} {a.customerName} 님 예약을 취소할까요?
              </AlertDialog.Title>
            </AlertDialog.Header>
            <AlertDialog.Footer className="gap-[5px]">
              <AlertDialog.Action asChild>
                <ActionButton variant="neutralWeak" size="large" flexGrow={1} disabled={busy}>
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
