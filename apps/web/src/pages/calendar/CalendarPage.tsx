// 캘린더 보기 (BEA-175, 기능 2A-3.1, 화면 설계서 W1, 디자인 w1.png).
// 완료 조건: 주·월 전환 / 관리·준비·차단을 다르게 표시 / 예약 카드에 고객·메뉴·담당자, 누르면 메모.
// 보기와 날짜는 주소(?view=week|month&date=YYYY-MM-DD)에 둔다 — 개인정보가 아니고, 새로고침·뒤로 가기에도 유지된다.
// 폰: 제목 위 매장 이름, 제목 + 주·월. ‹ ›가 없어 7일 띠·달력을 밀어 이동하고 제목을 누르면 오늘(11/21 옵마 결정). `+ 예약`은 떠 있는 버튼.
// 웹: 제목 ‹ 오늘 › … 주·월 · `+ 예약`, 담당자 칩. `+ 예약`·빈 칸 누르기 → 예약 넣기(W3).
import {
  ActionButton,
  Icon,
  PrefixIcon,
  Chip,
  RadioGroupItemHiddenInput,
  SegmentedControl,
  SegmentedControlItemHiddenInput,
  Snackbar,
  useSnackbarAdapter,
} from '@seed-design/react';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { useShopName } from '@/components/layout/AppShell';
import { ErrorState } from '@/components/states/DataState';
import { useCalendarApi, useHasCalendarApiProvider } from '@/features/calendar/api';
import { rejectText } from '@/features/calendar/bookingText';
import {
  addDays,
  addMonths,
  forStaff,
  monthGrid,
  shopDate,
  weekDays,
  weekTitle,
  type AppointmentStatus,
  type CalendarAppointment,
  type CalendarData,
  type Staff,
} from '@/features/calendar/model';
import { useIsPhone } from '@/lib/useLayout';
import { FAKE_API } from '@/lib/apiMode';
import { useLoad } from '@/lib/useLoad';
import { cn } from '@/lib/utils';
import { AppointmentPanel, PANEL_WIDTH } from './AppointmentPanel';
import { EntrySheet, type EntryStart } from './EntrySheet';
import { MonthView } from './MonthView';
import { WeekStrip } from './WeekStrip';
import { WeekView } from './WeekView';

