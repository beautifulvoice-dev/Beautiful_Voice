// 매장 정보(W13, BEA-166 2A-1.1). 디자인(11/20 인계 w13.png "웹 · 설정 > 매장 정보"):
// 제목 옆 저장 / 영업시간 카드(요일 · "10:00 – 20:00" · 정기 휴무 스위치 · 안내 문구) / 위치·네이버 플레이스·인스타그램·홈페이지 카드 + 환불 정책.
// 정기 휴무는 매주 휴무(shop_closure.weekly)로 저장한다 — 휴무·휴가 화면에는 날짜 휴무만 있다(#63).
// 저장 검사는 서버와 같은 함수(@bv/scheduling/shop-settings)가 창구 안에서 한다 — 화면은 오류를 문구로 바꿔 보여 주기만 한다.
import type { BusinessHours, Closure, ShopInfo } from '@bv/contracts';
import { ActionButton, Callout, Switch } from '@seed-design/react';
import { useCallback, useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ErrorState } from '@/components/states/DataState';
import { SettingsNotFoundError, useSettingsApi, type FormField } from '@/features/settings/api';
import {
  CLOSE_TIMES,
  fromDraft,
  OPEN_TIMES,
  timeOptions,
  toDraft,
  weekdayAt,
  WEEKDAYS,
  weeklyChanges,
  weeklyDaysOf,
  type DayDraft,
  type HoursDraft,
} from '@/features/settings/hours';
import { fromWebLink, toWebLink } from '@/features/settings/links';
import { WEEKDAY_TEXT, type Weekday } from '@/features/settings/messages';
import { useSaveAction } from '@/features/settings/useSaveAction';
import { useLoad } from '@/lib/useLoad';

export const HOURS_UNSET_TEXT = '아직 영업시간을 넣지 않았어요. 넣기 전에는 시간과 상관없이 예약을 받을 수 있어요. 아래 예시를 고쳐서 저장해 주세요.';
export const HOURS_SAVED_TEXT = '매장 정보를 저장했어요. 이미 잡힌 예약은 그대로예요.';
/** W13 디자인 문구(명세 1 §2.2: 영업시간 검사는 관리 구간만, 준비 시간은 앞에 걸쳐도 됨). */
export const HOURS_RULE_TEXT = '관리가 영업시간 안에 끝나야 예약이 들어가요. 준비 시간은 영업시간 앞에 걸쳐도 돼요.';

type InfoDraft = { locationText: string; naverPlace: string; instagram: string; landing: string; refundPolicy: string };
const toInfoDraft = (i: ShopInfo): InfoDraft => ({
  locationText: i.locationText ?? '',
  naverPlace: fromWebLink(i.naverPlaceUrl),
  instagram: fromWebLink(i.instagramUrl, 'instagram'),
  landing: fromWebLink(i.landingUrl),
  refundPolicy: i.refundPolicy ?? '',
});
const fromInfoDraft = (d: InfoDraft): ShopInfo => ({
  locationText: d.locationText,
  naverPlaceUrl: toWebLink(d.naverPlace),
  instagramUrl: toWebLink(d.instagram, 'instagram'),
  landingUrl: toWebLink(d.landing),
  refundPolicy: d.refundPolicy,
});

export function ShopInfoPage() {
  const api = useSettingsApi();
  const load = useCallback(() => Promise.all([api.getShopInfo(), api.getBusinessHours(), api.listClosures()]), [api]);
  const { state, reload } = useLoad(load);

  return (
    <div className="flex flex-col gap-4 px-4 pt-6 pb-8 md:max-w-3xl md:px-0">
      <Link to="/settings" className="text-sm text-ink-soft md:hidden">
        ‹ 설정
      </Link>
      {state.status === 'ok' ? (
        <ShopInfoForm info={state.data[0]} hours={state.data[1]} closures={state.data[2]} reload={reload} />
      ) : (
        <>
          <h1 className="text-2xl font-bold text-ink">매장 정보</h1>
          {state.status === 'loading' && <p className="py-8 text-center text-sm text-ink-soft">불러오는 중…</p>}
          {state.status === 'error' && <ErrorState onRetry={reload} />}
        </>
      )}
    </div>
  );
}

