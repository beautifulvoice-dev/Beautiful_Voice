// 예약 넣기 W3 · 관리 불가 시간 W4 (화면 설계서 §4 F1·§5 W3·W4, 디자인 w2.png 가운데·오른쪽). 한 시트를 세그먼트 `예약 · 관리 불가 시간`으로 바꾼다.
// 폰은 큰 아래 시트, 웹은 오른쪽 패널(W2와 같은 틀). 저장 검사는 서버와 같은 @bv/scheduling checkBooking(절대 규칙 4) —
// 거부되면 저장 버튼 위 빨간 알림(W3 거부 표). 관리 불가 시간은 겹치는 예약을 막지 않고 미리 알린다(결정 R50).
import { blockedAppointmentIds, checkBooking, occupiedOf } from '@bv/scheduling/booking';
import {
  ActionButton,
  Icon,
  Callout,
  Chip,
  CheckboxHiddenInput,
  Field,
  RadioGroupItemHiddenInput,
  ResponsiveSidePanel,
  SegmentedControl,
  SegmentedControlItemHiddenInput,
  Switch,
  TextField,
} from '@seed-design/react';
import { CalendarDays, Minus, Plus, Search, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toBookingInputs, useCalendarApi } from '@/features/calendar/api';
import { occupancyText, rejectText, shopIso } from '@/features/calendar/bookingText';
import { addDays, shopDate, shopTime, startTimes, type CalendarData, type Menu, type Staff } from '@/features/calendar/model';
import { useCustomerApi } from '@/features/customers/api';
import type { Customer } from '@/features/customers/model';
import { useIsPhone } from '@/lib/useLayout';
import { cn } from '@/lib/utils';
import { DateField, TimeField } from './DateTimeFields';
import { CalendarSheet, sheetBodyClass, sheetFootClass, sheetHeadClass, titleClass } from './Sheet';

export interface EntryStart {
  /** 매장 날짜 'YYYY-MM-DD'. */
  date: string;
  /** 'HH:MM'. */
  time: string;
  staffId: string | null;
}

interface Props {
  start: EntryStart | null;
  staff: Staff[];
  /** 시작 시각 목록(영업시간 안 15분)을 만드는 데 쓴다. 없으면 09:00~21:00. */
  businessHours?: CalendarData['businessHours'];
  onClose: () => void;
  /** 저장했다 — 캘린더를 다시 불러오고 그 날로 간다. */
  onSaved: (date: string) => void;
}

type Kind = 'appointment' | 'block';

export function EntrySheet({ start, staff, businessHours = null, onClose, onSaved }: Props) {
  const [kind, setKind] = useState<Kind>('appointment');
  const phone = useIsPhone();
  return (
    <CalendarSheet open={start !== null} onClose={onClose} full>
      {start && (
        <>
          <ResponsiveSidePanel.Header className={sheetHeadClass(phone)}>
            <div className="flex items-center justify-between gap-2">
              <ResponsiveSidePanel.Title className={cn(titleClass, 'text-xl font-bold tracking-[-0.02em]')}>
                {kind === 'appointment' ? '예약 넣기' : '관리 불가 시간'}
              </ResponsiveSidePanel.Title>
              <ResponsiveSidePanel.CloseButton asChild>
                <ActionButton variant="ghost" size="small" layout="iconOnly" aria-label="닫기">
                  <Icon svg={<X />} />
                </ActionButton>
              </ResponsiveSidePanel.CloseButton>
            </div>
            <SegmentedControl.Root aria-label="종류" value={kind} onValueChange={(v) => setKind(v as Kind)} className="w-full">
              <SegmentedControl.Indicator />
              <SegmentedControl.Item value="appointment">
                <SegmentedControlItemHiddenInput />
                예약
              </SegmentedControl.Item>
              <SegmentedControl.Item value="block">
                <SegmentedControlItemHiddenInput />
                관리 불가 시간
              </SegmentedControl.Item>
            </SegmentedControl.Root>
          </ResponsiveSidePanel.Header>
          {kind === 'appointment' ? (
            <AppointmentForm start={start} staff={staff} businessHours={businessHours} onSaved={onSaved} />
          ) : (
            <BlockForm start={start} staff={staff} onSaved={onSaved} />
          )}
        </>
      )}
    </CalendarSheet>
  );
}

