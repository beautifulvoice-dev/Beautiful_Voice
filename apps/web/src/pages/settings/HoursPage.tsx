// 영업시간(W13, BEA-166): 요일마다 영업 켜기·끄기와 여는·닫는 시각. 저장하면 통째로 바꾸고, 이미 있는 예약은 그대로 둔다(파생 S2).
// 저장 검사는 서버와 같은 함수(@bv/scheduling/shop-settings)가 창구 안에서 한다 — 화면은 오류를 문구로 바꿔 보여 주기만 한다.
import type { BusinessHours } from '@bv/contracts';
import { ActionButton, Callout, Switch } from '@seed-design/react';
import { useCallback, useState } from 'react';
import { Link } from 'react-router';
import { ErrorState } from '@/components/states/DataState';
import { useSettingsApi } from '@/features/settings/api';
import { CLOSE_TIMES, fromDraft, OPEN_TIMES, timeOptions, toDraft, weekdayAt, WEEKDAYS, type DayDraft, type HoursDraft } from '@/features/settings/hours';
import { WEEKDAY_TEXT, type Weekday } from '@/features/settings/messages';
import { useSaveAction } from '@/features/settings/useSaveAction';
import { useLoad } from '@/lib/useLoad';

export const HOURS_UNSET_TEXT = '아직 영업시간을 넣지 않았어요. 넣기 전에는 시간과 상관없이 예약을 받을 수 있어요. 아래 예시를 고쳐서 저장해 주세요.';
export const HOURS_SAVED_TEXT = '영업시간을 저장했어요. 이미 잡힌 예약은 그대로예요.';

export function HoursPage() {
  const api = useSettingsApi();
  const load = useCallback(() => api.getBusinessHours(), [api]);
  const { state, reload } = useLoad(load);

  return (
    <div className="flex flex-col gap-4 px-4 pt-6 md:max-w-lg">
      <Link to="/settings" className="text-sm text-ink-soft">
        ‹ 설정
      </Link>
      <h1 className="text-xl font-semibold text-ink">영업시간</h1>
      {state.status === 'loading' && <p className="py-8 text-center text-sm text-ink-soft">불러오는 중…</p>}
      {state.status === 'error' && <ErrorState onRetry={reload} />}
      {state.status === 'ok' && <HoursForm initial={state.data} reload={reload} />}
    </div>
  );
}

function HoursForm({ initial, reload }: { initial: BusinessHours | null; reload: () => void }) {
  const api = useSettingsApi();
  const [draft, setDraft] = useState<HoursDraft>(() => toDraft(initial));
  const [unset, setUnset] = useState(initial === null);
  const [saved, setSaved] = useState(false);
  const save = useSaveAction(reload);
  const problem = save.problem;
  const problemDay = problem?.kind === 'settings' ? weekdayAt(problem.at) : null;

  function change(day: Weekday, patch: Partial<DayDraft>) {
    setDraft((d) => ({ ...d, [day]: { ...d[day], ...patch } }));
    setSaved(false);
    save.clear();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const result = await save.run((idempotencyKey) => api.putBusinessHours(fromDraft(draft), { idempotencyKey }));
    if (result !== undefined) {
      setUnset(false);
      setSaved(true);
    }
  }

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-4">
      {unset && (
        <Callout.Root tone="informative">
          <Callout.Content>
            <Callout.Description>{HOURS_UNSET_TEXT}</Callout.Description>
          </Callout.Content>
        </Callout.Root>
      )}

      <fieldset disabled={save.saving} className="flex flex-col divide-y divide-line">
        <legend className="sr-only">요일별 영업시간</legend>
        {WEEKDAYS.map((day) => (
          <DayRow
            key={day}
            day={day}
            value={draft[day]}
            message={problemDay === day && problem?.kind === 'settings' ? problem.message : undefined}
            onChange={(patch) => change(day, patch)}
          />
        ))}
      </fieldset>

      {/* 영업시간 저장에는 칸 오류(fields)가 없다 — 요일 줄에 못 다는 문구만 여기에. */}
      {problem && problemDay === null && 'message' in problem && (
        <p role="alert" className="text-sm text-critical-text">
          {problem.message}
        </p>
      )}
      {saved && (
        <p role="status" className="text-sm text-ink-soft">
          {HOURS_SAVED_TEXT}
        </p>
      )}

      <ActionButton type="submit" variant="brandSolid" size="large" loading={save.saving}>
        저장
      </ActionButton>
    </form>
  );
}

function DayRow({ day, value, message, onChange }: { day: Weekday; value: DayDraft; message?: string; onChange: (patch: Partial<DayDraft>) => void }) {
  const name = `${WEEKDAY_TEXT[day]}요일`;
  return (
    <div className="flex flex-col gap-1 py-3">
      <div className="flex min-h-10 flex-wrap items-center gap-x-4 gap-y-2">
        <Switch.Root checked={value.isOpen} onCheckedChange={(isOpen) => onChange({ isOpen })} className="w-20">
          <Switch.HiddenInput />
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
          <Switch.Label>{WEEKDAY_TEXT[day]}</Switch.Label>
        </Switch.Root>
        {value.isOpen ? (
          <div className="flex items-center gap-2">
            <TimeSelect label={`${name} 여는 시각`} value={value.open} options={timeOptions(OPEN_TIMES, value.open)} onChange={(open) => onChange({ open })} />
            <span aria-hidden className="text-ink-soft">
              ~
            </span>
            <TimeSelect label={`${name} 닫는 시각`} value={value.close} options={timeOptions(CLOSE_TIMES, value.close)} onChange={(close) => onChange({ close })} />
          </div>
        ) : (
          <span className="text-sm text-ink-soft">쉬는 날</span>
        )}
      </div>
      {value.isOpen && value.extra.length > 0 && (
        <p className="text-sm text-ink-soft">그 밖의 영업 구간 {value.extra.length}개는 그대로 둬요.</p>
      )}
      {message && (
        <p role="alert" className="text-sm text-critical-text">
          {name}: {message}
        </p>
      )}
    </div>
  );
}

/**
 * 시각 고르기. 폰에서는 OS 휠로 열리는 기본 select를 쓴다.
 * ASSUMPTION: SEED Select는 49칸 목록에 위치 계산이 붙어 무겁고, 폰에서는 기본 select가 더 익숙하다 — W13 디자인을 받으면 다시 본다.
 */
function TimeSelect({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="min-h-10 rounded-md border border-control-line bg-surface px-2 text-base text-ink tabular-nums"
    >
      {options.map((t) => (
        <option key={t} value={t}>
          {t}
        </option>
      ))}
    </select>
  );
}