function ShopInfoForm({ info, hours, closures, reload }: { info: ShopInfo; hours: BusinessHours | null; closures: Closure[]; reload: () => void }) {
  const api = useSettingsApi();
  const [draft, setDraft] = useState<HoursDraft>(() => toDraft(hours, weeklyDaysOf(closures)));
  const [infoDraft, setInfoDraft] = useState<InfoDraft>(() => toInfoDraft(info));
  const [unset, setUnset] = useState(hours === null);
  const [saved, setSaved] = useState(false);
  const save = useSaveAction(reload);
  const problem = save.problem;
  const problemDay = problem?.kind === 'settings' ? weekdayAt(problem.at) : null;
  const fieldError = (f: FormField) => (problem?.kind === 'fields' ? problem.fields[f] : undefined);

  const touched = () => {
    setSaved(false);
    save.clear();
  };
  function changeDay(day: Weekday, patch: Partial<DayDraft>) {
    setDraft((d) => ({ ...d, [day]: { ...d[day], ...patch } }));
    touched();
  }
  function changeInfo(patch: Partial<InfoDraft>) {
    setInfoDraft((d) => ({ ...d, ...patch }));
    touched();
  }

  /** 이미 지워졌으면(다른 기기에서 먼저 지움, 404) 원하는 상태라 성공으로 본다(#63 리뷰). */
  async function removeIfThere(id: string, idempotencyKey: string) {
    try {
      await api.removeClosure(id, { idempotencyKey });
    } catch (err) {
      if (!(err instanceof SettingsNotFoundError)) throw err;
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // 저장 한 번 = 요청 여러 개(안내 정보 1 + 영업시간 1 + 매주 휴무 더하기·지우기). 키는 저장 시도 하나에서 요청마다 꼬리를 붙여 나눈다.
    // 안내 정보를 먼저 보낸다 — 칸 오류(잘못된 주소)면 영업시간을 건드리기 전에 멈춘다.
    // 매주 휴무는 지금 서버 목록과 비교해서 정한다 — 앞 시도에서 일부만 됐어도 두 번 넣지 않게.
    const result = await save.run(async (key) => {
      const savedInfo = await api.putShopInfo(fromInfoDraft(infoDraft), { idempotencyKey: `${key}:shop-info` });
      const savedHours = await api.putBusinessHours(fromDraft(draft), { idempotencyKey: `${key}:hours` });
      const { add, remove } = weeklyChanges(draft, await api.listClosures());
      for (const weekday of add) await api.addClosure({ kind: 'weekly', weekday, note: null }, { idempotencyKey: `${key}:weekly-add:${weekday}` });
      for (const c of remove) await removeIfThere(c.id, `${key}:weekly-remove:${c.id}`);
      return { savedInfo, savedHours };
    });
    if (result !== undefined) {
      // 저장된 모양으로 화면을 맞춘다 — 다시 열었을 때와 같게(#58 리뷰).
      setDraft(toDraft(result.savedHours, WEEKDAYS.filter((d) => !draft[d].isOpen)));
      setInfoDraft(toInfoDraft(result.savedInfo));
      setUnset(false);
      setSaved(true);
    }
  }

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-4">
      {/* 디자인: 제목 오른쪽 위에 저장 */}
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-ink">매장 정보</h1>
        <ActionButton type="submit" variant="brandSolid" size="small" loading={save.saving}>
          저장
        </ActionButton>
      </div>
      {unset && (
        <Callout.Root tone="informative">
          <Callout.Content>
            <Callout.Description>{HOURS_UNSET_TEXT}</Callout.Description>
          </Callout.Content>
        </Callout.Root>
      )}
      {problem && problemDay === null && problem.kind !== 'fields' && 'message' in problem && (
        <p role="alert" className="text-sm text-critical-text">
          {problem.message}
        </p>
      )}
      {saved && (
        <p role="status" className="text-sm text-ink-soft">
          {HOURS_SAVED_TEXT}
        </p>
      )}

      <fieldset disabled={save.saving} className="flex flex-col gap-4">
        <legend className="sr-only">영업시간과 매장 안내 정보</legend>
        <Card>
          <h2 className="pb-1 text-base font-semibold text-ink">영업시간</h2>
          <div className="flex flex-col divide-y divide-line">
            {WEEKDAYS.map((day) => (
              <DayRow
                key={day}
                day={day}
                value={draft[day]}
                message={problemDay === day && problem?.kind === 'settings' ? problem.message : undefined}
                onChange={(patch) => changeDay(day, patch)}
              />
            ))}
          </div>
          <p className="pt-3 text-sm text-ink-soft">{HOURS_RULE_TEXT}</p>
        </Card>

        <Card>
          <div className="grid gap-4 md:grid-cols-2">
            <TextBox label="위치" value={infoDraft.locationText} error={fieldError('locationText')} placeholder="예: ○○구 ○○로 00, 2층" onChange={(v) => changeInfo({ locationText: v })} />
            <TextBox label="네이버 플레이스" optional value={infoDraft.naverPlace} error={fieldError('naverPlaceUrl')} placeholder="naver.me/…" onChange={(v) => changeInfo({ naverPlace: v })} />
            <TextBox label="인스타그램" optional value={infoDraft.instagram} error={fieldError('instagramUrl')} placeholder="@아이디" onChange={(v) => changeInfo({ instagram: v })} />
            <TextBox label="홈페이지" optional value={infoDraft.landing} error={fieldError('landingUrl')} placeholder="https://" onChange={(v) => changeInfo({ landing: v })} />
          </div>
          <div className="pt-4">
            <TextBox label="환불 정책" optional multiline value={infoDraft.refundPolicy} error={fieldError('refundPolicy')} onChange={(v) => changeInfo({ refundPolicy: v })} />
          </div>
        </Card>
      </fieldset>
    </form>
  );
}