// ── W3 예약 넣기 ─────────────────────────────────────────

type Picked = { id: string | null; name: string; phone: string | null };

const DEFAULT_DURATION = 60;
/** 메뉴가 없으면 준비 시간 기본 10분(PM 메모 닫힌 항목). */
const DEFAULT_PREP = 10;

function AppointmentForm({
  start,
  staff,
  businessHours,
  onSaved,
}: {
  start: EntryStart;
  staff: Staff[];
  businessHours: CalendarData['businessHours'];
  onSaved: (date: string) => void;
}) {
  const api = useCalendarApi();
  const customers = useCustomerApi();
  const phone = useIsPhone();
  const [menus, setMenus] = useState<Menu[]>([]);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Picked | null>(null);
  const [candidates, setCandidates] = useState<Customer[]>([]);
  const [menuId, setMenuId] = useState<string>('');
  const [date, setDate] = useState(start.date);
  const [time, setTime] = useState(start.time);
  const [duration, setDuration] = useState(DEFAULT_DURATION);
  const [prep, setPrep] = useState(DEFAULT_PREP);
  // 담당자가 1명이면 자동으로 정해지고 칸이 보이지 않는다(F1-4).
  const [staffId, setStaffId] = useState<string>(staff.length === 1 ? staff[0]!.id : (start.staffId ?? ''));
  const [memo, setMemo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.menus().then(setMenus, () => setMenus([]));
  }, [api]);
  useEffect(() => {
    const q = query.trim();
    if (picked || !q) return setCandidates([]);
    let alive = true;
    customers.list(q).then((list) => alive && setCandidates(list.slice(0, 5)));
    return () => {
      alive = false;
    };
  }, [customers, query, picked]);

  const startAt = date && time ? shopIso(date, time) : null;
  const staffName = staff.find((s) => s.id === staffId)?.name;
  const ready = picked !== null && staffId !== '' && startAt !== null;

  const pickMenu = (id: string) => {
    setMenuId(id);
    const m = menus.find((x) => x.id === id);
    if (m) {
      setDuration(m.durationMin);
      setPrep(m.prepMin);
    }
  };

  const save = async () => {
    if (!ready || !startAt) return;
    setBusy(true);
    setError(null);
    try {
      // 1) 같은 규칙으로 먼저 검사해 거부 이유를 문구로(새 고객을 헛되이 만들지 않게). 최종 판정은 저장소가 다시 한다.
      const day = shopDate(Date.parse(startAt));
      const data = await api.range(addDays(day, -1), addDays(day, 1));
      const { hours, existing, blocks } = toBookingInputs(data);
      const check = checkBooking(
        {
          staffId,
          start: new Date(startAt),
          durationMin: duration,
          prepMin: prep,
        },
        hours,
        existing,
        blocks,
      );
      if (!check.ok)
        return setError(
          rejectText(check.reason, check.conflictingIds, {
            data,
            staffId,
            startAt,
          }),
        );
      // 2) 새 고객이면 이름만으로 등록(01 §2.3)
      const customer = picked.id
        ? picked
        : {
            ...(await customers.create({
              name: picked.name,
              phone: null,
              memo: null,
            })),
            phone: null,
          };
      const menu = menus.find((m) => m.id === menuId);
      const r = await api.createAppointment({
        customerId: customer.id,
        customerName: customer.name,
        customerPhone: customer.phone,
        menuName: menu?.name ?? null,
        staffId,
        startAt,
        durationMin: duration,
        prepMin: prep,
        memo: memo.trim() || null,
      });
      if (!r.ok) return setError(rejectText(r.reason, r.conflictingIds, { data, staffId, startAt }));
      onSaved(day);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <ResponsiveSidePanel.Body className={cn(sheetBodyClass(phone), 'gap-3.5')}>
        <div className="relative">
          <Field.Root>
            <Field.Header>
              <Field.Label>고객</Field.Label>
            </Field.Header>
            <TextField.Root size="large">
              <TextField.PrefixIcon svg={<Search />} />
              <TextField.Input
                value={picked ? picked.name : query}
                placeholder="이름 두 글자"
                autoComplete="off"
                onChange={(e) => {
                  setPicked(null);
                  setQuery(e.target.value);
                }}
              />
            </TextField.Root>
          </Field.Root>
          {!picked && query.trim() && (
            <ul role="listbox" aria-label="고객 후보" className="mt-1 overflow-hidden rounded-xl border border-line bg-floating">
              {candidates.map((c) => (
                <li key={c.id} role="option" aria-selected={false}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between px-3.5 py-2.5 text-left text-[15px]"
                    onClick={() => setPicked({ id: c.id, name: c.name, phone: c.phone })}
                  >
                    <b>{c.name}</b>
                    {/* 같은 이름이면 전화 뒤 4자리로 구별(W3) */}
                    <span className="text-sm text-ink-soft tabular-nums">{c.phone ? `···${c.phone.slice(-4)}` : '전화 없음'}</span>
                  </button>
                </li>
              ))}
              <li role="option" aria-selected={false} className="border-t border-line first:border-t-0">
                <button
                  type="button"
                  className="w-full px-3.5 py-2.5 text-left text-[15px] font-bold text-brand-text"
                  onClick={() => setPicked({ id: null, name: query.trim(), phone: null })}
                >
                  "{query.trim()}" 새 고객으로 넣기
                </button>
              </li>
            </ul>
          )}
        </div>

        {menus.length > 0 && (
          <div className="grid gap-2">
            <span className="pl-0.5 text-sm font-medium" id="menu-label">
              메뉴
            </span>
            <Chip.RadioRoot aria-labelledby="menu-label" value={menuId} onValueChange={pickMenu} className="flex flex-wrap gap-2">
              {menus.map((m) => (
                <Chip.RadioItem key={m.id} value={m.id} variant="outlineStrong" size="medium">
                  <RadioGroupItemHiddenInput />
                  <Chip.Label>{m.name}</Chip.Label>
                </Chip.RadioItem>
              ))}
            </Chip.RadioRoot>
          </div>
        )}

        {/* 날짜·시작은 누르기만(11/22 옵마): 달력 팝업 / 영업시간 안 15분 목록(폰 휠, 웹 펼치는 목록) */}
        <div className="flex gap-2.5">
          <div className="grid min-w-0 flex-1 gap-1.5">
            <label htmlFor="entry-date" className="text-sm font-bold text-ink">
              날짜
            </label>
            <DateField id="entry-date" value={date} onChange={setDate} />
          </div>
          <div className="grid w-[45%] gap-1.5">
            <label htmlFor="entry-time" className="text-sm font-bold text-ink">
              시작
            </label>
            <TimeField id="entry-time" value={time} options={startTimes(date, businessHours)} onChange={setTime} phone={phone} />
          </div>
        </div>

        <Stepper label="관리 시간" value={duration} step={10} min={10} onChange={setDuration} />
        <Stepper label="준비 시간" value={prep} step={5} min={0} onChange={setPrep} />

        {staff.length > 1 && (
          <div className="grid gap-2">
            <span className="pl-0.5 text-sm font-medium" id="staff-label">
              담당자
            </span>
            <Chip.RadioRoot aria-labelledby="staff-label" value={staffId} onValueChange={setStaffId} className="flex flex-wrap gap-2">
              {staff.map((s) => (
                <Chip.RadioItem key={s.id} value={s.id} variant="outlineStrong" size="medium">
                  <RadioGroupItemHiddenInput />
                  <Chip.Label>{s.name}</Chip.Label>
                </Chip.RadioItem>
              ))}
            </Chip.RadioRoot>
          </div>
        )}

        <Field.Root>
          <Field.Header>
            <Field.Label>
              메모 <Field.IndicatorText>(선택)</Field.IndicatorText>
            </Field.Label>
          </Field.Header>
          <TextField.Root size="large">
            <TextField.Textarea autoresize className="min-h-12" value={memo} onChange={(e) => setMemo(e.target.value)} />
          </TextField.Root>
        </Field.Root>
      </ResponsiveSidePanel.Body>
      <ResponsiveSidePanel.Footer className={sheetFootClass(phone)}>
        {/* 미리보기·거부 알림은 저장 버튼 바로 위(F1-5·6) — 메모 칸이 길어도 가려지지 않게 발에 둔다. */}
        <div className="grid w-full gap-3.5">
          {/* 점유 미리보기(결정 R33) */}
          {startAt && staffName && (
            <p aria-live="polite" className="flex items-start gap-2 rounded-xl bg-brand-weak px-3 py-2.5 text-[15px] text-cal-appt-text">
              <CalendarDays aria-hidden size={20} className="mt-px flex-none" />
              {occupancyText(startAt, duration, prep, staffName)}
            </p>
          )}
          {error && (
            <Callout.Root tone="critical" role="alert">
              <Callout.Content>
                <Callout.Title>저장하지 못했어요</Callout.Title>
                <Callout.Description>{error}</Callout.Description>
              </Callout.Content>
            </Callout.Root>
          )}
          <ActionButton variant="brandSolid" size="large" disabled={!ready} loading={busy} onClick={save}>
            저장
          </ActionButton>
        </div>
      </ResponsiveSidePanel.Footer>
    </>
  );
}

