// 캘린더 보기 (BEA-175, 기능 2A-3.1).
// 완료 조건: 주·월 전환 / 관리·준비·차단을 다르게 표시 / 예약 카드에 고객·메뉴·담당자, 누르면 메모.
// 보기와 날짜는 주소(?view=week|month&date=YYYY-MM-DD)에 둔다 — 개인정보가 아니고, 새로고침·뒤로 가기에도 유지된다.
import { ActionButton, Chip, RadioGroupItemHiddenInput, SegmentedControl, SegmentedControlItemHiddenInput } from '@seed-design/react';
import { useCallback, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ErrorState } from '@/components/states/DataState';
import { useCalendarApi } from '@/features/calendar/api';
import {
  addDays,
  addMonths,
  forStaff,
  monthGrid,
  shopDate,
  weekDays,
  weekTitle,
  type CalendarAppointment,
  type CalendarData,
  type Staff,
} from '@/features/calendar/model';
import { useIsPhone } from '@/lib/useLayout';
import { useLoad } from '@/lib/useLoad';
import { cn } from '@/lib/utils';
import { AppointmentDetail } from './AppointmentDetail';
import { MonthView } from './MonthView';
import { KIND_CLASS } from './styles';
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

export function CalendarPage() {
  const api = useCalendarApi();
  // 폰은 주 보기를 7일 띠 + 고른 날 하루 시간표로, 월 보기를 예약 수 + 아래 목록으로(설계 D4: 부품이 다른 곳만 JS로).
  const phone = useIsPhone();
  const [params, setParams] = useSearchParams();
  const view: View = params.get('view') === 'month' ? 'month' : 'week';
  const raw = params.get('date');
  const date = validDate(raw) ? raw : shopDate(Date.now());
  const days = view === 'week' ? weekDays(date) : monthGrid(date);
  const from = days[0]!;
  const to = days[days.length - 1]!;

  const load = useCallback(() => api.range(from, to), [api, from, to]);
  const { state, reload } = useLoad<CalendarData>(load);
  const [open, setOpen] = useState<CalendarAppointment | null>(null);
  // 담당자 거르기(W1). 주소에 두지 않는다 — 화면 안 보기 상태.
  const [staffId, setStaffId] = useState<string>(ALL);
  const shown = state.status === 'ok' ? forStaff(state.data, staffId === ALL ? null : staffId) : null;

  const go = (next: Partial<{ view: View; date: string }>) =>
    setParams({ view: next.view ?? view, date: next.date ?? date }, { replace: true });
  const step = (n: number) => go({ date: view === 'week' ? addDays(date, 7 * n) : addMonths(date, n) });

  const staffName = (id: string) => (state.status === 'ok' ? state.data.staff.find((s) => s.id === id)?.name : undefined) ?? '담당자 미상';

  return (
    <div className="flex flex-col gap-3 px-4 pt-6">
      <h1 className="sr-only">캘린더</h1>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <h2 className="mr-2 text-2xl font-bold" aria-live="polite">
            {title(view, date)}
          </h2>
          <ActionButton variant="ghost" size="small" aria-label={view === 'week' ? '이전 주' : '이전 달'} onClick={() => step(-1)}>
            ‹
          </ActionButton>
          <ActionButton variant="neutralWeak" size="small" onClick={() => go({ date: shopDate(Date.now()) })}>
            오늘
          </ActionButton>
          <ActionButton variant="ghost" size="small" aria-label={view === 'week' ? '다음 주' : '다음 달'} onClick={() => step(1)}>
            ›
          </ActionButton>
        </div>
        {/* 세그먼트는 기본으로 줄 전체 폭 — 내용만큼만 쓰도록 감싼다(폭을 고정하면 표시 막대 위치가 어긋난다). */}
        <div className="w-fit">
        <SegmentedControl.Root aria-label="보기" value={view} onValueChange={(v) => go({ view: v as View })}>
          <SegmentedControl.Indicator />
          {(['week', 'month'] as const).map((v) => (
            <SegmentedControl.Item key={v} value={v}>
              <SegmentedControlItemHiddenInput />
              {v === 'week' ? '주' : '월'}
            </SegmentedControl.Item>
          ))}
        </SegmentedControl.Root>
        </div>
      </div>

      {shown && state.status === 'ok' && <StaffFilter staff={state.data.staff} value={staffId} onChange={setStaffId} />}
      <Legend />

      {state.status === 'loading' && <p className="py-8 text-center text-sm text-ink-soft">불러오는 중…</p>}
      {state.status === 'error' && <ErrorState onRetry={reload} />}
      {shown && view === 'week' && (
        <>
          {phone && <WeekStrip days={days} data={shown} selected={date} today={shopDate(Date.now())} onPick={(d) => go({ date: d })} />}
          <WeekView days={phone ? [date] : days} data={shown} today={shopDate(Date.now())} now={Date.now()} onOpen={setOpen} staffName={staffName} />
        </>
      )}
      {shown && view === 'month' && (
        <MonthView
          days={days}
          month={date.slice(0, 7)}
          data={shown}
          today={shopDate(Date.now())}
          onOpen={setOpen}
          phone={phone}
          selected={date}
          onPick={(d) => go({ date: d })}
        />
      )}

      <AppointmentDetail appointment={open} staffName={open ? staffName(open.staffId) : ''} onClose={() => setOpen(null)} />
    </div>
  );
}

/** 담당자 칩 "전체 · 원장 · 실장"(W1). 담당자가 1명이면 숨긴다. */
function StaffFilter({ staff, value, onChange }: { staff: Staff[]; value: string; onChange: (id: string) => void }) {
  if (staff.length <= 1) return null;
  return (
    <Chip.RadioRoot aria-label="담당자" value={value} onValueChange={onChange} className="flex flex-wrap gap-2">
      {[{ id: ALL, name: '전체' }, ...staff].map((s) => (
        <Chip.RadioItem key={s.id} value={s.id} variant="outlineStrong" size="medium">
          <RadioGroupItemHiddenInput />
          <Chip.Label>{s.name}</Chip.Label>
        </Chip.RadioItem>
      ))}
    </Chip.RadioRoot>
  );
}

/** 관리·준비·관리 불가 표시 안내. 색만으로 구분하지 않도록 무늬·글자도 함께 쓴다. */
function Legend() {
  return (
    <ul aria-label="표시 안내" className="flex flex-wrap gap-3 text-sm text-ink-soft">
      {([['care', '관리'], ['prep', '준비'], ['block', '관리 불가']] as const).map(([kind, label]) => (
        <li key={kind} className="flex items-center gap-1">
          <span aria-hidden className={cn('size-3 rounded-sm', KIND_CLASS[kind])} />
          {label}
        </li>
      ))}
    </ul>
  );
}