function Card({ children }: { children: ReactNode }) {
  return <section className="rounded-xl border border-line bg-surface p-4">{children}</section>;
}

function DayRow({ day, value, message, onChange }: { day: Weekday; value: DayDraft; message?: string; onChange: (patch: Partial<DayDraft>) => void }) {
  const name = `${WEEKDAY_TEXT[day]}요일`;
  return (
    <div className="flex flex-col gap-1 py-2">
      <div className="flex min-h-10 items-center gap-3">
        <span className="w-6 shrink-0 text-base font-semibold text-ink">{WEEKDAY_TEXT[day]}</span>
        <div className="flex min-w-0 flex-1 items-center gap-1 text-base text-ink">
          {value.isOpen ? (
            <>
              <TimeSelect label={`${name} 여는 시각`} value={value.open} options={timeOptions(OPEN_TIMES, value.open)} onChange={(open) => onChange({ open })} />
              <span aria-hidden>–</span>
              <TimeSelect label={`${name} 닫는 시각`} value={value.close} options={timeOptions(CLOSE_TIMES, value.close)} onChange={(close) => onChange({ close })} />
            </>
          ) : (
            <span className="text-ink-soft">쉬는 날</span>
          )}
        </div>
        {/* 켜면 정기 휴무(쉬는 날). 이름에 요일을 넣어 화면 읽기에서 구분한다. */}
        <Switch.Root checked={!value.isOpen} onCheckedChange={(off) => onChange({ isOpen: !off })} className="shrink-0">
          <Switch.HiddenInput aria-label={`${name} 정기 휴무`} />
          <Switch.Label>정기 휴무</Switch.Label>
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
        </Switch.Root>
      </div>
      {value.isOpen && value.extra.length > 0 && <p className="text-sm text-ink-soft">그 밖의 영업 구간 {value.extra.length}개는 그대로 둬요.</p>}
      {message && (
        <p role="alert" className="text-sm text-critical-text">
          {name}: {message}
        </p>
      )}
    </div>
  );
}

/**
 * 시각 고르기. 디자인처럼 "10:00"이 글자로 보이고, 누르면 OS 시각 목록(폰은 휠)이 열린다.
 * ASSUMPTION: 디자인 부품 표(§9)는 TimePicker지만, 49칸 30분 단위에는 기본 select가 폰에서 더 익숙하다 — PM 확인 전까지.
 */
function TimeSelect({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="cursor-pointer appearance-none rounded-md bg-transparent px-1 py-1 tabular-nums hover:bg-neutral-weak"
    >
      {options.map((t) => (
        <option key={t} value={t}>
          {t}
        </option>
      ))}
    </select>
  );
}

function TextBox({
  label,
  optional,
  multiline,
  value,
  error,
  placeholder,
  onChange,
}: {
  label: string;
  optional?: boolean;
  multiline?: boolean;
  value: string;
  error?: string;
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  const id = useId();
  const cls = 'w-full rounded-lg border border-control-line bg-surface px-3 py-2 text-base text-ink';
  // label을 칸 밖에 두고 htmlFor로 잇는다 — 칸 이름에 칸 값이 섞이지 않게. 오류는 설명으로 잇는다(#65 리뷰).
  const field = {
    id,
    value,
    placeholder,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(e.target.value),
    'aria-invalid': error ? true : undefined,
    'aria-describedby': error ? `${id}-error` : undefined,
  };
  return (
    <div className="flex flex-col gap-1 text-sm">
      <label htmlFor={id} className="font-semibold text-ink">
        {label}
        {optional && (
          <>
            {' '}
            <span className="font-normal text-ink-soft">(선택)</span>
          </>
        )}
      </label>
      {multiline ? <textarea rows={3} className={cls} {...field} /> : <input autoComplete="off" className={`min-h-11 ${cls}`} {...field} />}
      {error && (
        <p id={`${id}-error`} className="text-critical-text">
          {error}
        </p>
      )}
    </div>
  );
}