/** 분 −/+ (디자인 .stepper: 48px 높이, 12px 모서리, 가는 테두리). */
function Stepper({
  label,
  value,
  step,
  min,
  onChange,
}: {
  label: string;
  value: number;
  step: number;
  min: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="pl-0.5 text-sm font-medium">{label}</span>
      <span role="group" aria-label={label} className="inline-flex h-12 items-center rounded-xl shadow-[inset_0_0_0_1px_var(--line)]">
        <button
          type="button"
          aria-label={`${step}분 줄이기`}
          disabled={value - step < min}
          onClick={() => onChange(value - step)}
          className="grid h-12 w-11 place-items-center disabled:text-ink-disabled"
        >
          <Minus aria-hidden size={20} />
        </button>
        <span aria-live="polite" className="min-w-16 text-center font-bold tabular-nums">
          {value}분
        </span>
        <button
          type="button"
          aria-label={`${step}분 늘리기`}
          onClick={() => onChange(value + step)}
          className="grid h-12 w-11 place-items-center"
        >
          <Plus aria-hidden size={20} />
        </button>
      </span>
    </div>
  );
}

// ── W4 관리 불가 시간 ─────────────────────────────────────────

const hhmmPlus = (time: string, min: number) => {
  const t = Math.min(24 * 60 - 1, Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)) + min);
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

