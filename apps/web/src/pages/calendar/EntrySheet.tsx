// 예약 넣기 W3 (화면 설계서 §4 F1·§5 W3, 디자인 w2.png 가운데). 관리 불가 시간(W4)은 다음 PR에서 세그먼트로 붙인다.
// 폰은 큰 아래 시트, 웹은 오른쪽 패널(W2와 같은 틀). 저장 검사는 서버와 같은 @bv/scheduling checkBooking(절대 규칙 4) —
// 거부되면 저장 버튼 위 빨간 알림(W3 거부 표).
import { checkBooking } from '@bv/scheduling/booking';
import type { Candidate } from '@bv/customers/duplicates';
import {
  ActionButton,
  AlertDialog,
  Icon,
  Callout,
  Chip,
  Field,
  RadioGroupItemHiddenInput,
  ResponsiveSidePanel,
  TextField,
} from '@seed-design/react';
import { CalendarDays, Minus, Plus, Search, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toBookingInputs, useCalendarApi, type AppointmentChange, type NewAppointment } from '@/features/calendar/api';
import { occupancyText, rejectText, shopIso, shortDate } from '@/features/calendar/bookingText';
import { addDays, shopDate, shopTime, startTimes, type CalendarAppointment, type CalendarData, type Menu, type Staff } from '@/features/calendar/model';
import { CustomerValidationError, useCustomerApi } from '@/features/customers/api';
import type { Customer } from '@/features/customers/model';
import { NetworkError } from '@/lib/http';
import { useRetryKey } from '@/lib/retryKey';
import { useIsPhone } from '@/lib/useLayout';
import { cn } from '@/lib/utils';
import { DateField, TimeField } from './DateTimeFields';
import { CalendarSheet, sheetBodyClass, sheetFootClass, sheetHeadClass, titleClass } from './Sheet';