type View = 'week' | 'month';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 주소의 날짜가 실제 있는 날인지(2026-02-30·2026-99-99는 아님). 아니면 오늘로 본다. */
export function validDate(raw: string | null): raw is string {
  if (!raw || !DATE_RE.test(raw)) return false;
  const t = Date.parse(`${raw}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === raw;
}

/** 제목: 주는 "11월 넷째 주", 월은 "2026년 11월"(화면 설계서 W1). */
function title(view: View, date: string): string {
  const [y, m] = date.split('-').map(Number);
  return view === 'month' ? `${y}년 ${m}월` : weekTitle(date);
}

const ALL = 'all';
const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** 상태를 바꾼 뒤 스낵바 문구(설계서 W2 "완료로 표시했어요 · 되돌리기"). */
const STATUS_DONE: Record<AppointmentStatus, string> = {
  scheduled: '예정으로 되돌렸어요',
  completed: '완료로 표시했어요',
  no_show: '노쇼로 표시했어요',
  cancelled: '예약을 취소했어요',
  voided: '되돌렸어요', // 원장이 고르는 상태가 아님(업무 되돌리기 전용) — 형식을 맞추려고만
};

export function CalendarPage() {
  // 스낵바(상태 바꾼 뒤 되돌리기)는 캘린더 화면 안에서만 쓴다.
  return (
    <Snackbar.RootProvider>
      <CalendarScreen />
    </Snackbar.RootProvider>
  );
}

function CalendarScreen() {
  const snackbar = useSnackbarAdapter();
  const api = useCalendarApi();
  const hasApiProvider = useHasCalendarApiProvider();
  const canEnter = FAKE_API || hasApiProvider || api.persistsAppointments === true;
  const shopName = useShopName();
  // 폰은 주 보기를 7일 띠 + 고른 날 하루 시간표로, 월 보기를 예약 수 + 아래 목록으로(설계 D4: 부품이 다른 곳만 JS로).
  const phone = useIsPhone();
  const [params, setParams] = useSearchParams();
  const view: View = params.get('view') === 'month' ? 'month' : 'week';
  const raw = params.get('date');
  const today = shopDate(Date.now());
  const date = validDate(raw) ? raw : today;
  const days = view === 'week' ? weekDays(date) : monthGrid(date);
  const from = days[0]!;
  const to = days[days.length - 1]!;

  const load = useCallback(() => api.range(from, to), [api, from, to]);
  const { state, reload } = useLoad<CalendarData>(load);
  const [openId, setOpenId] = useState<string | null>(null);
  const [entry, setEntry] = useState<EntryStart | null>(null);
  // 닫히면 누른 예약 칸으로 초점을 돌려준다(키보드 사용자, 설계 §6).
  const opener = useRef<HTMLElement | null>(null);
  const setOpen = (a: CalendarAppointment | null) => {
    if (a) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpenId(a?.id ?? null);
    if (!a && !entry) requestAnimationFrame(() => opener.current?.focus());
  };
  // 담당자 거르기(W1). 주소에 두지 않는다 — 화면 안 보기 상태.
  const [staffId, setStaffId] = useState<string>(ALL);
  const data = state.status === 'ok' ? state.data : null;
  // 폰 배치엔 담당자 칩이 없으므로 거르기를 쓰지 않는다 — 웹에서 고른 뒤 폭이 좁아져도 다른 담당자 예약이 숨지 않게(#66 리뷰).
  const shown = data ? forStaff(data, phone || staffId === ALL ? null : staffId) : null;
  const open = data?.appointments.find((a) => a.id === openId) ?? null;

  const go = (next: Partial<{ view: View; date: string }>) =>
    setParams({ view: next.view ?? view, date: next.date ?? date }, { replace: true });
  const step = (n: number) => go({ date: view === 'week' ? addDays(date, 7 * n) : addMonths(date, n) });

  const staffName = (id: string) => data?.staff.find((s) => s.id === id)?.name ?? '담당자 미상';
  const newEntry = (start?: Partial<EntryStart>) => {
    if (openId !== null) {
      setOpenId(null);
      // 상세 뒤에 보존한 폼이 있으면 이어서 입력한다.
      if (entry) return;
    }
    // 바꾸기(편집) 중에는 빈 칸·+ 예약으로 폼을 바꾸지 않는다 — 바꾼 입력이 확인 없이 사라지지 않게(#77 리뷰).
    // 새 예약은 편집을 닫은 뒤(바꾼 게 있으면 닫기 확인) 연다.
    if (entry?.editId) return;
    // `+ 예약`은 보고 있는 날짜만 채우고 시각은 원장이 고른다. 빈 칸은 그 날짜·시각·담당자 열(설계 06 D1).
    setEntry({
      date: start?.date ?? date,
      time: start?.time ?? null,
      staffId: start?.staffId ?? (staffId === ALL ? null : staffId),
      customer: start?.customer,
    });
  };

  // 고객 상세(W6) `예약 넣기`로 왔으면 그 고객을 채운 예약 넣기를 연다. 한 번 열면 기록 상태를 지워 뒤로·새로고침에 다시 열리지 않게.
  const location = useLocation();
  const navigate = useNavigate();
  const entryFor = (location.state as { entryFor?: EntryStart['customer'] } | null)?.entryFor;
  useEffect(() => {
    if (!entryFor || !canEnter) return;
    newEntry({ customer: entryFor });
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  }, [entryFor, canEnter]);

  const changeStatus = async (a: CalendarAppointment, to: AppointmentStatus) => {
    const reason = (r: { reason: Parameters<typeof rejectText>[0]; conflictingIds: string[] }) =>
      data ? rejectText(r.reason, r.conflictingIds, { data, staffId: a.staffId, startAt: a.startAt }) : '바꾸지 못했어요.';
    const r = await api.setStatus(a.id, to);
    if (!r.ok) {
      // 그사이 바뀌었거나 없어졌으면 최신으로 다시 읽는다(설계 05 D4).
      if (r.reason === 'VERSION_CONFLICT' || r.reason === 'NOT_FOUND') reload();
      return reason(r);
    }
    // 저장되면 패널을 닫고 스낵바로 알린다 — "되돌리기"는 이전 상태로(설계서 W2, 11/22 옵마).
    const from = a.status;
    setOpen(null);
    reload();
    const show = (message: string, undo?: () => void) =>
      snackbar.create({
        render: () => (
          <Snackbar.Root variant={undo ? 'default' : 'critical'} className="!pointer-events-none">
            <Snackbar.Content>
              <Snackbar.Message>{message}</Snackbar.Message>
            </Snackbar.Content>
            {undo && <Snackbar.ActionButton className="pointer-events-auto" onClick={undo}>되돌리기</Snackbar.ActionButton>}
          </Snackbar.Root>
        ),
      });
    let undoStarted = false;
    show(STATUS_DONE[to], async () => {
      if (undoStarted) return;
      undoStarted = true;
      try {
        const back = await api.setStatus(a.id, from);
        if (!back.ok) show(`되돌리지 못했어요. ${reason(back)}`);
      } catch {
        show('되돌리지 못했어요. 잠시 뒤 다시 시도해 주세요.');
      }
      reload();
    });
    return null;
  };

  const segment = (
    // 세그먼트는 기본으로 줄 전체 폭 — 내용만큼만 쓰도록 감싼다(폭을 고정하면 표시 막대 위치가 어긋난다).
    <div className="w-fit">
      <SegmentedControl.Root aria-label="보기" value={view} onValueChange={(v) => go({ view: v as View })}>
        <SegmentedControl.Indicator />
        {(['week', 'month'] as const).map((v) => (
          <SegmentedControl.Item key={v} value={v} className="min-w-0 px-3.5">
            <SegmentedControlItemHiddenInput />
            {v === 'week' ? '주' : '월'}
          </SegmentedControl.Item>
        ))}
      </SegmentedControl.Root>
    </div>
  );

  return (
    // 웹 패널은 모달이 아니라 격자 위에 뜨므로, 열려 있는 동안 패널 폭만큼 오른쪽을 비워 격자를 좁힌다(설계 §6, 디자인 padding-right 424px).
    <div
      className={cn('flex flex-col', !phone && 'gap-[18px] p-6')}
      style={(open || entry) && !phone ? { paddingRight: PANEL_WIDTH + 24 } : undefined}
    >
      <h1 className="sr-only">캘린더</h1>
      {phone ? (
        <div className="grid gap-0.5 px-5 pt-[22px] pb-1.5">
          <p className="justify-self-start text-sm font-bold text-ink-soft" aria-label="매장">
            {shopName}
          </p>
          <div className="flex items-center justify-between gap-2">
            {/* 폰엔 ‹ 오늘 ›가 없다 — 제목을 누르면 오늘로 */}
            <button type="button" onClick={() => go({ date: today })} aria-label={`${title(view, date)} · 오늘로`}>
              <h2 className="text-2xl leading-[1.3] font-bold tracking-[-0.03em]" aria-live="polite">
                {title(view, date)}
              </h2>
            </button>
            {segment}
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-[32px] leading-[1.2] font-bold tracking-[-0.03em]" aria-live="polite">
            {title(view, date)}
          </h2>
          <ActionButton
            variant="ghost"
            size="medium"
            layout="iconOnly"
            aria-label={view === 'week' ? '이전 주' : '이전 달'}
            onClick={() => step(-1)}
          >
            <Icon svg={<ChevronLeft />} />
          </ActionButton>
          <ActionButton variant="neutralWeak" size="small" onClick={() => go({ date: today })}>
            오늘
          </ActionButton>
          <ActionButton
            variant="ghost"
            size="medium"
            layout="iconOnly"
            aria-label={view === 'week' ? '다음 주' : '다음 달'}
            onClick={() => step(1)}
          >
            <Icon svg={<ChevronRight />} />
          </ActionButton>
          <span className="flex-1" />
          {segment}
          {canEnter && (
            <ActionButton variant="brandSolid" size="medium" onClick={() => newEntry()}>
              <PrefixIcon svg={<Plus />} />
              예약
            </ActionButton>
          )}
        </div>
      )}

      {!phone && data && <StaffFilter staff={data.staff} value={staffId} onChange={setStaffId} />}

      {state.status === 'loading' && <p className="py-8 text-center text-sm text-ink-soft">불러오는 중…</p>}
      {state.status === 'error' && <ErrorState onRetry={reload} />}
      {/* 영업시간·휴무만 못 불러왔으면 예약은 그대로 보이고, 열린 날처럼 보이지 않게 따로 알린다(설계 05 D3). */}
      {data?.hoursUnavailable && (
        <p role="status" className={cn('text-sm text-ink-soft', phone && 'px-5')}>
          영업시간·휴무를 불러오지 못해 쉬는 시간 표시를 뺐어요.{' '}
          <button type="button" className="font-bold underline" onClick={reload}>
            다시 불러오기
          </button>
        </p>
      )}
      {shown && view === 'week' && (
        <>
          {phone && <WeekStrip days={days} data={shown} selected={date} today={today} onPick={(d) => go({ date: d })} onStep={step} />}
          <WeekView
            days={phone ? [date] : days}
            data={shown}
            today={today}
            now={Date.now()}
            onOpen={setOpen}
            staffName={staffName}
            phone={phone}
            onEmpty={canEnter ? (d, minute, lane) => newEntry({ date: d, time: hhmm(minute), staffId: lane }) : undefined}
          />
        </>
      )}
      {shown && view === 'month' && (
        <MonthView
          days={days}
          month={date.slice(0, 7)}
          data={shown}
          today={today}
          onOpen={setOpen}
          phone={phone}
          selected={date}
          onPick={(d) => go({ date: d })}
          onStep={step}
          staffName={shown.staff.length > 1 ? staffName : undefined}
        />
      )}

      <AppointmentPanel
        appointment={open}
        staffName={open ? staffName(open.staffId) : ''}
        blocks={data?.blocks ?? []}
        onClose={() => setOpen(null)}
        onStatus={changeStatus}
        editDisabled={entry !== null}
        // W2 바꾸기 → 같은 자리에서 W3 편집(설계 06 D4). 닫으면 이 예약 보기로 돌아온다.
        onEdit={
          canEnter
            ? (a) => {
                setOpenId(null);
                setEntry({ date: shopDate(Date.parse(a.startAt)), time: null, staffId: a.staffId, editId: a.id });
              }
            : undefined
        }
      />
      <EntrySheet
        start={entry}
        suspended={open !== null}
        staff={data?.staff ?? []}
        businessHours={data?.businessHours ?? null}
        onClose={() => {
          // 바꾸기를 닫으면 원래 예약 보기(W2)로 돌아간다(설계 06 D4).
          if (entry?.editId) setOpenId(entry.editId);
          setEntry(null);
        }}
        onSaved={(d) => {
          setEntry(null);
          go({ date: d });
          reload();
        }}
      />
      {/* 패널이 열려 있으면 알림을 웹 패널 왼쪽이나 폰 시트 위쪽에 둔다. */}
      <Snackbar.Region
        className={cn('!pointer-events-none md:!bottom-0', open || entry ? '!top-0 !bottom-auto md:!top-auto' : '!bottom-[74px]')}
        style={open || entry ? { right: phone ? undefined : PANEL_WIDTH } : undefined}
      >
        <Snackbar.Renderer />
      </Snackbar.Region>
      {/* + 예약: 폰은 오른쪽 아래 떠 있는 버튼(디자인 .fab — 탭 바 위 오른쪽 18px), 웹은 제목 줄 오른쪽(설계서 W1). */}
      {phone && canEnter && (
        <button
          type="button"
          onClick={() => newEntry()}
          className="fixed right-[18px] bottom-24 z-20 inline-flex h-[52px] items-center gap-1.5 rounded-[26px] bg-brand pr-5 pl-4 text-base font-bold text-on-brand shadow-lg"
        >
          <Plus aria-hidden size={20} strokeWidth={2.25} />
          예약
        </button>
      )}
    </div>
  );
}

/** 담당자 칩 "전체 · 박원장 · 이실장"(W1) + 칸 위치 안내. 담당자가 1명이면 숨긴다. */
function StaffFilter({ staff, value, onChange }: { staff: Staff[]; value: string; onChange: (id: string) => void }) {
  if (staff.length <= 1) return null;
  // ASSUMPTION: 3명 이상이면 "칸 왼쪽부터 A, B, C"(디자인은 2명 예시만).
  const hint =
    staff.length === 2 ? `칸 왼쪽이 ${staff[0]!.name}, 오른쪽이 ${staff[1]!.name}` : `칸 왼쪽부터 ${staff.map((s) => s.name).join(', ')}`;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Chip.RadioRoot aria-label="담당자" value={value} onValueChange={onChange} className="flex flex-wrap gap-2">
        {[{ id: ALL, name: '전체' }, ...staff].map((s) => (
          <Chip.RadioItem key={s.id} value={s.id} variant="outlineStrong" size="medium">
            <RadioGroupItemHiddenInput />
            <Chip.Label>{s.name}</Chip.Label>
          </Chip.RadioItem>
        ))}
      </Chip.RadioRoot>
      {value === ALL && <span className="ml-2 text-sm text-ink-soft">{hint}</span>}
    </div>
  );
}