function BlockForm({ start, staff, onSaved }: { start: EntryStart; staff: Staff[]; onSaved: (date: string) => void }) {
  const api = useCalendarApi();
  const phone = useIsPhone();
  const [from, setFrom] = useState(`${start.date}T${start.time}`);
  const [to, setTo] = useState(`${start.date}T${hhmmPlus(start.time, 120)}`);
  const [allStaff, setAllStaff] = useState(false);
  const [who, setWho] = useState<string[]>(start.staffId ? [start.staffId] : staff.length === 1 ? [staff[0]!.id] : []);
  const [memo, setMemo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [around, setAround] = useState<CalendarData | null>(null);

  const startAt = from ? shopIso(from.slice(0, 10), from.slice(11, 16)) : null;
  const endAt = to ? shopIso(to.slice(0, 10), to.slice(11, 16)) : null;
  const valid = startAt !== null && endAt !== null && Date.parse(startAt) < Date.parse(endAt);
  // ASSUMPTION: 담당자가 1명이면 스위치·칩을 숨기고 그 담당자로 넣는다(앞으로 생길 담당자는 포함하지 않음).
  const ready = valid && (allStaff || who.length > 0);

  useEffect(() => {
    if (!startAt || !endAt) return;
    let alive = true;
    api
      .range(shopDate(Date.parse(startAt)), shopDate(Math.max(Date.parse(startAt), Date.parse(endAt) - 1)))
      .then((d) => alive && setAround(d));
    return () => {
      alive = false;
    };
  }, [api, startAt, endAt]);

  // 겹치는 예약 미리 알림(결정 R50) — 서버와 같은 blockedAppointmentIds
  const overlapping = useMemo(() => {
    if (!around || !valid || !startAt || !endAt) return [];
    const ids = new Set(
      blockedAppointmentIds(
        {
          id: 'new',
          start: new Date(startAt),
          end: new Date(endAt),
          allStaff,
          staffIds: who,
        },
        around.appointments.map((a) => ({
          id: a.id,
          staffId: a.staffId,
          status: a.status,
          occupied: occupiedOf({
            start: new Date(a.startAt),
            durationMin: a.durationMin,
            prepMin: a.prepMin,
          }),
        })),
      ),
    );
    return around.appointments.filter((a) => ids.has(a.id));
  }, [around, valid, startAt, endAt, allStaff, who]);

  const save = async () => {
    if (!startAt || !endAt) return;
    if (!valid) return setError('끝이 시작보다 늦어야 해요.');
    setBusy(true);
    try {
      await api.createBlock({
        startAt,
        endAt,
        allStaff,
        staffIds: allStaff ? [] : who,
        memo: memo.trim() || null,
      });
      onSaved(shopDate(Date.parse(startAt)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <ResponsiveSidePanel.Body className={cn(sheetBodyClass(phone), 'gap-3.5')}>
        <Field.Root>
          <Field.Header>
            <Field.Label>시작</Field.Label>
          </Field.Header>
          <TextField.Root size="large">
            <TextField.Input type="datetime-local" step={900} value={from} onChange={(e) => setFrom(e.target.value)} />
          </TextField.Root>
        </Field.Root>
        <Field.Root>
          <Field.Header>
            <Field.Label>끝</Field.Label>
          </Field.Header>
          <TextField.Root size="large">
            <TextField.Input type="datetime-local" step={900} value={to} onChange={(e) => setTo(e.target.value)} />
          </TextField.Root>
        </Field.Root>
        {staff.length > 1 && (
          <>
            <Switch.Root checked={allStaff} onCheckedChange={setAllStaff} size="32" className="flex items-center justify-between">
              <Switch.Label className="text-base">모든 담당자</Switch.Label>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
              <Switch.HiddenInput />
            </Switch.Root>
            {!allStaff && (
              <div className="grid gap-2">
                <span className="pl-0.5 text-sm font-medium" id="who-label">
                  누구
                </span>
                <div role="group" aria-labelledby="who-label" className="flex flex-wrap gap-2">
                  {staff.map((s) => (
                    <Chip.Toggle
                      key={s.id}
                      variant="outlineStrong"
                      size="medium"
                      checked={who.includes(s.id)}
                      onCheckedChange={(on) => setWho((w) => (on ? [...w, s.id] : w.filter((x) => x !== s.id)))}
                    >
                      <CheckboxHiddenInput />
                      <Chip.Label>{s.name}</Chip.Label>
                    </Chip.Toggle>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
        <Field.Root>
          <Field.Header>
            <Field.Label>
              메모 <Field.IndicatorText>(선택)</Field.IndicatorText>
            </Field.Label>
          </Field.Header>
          <TextField.Root size="large">
            <TextField.Input value={memo} onChange={(e) => setMemo(e.target.value)} />
          </TextField.Root>
        </Field.Root>
        {overlapping.length > 0 && (
          <Callout.Root tone="warning">
            <Callout.Content>
              <Callout.Title>이 시간에 예약 {overlapping.length}건이 있어요</Callout.Title>
              <Callout.Description>
                {overlapping.map((a) => `${a.customerName} · ${shopTime(a.startAt)} ${a.menuName ?? ''}`.trim()).join(', ')}. 예약은 그대로
                두고 캘린더에 겹침으로 표시해요.
              </Callout.Description>
            </Callout.Content>
          </Callout.Root>
        )}
        {error && (
          <Callout.Root tone="critical" role="alert">
            <Callout.Content>
              <Callout.Title>저장하지 못했어요</Callout.Title>
              <Callout.Description>{error}</Callout.Description>
            </Callout.Content>
          </Callout.Root>
        )}
      </ResponsiveSidePanel.Body>
      <ResponsiveSidePanel.Footer className={sheetFootClass(phone)}>
        <ActionButton variant="brandSolid" size="large" flexGrow={1} disabled={!ready} loading={busy} onClick={save}>
          저장
        </ActionButton>
      </ResponsiveSidePanel.Footer>
    </>
  );
}