export interface EntryStart {
  /** 매장 날짜 'YYYY-MM-DD'. */
  date: string;
  /** 'HH:MM'. null = `+ 예약`으로 열었다 — 시각은 원장이 직접 고른다(설계 06 D1). */
  time: string | null;
  staffId: string | null;
  /** 있으면 W2 "바꾸기" — 이 예약의 최신 상세를 읽어 편집한다(설계 06 ①·D4). */
  editId?: string;
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

export function EntrySheet({ start, staff, businessHours = null, onClose, onSaved }: Props) {
  const phone = useIsPhone();
  // 입력을 바꿨으면 닫기 전에 묻는다(설계 06 D4). 저장 중에는 닫지 않는다.
  const [dirty, setDirty] = useState(false);
  const [asking, setAsking] = useState(false);
  const saving = useRef(false);
  const [busy, setBusy] = useState(false);
  const setSaving = (next: boolean) => {
    saving.current = next;
    setBusy(next);
  };
  const close = () => {
    if (saving.current) return;
    if (dirty) setAsking(true);
    else onClose();
  };
  const reset = () => {
    setDirty(false);
    setAsking(false);
  };
  return (
    <CalendarSheet open={start !== null} onClose={close} full>
      {start && (
        <>
          <ResponsiveSidePanel.Header className={sheetHeadClass(phone)}>
            <div className="flex items-center justify-between gap-2">
              <ResponsiveSidePanel.Title className={cn(titleClass, 'text-xl font-bold tracking-[-0.02em]')}>
                {start.editId ? '예약 바꾸기' : '예약 넣기'}
              </ResponsiveSidePanel.Title>
              <ActionButton variant="ghost" size="small" layout="iconOnly" aria-label="닫기" disabled={busy} onClick={close}>
                <Icon svg={<X />} />
              </ActionButton>
            </div>
          </ResponsiveSidePanel.Header>
          <AppointmentForm
            key={start.editId ?? 'new'}
            start={start}
            staff={staff}
            businessHours={businessHours}
            onDirty={setDirty}
            busy={busy}
            saving={saving}
            setSaving={setSaving}
            onSaved={(d) => {
              reset();
              onSaved(d);
            }}
          />
          {/* 확인 창은 시트 안에 둔다 — 밖에 두면 폰 아래 시트 뒤로 가려진다(W2 취소 확인과 같은 자리). */}
          <AlertDialog.Root open={asking} onOpenChange={setAsking}>
            <AlertDialog.Backdrop />
            <AlertDialog.Positioner>
              <AlertDialog.Content>
                <AlertDialog.Header>
                  <AlertDialog.Title>입력한 내용이 저장되지 않았어요. 닫을까요?</AlertDialog.Title>
                </AlertDialog.Header>
                <AlertDialog.Footer>
                  <AlertDialog.Action asChild>
                    <ActionButton variant="neutralWeak" size="large" flexGrow={1}>
                      계속 입력
                    </ActionButton>
                  </AlertDialog.Action>
                  <ActionButton
                    variant="criticalSolid"
                    size="large"
                    flexGrow={1}
                    disabled={busy}
                    onClick={() => {
                      if (saving.current) return;
                      reset();
                      onClose();
                    }}
                  >
                    닫기
                  </ActionButton>
                </AlertDialog.Footer>
              </AlertDialog.Content>
            </AlertDialog.Positioner>
          </AlertDialog.Root>
        </>
      )}
    </CalendarSheet>
  );
}

// ── W3 예약 넣기 ─────────────────────────────────────────

/** 고른 고객. id가 null이면 아직 등록 전인 새 고객(이름만). */
type Picked = { id: string | null; name: string; phone: string | null };

const DEFAULT_DURATION = 60;
/** 메뉴가 없으면 준비 시간 기본 10분(PM 메모 닫힌 항목). 요청에 명시한다 — 생략하면 서버는 0분(설계 06 ④). */
const DEFAULT_PREP = 10;
/** 고객 검색은 두 글자부터(설계 06 ②). */
const MIN_QUERY = 2;

const CUSTOMER_SAVED_TEXT = '고객은 등록됐어요. 예약은 저장되지 않았어요.';
/** 예약 응답을 못 받음 — 저장됐을 수도 있다. 단정하지 않고, 다시 저장하면 같은 요청으로 확인한다(#74 리뷰). */
const APPOINTMENT_UNKNOWN_TEXT = '예약이 저장됐는지 확인하지 못했어요. 다시 저장하면 같은 요청으로 확인해요.';
const NETWORK_TEXT = '저장 결과를 확인하지 못했어요. 같은 내용으로 다시 시도해 주세요.';
/** 바꾸기: 그사이 다른 곳에서 바뀜(409). 입력은 두고 최신 값을 불러와 확인한 뒤 다시 저장한다(설계 05 D4·06 거부 표). */
const EDIT_CONFLICT_TEXT = '그사이 다른 곳에서 이 예약이 바뀌었어요. 최신 값을 불러와 확인한 뒤 다시 저장해 주세요.';
const EDIT_UNKNOWN_TEXT = '바꾼 내용이 저장됐는지 확인하지 못했어요. 다시 저장하면 같은 요청으로 확인해요.';
const EDIT_KEYS = ['customerId', 'menuId', 'staffId', 'startAt', 'durationMin', 'prepMin', 'memo'] as const;
type EditKey = (typeof EDIT_KEYS)[number];

function AppointmentForm({
  start,
  staff: allStaff,
  onDirty,
  busy,
  saving,
  setSaving,
  businessHours,
  onSaved,
}: {
  start: EntryStart;
  staff: Staff[];
  onDirty: (dirty: boolean) => void;
  busy: boolean;
  saving: { readonly current: boolean };
  setSaving: (busy: boolean) => void;
  businessHours: CalendarData['businessHours'];
  onSaved: (date: string) => void;
}) {
  const api = useCalendarApi();
  const customers = useCustomerApi();
  const phone = useIsPhone();
  // 새 예약에는 사용 중인 담당자만(설계 04 D3·06 ⑤). 1명이면 자동, 0명이면 저장할 수 없다.
  // 바꾸기에서는 이 예약의 기존 담당자가 숨김이어도 그대로 둘 수 있다(06 ⑤).
  const [base, setBase] = useState<CalendarAppointment | null>(null);
  const staff = allStaff.filter((s) => s.active !== false || s.id === base?.staffId);
  const [menus, setMenus] = useState<Menu[]>([]);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Picked | null>(null);
  /** 검색 결과. null = 아직 결과를 받지 못함(새 고객 제안은 결과가 비었을 때만, 06 ③). */
  const [candidates, setCandidates] = useState<Customer[] | null>(null);
  /** 새 고객 등록 전 같은 이름 후보 — 고르거나 "새 고객이 맞아요"로 확인한다(06 ③). */
  const [sameName, setSameName] = useState<Candidate[] | null>(null);
  const [menuId, setMenuId] = useState<string>('');
  const [date, setDate] = useState(start.date);
  const [time, setTime] = useState(start.time ?? '');
  const [duration, setDuration] = useState(DEFAULT_DURATION);
  const [prep, setPrep] = useState(DEFAULT_PREP);
  const lane = start.staffId && staff.some((s) => s.id === start.staffId) ? start.staffId : '';
  const [staffId, setStaffId] = useState<string>(staff.length === 1 ? staff[0]!.id : lane);
  // 날짜·시각·담당자를 손으로 바꿨는가 — 패널이 열린 채 다른 빈 칸을 누르면 덮어쓰기 전에 묻는다(#69 리뷰).
  const [startEdited, setStartEdited] = useState(false);
  const [pendingStart, setPendingStart] = useState<EntryStart | null>(null);
  const shownStart = useRef(start);
  const applyStart = (s: EntryStart) => {
    setDate(s.date);
    setTime(s.time ?? '');
    if (s.staffId && staff.some((x) => x.id === s.staffId)) setStaffId(s.staffId);
    setStartEdited(false);
    setPendingStart(null);
  };
  useEffect(() => {
    // 웹 패널은 모달이 아니라 열린 채 다른 칸을 누를 수 있다: 새 칸의 날짜·시각·담당자로 바꾼다(손으로 바꿨으면 먼저 묻기).
    if (start === shownStart.current) return;
    shownStart.current = start;
    if (startEdited) setPendingStart(start);
    else applyStart(start);
  }, [start]);
  useEffect(() => {
    // 캘린더를 불러오는 중에 열면 담당자가 아직 없다 — 도착한 담당자가 1명이면 그 사람으로(F1-4, #69 리뷰).
    if (staffId === '' && staff.length === 1) setStaffId(staff[0]!.id);
  }, [staff, staffId]);
  const [memo, setMemo] = useState('');
  const [error, setError] = useState<string | null>(null);
  // 고객·예약은 서로 다른 키. 응답을 못 받으면 같은 내용·같은 키로 다시(설계 05 D5·06 D2).
  const customerKey = useRetryKey();
  const appointmentKey = useRetryKey();
  /** 결과를 모르는 예약 요청(응답 유실). 다음 저장은 새 검사 없이 이것부터 같은 키로 다시 보낸다(설계 05 D5). */
  const unsettled = useRef<{ input: NewAppointment; key: string } | null>(null);
  /** 이 화면에서 새로 등록한 고객인가 — 예약이 안 되면 "고객은 등록됐어요"를 붙인다. */
  const createdCustomer = useRef(false);
  /** 바꾸기: 최신 상세 불러오기 상태와, 결과를 모르는 바꾸기 요청. */
  const [loadFailed, setLoadFailed] = useState(false);
  const [conflict, setConflict] = useState(false);
  const unsettledEdit = useRef<{ change: AppointmentChange; key: string } | null>(null);
  /** 바꾸기에서 고객 칸을 건드렸는가 — 안 건드렸으면 고객은 그대로(숨긴 고객이어도 유지, 06 ③). */
  const customerTouched = useRef(false);
  /** 바꾸기에서 원장이 손댄 칸. 충돌 뒤 최신 값을 불러오면 손대지 않은 칸은 최신 값으로 맞춘다 — 다른 곳의 변경을 덮지 않게(#77 리뷰). */
  const edited = useRef(new Set<EditKey>());
  const mark = (...keys: EditKey[]) => {
    for (const k of keys) edited.current.add(k);
  };
  /** 최신 상세로 칸을 채운다. only가 있으면 그 칸만. */
  const fill = (a: CalendarAppointment, only?: (k: EditKey) => boolean) => {
    const want = (k: EditKey) => !only || only(k);
    if (want('customerId')) setPicked({ id: a.customerId ?? null, name: a.customerName, phone: a.customerPhone ?? null });
    if (want('menuId')) setMenuId(a.menuId ?? '');
    if (want('startAt')) {
      setDate(shopDate(Date.parse(a.startAt)));
      setTime(shopTime(a.startAt));
    }
    if (want('durationMin')) setDuration(a.durationMin);
    if (want('prepMin')) setPrep(a.prepMin);
    if (want('staffId')) setStaffId(a.staffId);
    if (want('memo')) setMemo(a.memo ?? '');
  };
  const loadLatest = async (fillDraft: boolean) => {
    if (!start.editId) return;
    setLoadFailed(false);
    try {
      const a = await api.appointment(start.editId);
      if (!a) return setError('예약을 찾을 수 없어요. 캘린더를 다시 불러와 주세요.');
      setBase(a);
      if (fillDraft) fill(a);
      else fill(a, (k) => !edited.current.has(k));
    } catch {
      setLoadFailed(true);
    }
  };
  useEffect(() => {
    void loadLatest(true);
    // 편집을 열 때 한 번만 읽는다(최신 version) — 충돌 뒤에는 "최신 값 불러오기"로 다시 읽는다.
  }, []);
  const touched = <T,>(setter: (v: T) => void) => (v: T) => {
    onDirty(true);
    setError(null);
    setter(v);
  };

  useEffect(() => {
    api.menus().then(setMenus, () => setMenus([]));
  }, [api]);
  useEffect(() => {
    const q = query.trim();
    setCandidates(null);
    if (picked || q.length < MIN_QUERY) return;
    let alive = true; // 검색어가 바뀌면 늦게 온 이전 결과는 버린다.
    customers.list(q).then(
      (list) => alive && setCandidates(list.filter((c) => c.active !== false).slice(0, 5)),
      () => alive && setCandidates([]),
    );
    return () => {
      alive = false;
    };
  }, [customers, query, picked]);

  const startAt = date && time ? shopIso(date, time) : null;
  const staffName = staff.find((s) => s.id === staffId)?.name;
  const editing = start.editId !== undefined;
  const ready = picked !== null && staffId !== '' && startAt !== null && sameName === null && (!editing || base !== null);

  const pickMenu = (id: string) => {
    touched(setMenuId)(id);
    mark('menuId');
    const m = menus.find((x) => x.id === id);
    // 메뉴에 정해 둔 값만 덮어쓴다(06 D3).
    if (m?.durationMin != null) {
      setDuration(m.durationMin);
      mark('durationMin');
    }
    if (m?.prepMin != null) {
      setPrep(m.prepMin);
      mark('prepMin');
    }
  };

  /** 새 고객 등록. 성공하면 고른 고객에 id를 넣어 둔다 — 예약이 실패해 다시 저장해도 고객을 또 만들지 않는다. */
  const ensureCustomer = async (who: Picked): Promise<Picked | null> => {
    if (who.id) return who;
    const input = { name: who.name, phone: null, memo: null };
    try {
      const created = await customers.create(input, { idempotencyKey: customerKey.keyFor(JSON.stringify(input)) });
      customerKey.settle();
      createdCustomer.current = true;
      const saved = { id: created.id, name: created.name, phone: created.phone };
      setPicked(saved);
      return saved;
    } catch (err) {
      if (err instanceof NetworkError) setError(NETWORK_TEXT);
      else {
        customerKey.settle();
        setError(err instanceof CustomerValidationError ? '고객 이름을 확인해 주세요.' : '고객을 등록하지 못했어요. 다시 시도해 주세요.');
      }
      return null;
    }
  };

  /** W2 바꾸기 저장(설계 06 ①·D4, 04 Q1·D2): 읽은 version과 바뀐 칸만 PATCH. */
  const saveEdit = async (confirmedNew: boolean) => {
    if (!base || !picked || !startAt) return;
    setConflict(false);
    // 결과를 모르는 바꾸기가 있으면 같은 요청·같은 키부터 다시 보낸다(설계 05 D5).
    if (unsettledEdit.current) {
      const { change, key } = unsettledEdit.current;
      const again = await api.updateAppointment(base.id, change, { idempotencyKey: key });
      if (again.ok) return onSaved(shopDate(Date.parse(again.value.startAt)));
      if (again.reason === 'NETWORK') return setError(EDIT_UNKNOWN_TEXT);
      unsettledEdit.current = null;
      appointmentKey.settle();
      if (again.reason === 'VERSION_CONFLICT') {
        setConflict(true);
        return setError(EDIT_CONFLICT_TEXT);
      }
    }
    if (!picked.id && !confirmedNew) {
      const r = await customers.checkSameName({ name: picked.name, phone: null });
      if (r.needsReview) return setSameName(r.candidates);
    }
    setSameName(null);
    const customer = customerTouched.current ? await ensureCustomer(picked) : { ...picked, id: base.customerId ?? null };
    if (customerTouched.current && !customer?.id) return;
    const menu = menus.find((m) => m.id === menuId);
    const draft = {
      customerId: customer!.id ?? undefined,
      menuId: menuId === '' ? null : menuId,
      staffId,
      startAt,
      durationMin: duration,
      prepMin: prep,
      memo: memo.trim() || null,
    };
    const fields = EDIT_KEYS.filter((k) =>
      k === 'startAt' ? Date.parse(draft.startAt) !== Date.parse(base.startAt) : (draft[k] ?? null) !== (base[k] ?? null),
    );
    if (fields.length === 0) return onSaved(shopDate(Date.parse(base.startAt)));
    const has = (k: (typeof EDIT_KEYS)[number]) => fields.includes(k);
    // 화면에서 먼저 같은 규칙으로 검사(자기 자신 제외). 시작·끝이 바뀌면 영업시간까지, 준비·담당자만이면 겹침만(04 D2).
    const end = (a: { startAt: string; durationMin: number }) => Date.parse(a.startAt) + a.durationMin * 60_000;
    const moved = has('startAt') || end(draft) !== end(base);
    const day = shopDate(Date.parse(startAt));
    const data = await api.range(addDays(day, -1), addDays(day, 1));
    const ctx = { data, staffId, startAt };
    if (moved || has('prepMin') || has('staffId')) {
      const { hours, existing, blocks } = toBookingInputs(data);
      const check = checkBooking({ staffId, start: new Date(startAt), durationMin: duration, prepMin: prep }, hours, existing, blocks, {
        excludeId: base.id,
        skipHoursCheck: !moved,
      });
      if (!check.ok) return setError(rejectText(check.reason, check.conflictingIds, ctx));
    }
    const change: AppointmentChange = { version: base.version ?? 1 };
    for (const k of fields) Object.assign(change, { [k]: draft[k] });
    // 가짜 저장소의 카드 이름(실제 API는 보내지 않는다).
    if (has('customerId')) Object.assign(change, { customerName: customer!.name, customerPhone: customer!.phone });
    if (has('menuId')) change.menuName = menu?.name ?? null;
    const key = appointmentKey.keyFor(JSON.stringify([base.id, change]));
    const r = await api.updateAppointment(base.id, change, { idempotencyKey: key });
    if (r.ok) {
      appointmentKey.settle();
      return onSaved(shopDate(Date.parse(r.value.startAt)));
    }
    if (r.reason === 'NETWORK') {
      unsettledEdit.current = { change, key };
      return setError(EDIT_UNKNOWN_TEXT);
    }
    appointmentKey.settle();
    if (r.reason === 'VERSION_CONFLICT') {
      setConflict(true);
      return setError(EDIT_CONFLICT_TEXT);
    }
    setError(rejectText(r.reason, r.conflictingIds, ctx));
  };

  const save = async (confirmedNew = false) => {
    if (saving.current || !picked || staffId === '' || !startAt) return;
    if (editing) {
      setSaving(true);
      setError(null);
      try {
        await saveEdit(confirmedNew);
      } catch (err) {
        setError(err instanceof NetworkError ? NETWORK_TEXT : '저장하지 못했어요. 다시 시도해 주세요.');
      } finally {
        setSaving(false);
      }
      return;
    }
    setSaving(true);
    setError(null);
    const customerNote = () => (createdCustomer.current ? '고객은 등록됐어요. ' : '');
    try {
      // 결과를 모르는 예약이 있으면 먼저 같은 요청·같은 키로 확인한다. 이미 저장됐다면 서버가 처음 응답을 돌려준다 —
      // 새로 검사하면 방금 저장된 자기 예약과 겹친다고 거부될 수 있다(#74 리뷰).
      if (unsettled.current) {
        const { input, key } = unsettled.current;
        const again = await api.createAppointment(input, { idempotencyKey: key });
        if (again.ok) {
          unsettled.current = null;
          appointmentKey.settle();
          return onSaved(shopDate(Date.parse(again.value.startAt)));
        }
        if (again.reason === 'NETWORK') return setError(`${customerNote()}${APPOINTMENT_UNKNOWN_TEXT}`);
        // 처음 요청이 확실히 거절됐다 — 저장되지 않았으니 지금 입력으로 새로 저장한다.
        unsettled.current = null;
        appointmentKey.settle();
      }
      // 0) 새 고객이면 같은 이름 고객이 있는지 먼저 묻는다(읽기 — 키 없음).
      if (!picked.id && !confirmedNew) {
        const r = await customers.checkSameName({ name: picked.name, phone: null });
        if (r.needsReview) return setSameName(r.candidates);
      }
      setSameName(null);
      // 1) 같은 규칙으로 먼저 검사해 거부 이유를 문구로(새 고객을 헛되이 만들지 않게). 최종 판정은 서버가 다시 한다.
      const day = shopDate(Date.parse(startAt));
      const data = await api.range(addDays(day, -1), addDays(day, 1));
      const ctx = { data, staffId, startAt };
      const { hours, existing, blocks } = toBookingInputs(data);
      const check = checkBooking({ staffId, start: new Date(startAt), durationMin: duration, prepMin: prep }, hours, existing, blocks);
      if (!check.ok) return setError(rejectText(check.reason, check.conflictingIds, ctx));
      // 2) 고객 → 예약 순서로 따로 저장(06 D2).
      const wasNew = !picked.id;
      const customer = await ensureCustomer(picked);
      if (!customer?.id) return;
      const menu = menus.find((m) => m.id === menuId);
      const input: NewAppointment = {
        customerId: customer.id,
        customerName: customer.name,
        customerPhone: customer.phone,
        menuId: menu?.id ?? null,
        menuName: menu?.name ?? null,
        staffId,
        startAt,
        durationMin: duration,
        prepMin: prep,
        memo: memo.trim() || null,
      };
      const key = appointmentKey.keyFor(JSON.stringify(input));
      const r = await api.createAppointment(input, { idempotencyKey: key });
      if (r.ok) {
        appointmentKey.settle();
        return onSaved(shopDate(Date.parse(r.value.startAt)));
      }
      if (r.reason === 'NETWORK') {
        unsettled.current = { input, key };
        return setError(`${customerNote()}${APPOINTMENT_UNKNOWN_TEXT}`);
      }
      appointmentKey.settle();
      const why = rejectText(r.reason, r.conflictingIds, ctx);
      setError(wasNew || createdCustomer.current ? `${CUSTOMER_SAVED_TEXT} ${why}` : why);
    } catch (err) {
      setError(err instanceof NetworkError ? NETWORK_TEXT : '저장하지 못했어요. 다시 시도해 주세요.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <ResponsiveSidePanel.Body className={cn(sheetBodyClass(phone), 'gap-3.5')}>
        {editing && !base && (
          <p role="status" className="text-[15px] text-ink-soft">
            {loadFailed ? '예약을 불러오지 못했어요. ' : '예약을 불러오는 중…'}
            {loadFailed && (
              <button type="button" className="font-bold underline" onClick={() => loadLatest(true)}>
                다시 불러오기
              </button>
            )}
          </p>
        )}
        {editing && base && conflict && !error && (
          <p role="status" className="rounded-xl bg-neutral-weak p-3 text-sm">
            최신 값: {shortDate(shopDate(Date.parse(base.startAt)))} {shopTime(base.startAt)} · 관리 {base.durationMin}분 · 준비 {base.prepMin}분
            {base.menuName ? ` · ${base.menuName}` : ''} — 입력은 그대로 두었어요. 확인한 뒤 다시 저장해 주세요.
          </p>
        )}
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
                  onDirty(true);
                  customerTouched.current = true;
                  mark('customerId');
                  setError(null);
                  setSameName(null);
                  setPicked(null);
                  setQuery(e.target.value);
                }}
              />
            </TextField.Root>
          </Field.Root>
          {!picked && candidates && (
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
              {/* 새 고객 제안은 결과가 없을 때만(06 ③) */}
              {candidates.length === 0 && (
                <li role="option" aria-selected={false}>
                  <button
                    type="button"
                    className="w-full px-3.5 py-2.5 text-left text-[15px] font-bold text-brand-text"
                    onClick={() => setPicked({ id: null, name: query.trim(), phone: null })}
                  >
                    "{query.trim()}" 새 고객으로 넣기
                  </button>
                </li>
              )}
            </ul>
          )}
          {sameName && picked && (
            <div role="group" aria-label="같은 이름 고객" className="mt-2 grid gap-2 rounded-xl border border-line p-3 text-[15px]">
              <p className="font-bold">같은 이름의 고객이 있어요. 이분인가요?</p>
              {sameName.map((c) =>
                // 실제 API는 숨긴 고객도 후보에 넣는다(active=false, #42) — 새 예약에는 고를 수 없다(04 D3).
                (c as Candidate & { active?: boolean }).active === false ? (
                  <p key={c.customerId} className="text-ink-soft">
                    {c.name} {c.phone ? `···${c.phone.slice(-4)}` : '전화 없음'} — 숨긴 고객이라 고를 수 없어요
                  </p>
                ) : (
                  <button
                    key={c.customerId}
                    type="button"
                    className="flex justify-between rounded-lg px-2 py-1.5 text-left hover:bg-brand-weak"
                    onClick={() => {
                      setSameName(null);
                      setPicked({ id: c.customerId, name: c.name, phone: c.phone });
                    }}
                  >
                    <b>{c.name}</b>
                    <span className="text-sm text-ink-soft tabular-nums">{c.phone ? `···${c.phone.slice(-4)}` : '전화 없음'}</span>
                  </button>
                ),
              )}
              <ActionButton variant="neutralWeak" size="medium" loading={busy} onClick={() => save(true)}>
                새 고객이 맞아요, 저장
              </ActionButton>
            </div>
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

        {pendingStart && (
          // 새로 누른 칸으로 바꿀지 묻기(손으로 바꾼 날짜·시각·담당자를 그냥 덮어쓰지 않게)
          <div role="status" className="grid gap-2 rounded-xl bg-neutral-weak p-3 text-sm">
            <p>
              새로 누른 칸({shortDate(pendingStart.date)} {pendingStart.time}
              {pendingStart.staffId && staff.length > 1 ? ` · ${staff.find((x) => x.id === pendingStart.staffId)?.name ?? ''}` : ''})으로
              바꿀까요? 고른 날짜·시각·담당자가 바뀌어요.
            </p>
            <div className="flex gap-2">
              <ActionButton variant="neutralSolid" size="small" onClick={() => applyStart(pendingStart)}>
                바꾸기
              </ActionButton>
              <ActionButton variant="neutralWeak" size="small" onClick={() => setPendingStart(null)}>
                그대로 두기
              </ActionButton>
            </div>
          </div>
        )}
        {/* 날짜·시작은 누르기만(11/22 옵마): 달력 팝업 / 영업시간 안 15분 목록(폰 휠, 웹 펼치는 목록) */}
        <div className="flex gap-2.5">
          <div className="grid min-w-0 flex-1 gap-1.5">
            <label htmlFor="entry-date" className="text-sm font-bold text-ink">
              날짜
            </label>
            <DateField
              id="entry-date"
              value={date}
              onChange={(d) => {
                touched(setDate)(d);
                mark('startAt');
                setStartEdited(true);
              }}
            />
          </div>
          <div className="grid w-[45%] gap-1.5">
            <label htmlFor="entry-time" className="text-sm font-bold text-ink">
              시작
            </label>
            <TimeField
              id="entry-time"
              value={time}
              options={startTimes(date, businessHours)}
              onChange={(t) => {
                touched(setTime)(t);
                mark('startAt');
                setStartEdited(true);
              }}
              phone={phone}
            />
          </div>
        </div>

        <Stepper
          label="관리 시간"
          value={duration}
          step={10}
          min={10}
          onChange={(v) => {
            touched(setDuration)(v);
            mark('durationMin');
          }}
        />
        <Stepper
          label="준비 시간"
          value={prep}
          step={5}
          min={0}
          onChange={(v) => {
            touched(setPrep)(v);
            mark('prepMin');
          }}
        />

        {staff.length === 0 && (
          <Callout.Root tone="warning">
            <Callout.Content>
              <Callout.Description>담당자가 없어 저장할 수 없어요. 설정에서 담당자를 먼저 넣어 주세요.</Callout.Description>
            </Callout.Content>
          </Callout.Root>
        )}
        {staff.length > 1 && (
          <div className="grid gap-2">
            <span className="pl-0.5 text-sm font-medium" id="staff-label">
              담당자
            </span>
            <Chip.RadioRoot
              aria-labelledby="staff-label"
              value={staffId}
              onValueChange={(id) => {
                touched(setStaffId)(id);
                mark('staffId');
                setStartEdited(true);
              }}
              className="flex flex-wrap gap-2"
            >
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
            <TextField.Textarea
              autoresize
              className="min-h-12"
              value={memo}
              onChange={(e) => {
                touched(setMemo)(e.target.value);
                mark('memo');
              }}
            />
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
                <Callout.Description>
                  {error}
                  {conflict && (
                    <button
                      type="button"
                      className="ml-1 font-bold underline"
                      onClick={async () => {
                        await loadLatest(false);
                        setError(null);
                      }}
                    >
                      최신 값 불러오기
                    </button>
                  )}
                </Callout.Description>
              </Callout.Content>
            </Callout.Root>
          )}
          <ActionButton variant="brandSolid" size="large" disabled={!ready} loading={busy} onClick={() => save()}>
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
