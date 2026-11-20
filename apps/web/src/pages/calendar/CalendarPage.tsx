// 캘린더 보기 (BEA-175, 기능 2A-3.1).
// 완료 조건: 주·월 전환 / 관리·준비·차단을 다르게 표시 / 예약 카드에 고객·메뉴·담당자, 누르면 메모.
// 보기와 날짜는 주소(?view=week|month&date=YYYY-MM-DD)에 둔다 — 개인정보가 아니고, 새로고침·뒤로 가기에도 유지된다.
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ErrorState } from '@/components/states/DataState';
import { Button } from '@/components/ui/button';
import { useCalendarApi } from '@/features/calendar/api';
import {
  addDays,
  addMonths,
  monthGrid,
  shopDate,
  weekDays,
  type CalendarAppointment,
  type CalendarData,
} from '@/features/calendar/model';
import { useLoad } from '@/lib/useLoad';
import { cn } from '@/lib/utils';
import { AppointmentDetail } from './AppointmentDetail';
import { MonthView } from './MonthView';
import { KIND_CLASS } from './styles';
import { WeekView } from './WeekView';

type View = 'week' | 'month';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 주소의 날짜가 실제 있는 날인지(2026-02-30·2026-99-99는 아님). 아니면 오늘로 본다. */
export function validDate(raw: string | null): raw is string {
  if (!raw || !DATE_RE.test(raw)) return false;
  const t = Date.parse(`${raw}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === raw;
}

function title(view: View, date: string): string {
  const [y, m] = date.split('-').map(Number);
  if (view === 'month') return `${y}년 ${m}월`;
  const days = weekDays(date);
  const md = (d: string) => `${Number(d.slice(5, 7))}월 ${Number(d.slice(8, 10))}일`;
  return `${md(days[0]!)} – ${md(days[6]!)}`;
}

export function CalendarPage() {
  const api = useCalendarApi();
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

  const go = (next: Partial<{ view: View; date: string }>) =>
    setParams({ view: next.view ?? view, date: next.date ?? date }, { replace: true });
  const step = (n: number) => go({ date: view === 'week' ? addDays(date, 7 * n) : addMonths(date, n) });

  const staffName = (id: string) => (state.status === 'ok' ? state.data.staff.find((s) => s.id === id)?.name : undefined) ?? '담당자 미상';

  return (
    <div className="flex flex-col gap-3 px-4 pt-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">캘린더</h1>
        <div role="group" aria-label="보기" className="inline-flex rounded-md border p-0.5">
          {(['week', 'month'] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => go({ view: v })}
              className={cn('rounded px-3 py-1 text-sm', view === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground')}
            >
              {v === 'week' ? '주' : '월'}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-1">
        <Button variant="outline" size="icon-sm" aria-label={view === 'week' ? '이전 주' : '이전 달'} onClick={() => step(-1)}>
          <ChevronLeft aria-hidden />
        </Button>
        <Button variant="outline" size="sm" onClick={() => go({ date: shopDate(Date.now()) })}>
          오늘
        </Button>
        <Button variant="outline" size="icon-sm" aria-label={view === 'week' ? '다음 주' : '다음 달'} onClick={() => step(1)}>
          <ChevronRight aria-hidden />
        </Button>
        <h2 className="ml-2 font-medium" aria-live="polite">
          {title(view, date)}
        </h2>
      </div>

      <Legend />

      {state.status === 'loading' && <p className="py-8 text-center text-sm text-muted-foreground">불러오는 중…</p>}
      {state.status === 'error' && <ErrorState onRetry={reload} />}
      {state.status === 'ok' && view === 'week' && (
        <WeekView days={days} data={state.data} today={shopDate(Date.now())} onOpen={setOpen} staffName={staffName} />
      )}
      {state.status === 'ok' && view === 'month' && (
        <MonthView days={days} month={date.slice(0, 7)} data={state.data} today={shopDate(Date.now())} onOpen={setOpen} />
      )}

      <AppointmentDetail appointment={open} staffName={open ? staffName(open.staffId) : ''} onClose={() => setOpen(null)} />
    </div>
  );
}

/** 관리·준비·차단 표시 방법 안내. 색만으로 구분하지 않도록 무늬·글자도 함께 쓴다. */
function Legend() {
  return (
    <ul aria-label="표시 안내" className="flex flex-wrap gap-3 text-xs text-muted-foreground">
      <li className="flex items-center gap-1">
        <span aria-hidden className={cn('size-3 rounded-sm', KIND_CLASS.care)} />
        관리
      </li>
      <li className="flex items-center gap-1">
        <span aria-hidden className={cn('size-3 rounded-sm', KIND_CLASS.prep)} />
        준비
      </li>
      <li className="flex items-center gap-1">
        <span aria-hidden className={cn('size-3 rounded-sm', KIND_CLASS.block)} />
        차단
      </li>
    </ul>
  );
}
