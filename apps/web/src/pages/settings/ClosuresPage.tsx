// 휴무·휴가(W13, BEA-166): 매주 쉬는 요일과 날짜 휴무(공휴일·휴가)를 추가·지우기. 고치기는 없다(계약: 추가·삭제만).
// 추가는 폰에서 아래 시트, 노트북에서 가운데 창(SEED ResponsiveDialog, 해나 11/21 결정).
// 지우기는 한 번 더 묻지 않는다 — 기록은 서버에 남고(removed), 같은 휴무를 다시 넣으면 된다(디자인 정책: 되돌릴 수 없는 일만 묻는다).
import type { Closure } from '@bv/contracts';
import { ActionButton, ResponsiveDialog, SegmentedControl, SegmentedControlItemHiddenInput } from '@seed-design/react';
import { useCallback, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { EmptyState, ErrorState } from '@/components/states/DataState';
import { shopToday } from '@/features/customers/model';
import { useSettingsApi } from '@/features/settings/api';
import { groupClosures, KIND_TEXT, toClosureInput, type ClosureDraft, type ClosureKind } from '@/features/settings/closures';
import { WEEKDAYS } from '@/features/settings/hours';
import { closureText, WEEKDAY_TEXT, type Weekday } from '@/features/settings/messages';
import { useSaveAction } from '@/features/settings/useSaveAction';
import { useLoad } from '@/lib/useLoad';

/** ASSUMPTION(#58 리뷰 ❔2): 영업시간에서 끈 요일과 겹치지 않게 안내만 한다. 저장은 막지 않는다. */
export const WEEKLY_HELP_TEXT = '영업시간에서 이미 끈 요일은 여기 넣지 않아도 돼요.';

export function ClosuresPage() {
  const api = useSettingsApi();
  const load = useCallback(() => api.listClosures(), [api]);
  const { state, reload } = useLoad(load);

  return (
    <div className="flex flex-col gap-4 px-4 pt-6 md:max-w-lg">
      <Link to="/settings" className="text-sm text-ink-soft">
        ‹ 설정
      </Link>
      <h1 className="text-xl font-semibold text-ink">휴무·휴가</h1>
      {state.status === 'loading' && <p className="py-8 text-center text-sm text-ink-soft">불러오는 중…</p>}
      {state.status === 'error' && <ErrorState onRetry={reload} />}
      {state.status === 'ok' && <ClosureList closures={state.data} reload={reload} />}
    </div>
  );
}

function ClosureList({ closures, reload }: { closures: Closure[]; reload: () => void }) {
  const api = useSettingsApi();
  const remove = useSaveAction(reload);
  const [adding, setAdding] = useState(false);
  const { weekly, upcoming, past } = groupClosures(closures, shopToday());
  const takenWeekdays = weekly.flatMap((c) => (c.kind === 'weekly' ? [c.weekday] : []));

  const lastTarget = useRef<string | null>(null);
  async function removeOne(id: string) {
    // 연결이 끊긴 지우기를 다시 누를 때만 같은 키를 쓴다. 다른 항목이면 새 키(같은 키면 서버가 앞 항목 결과를 돌려준다).
    if (lastTarget.current !== id) remove.clear();
    lastTarget.current = id;
    const done = await remove.run(async (idempotencyKey) => {
      await api.removeClosure(id, { idempotencyKey });
      return true;
    });
    if (done) reload();
  }

  const row = (c: Closure) => <ClosureRow key={c.id} closure={c} disabled={remove.saving} onRemove={() => removeOne(c.id)} />;

  return (
    <div className="flex flex-col gap-5">
      <ActionButton variant="neutralWeak" onClick={() => setAdding(true)}>
        휴무 추가
      </ActionButton>
      {remove.problem && 'message' in remove.problem && (
        <p role="alert" className="text-sm text-critical-text">
          {remove.problem.message}
        </p>
      )}

      {weekly.length + upcoming.length + past.length === 0 && <EmptyState title="등록한 휴무가 없어요" description="매주 쉬는 요일이나 공휴일·휴가를 추가해 주세요." />}
      {weekly.length > 0 && <Section title="매주 쉬는 요일">{weekly.map(row)}</Section>}
      {upcoming.length > 0 && <Section title="다가오는 휴무">{upcoming.map(row)}</Section>}
      {past.length > 0 && (
        <details className="text-ink">
          <summary className="cursor-pointer py-2 text-sm text-ink-soft">지난 휴무 {past.length}개</summary>
          <ul className="flex flex-col divide-y divide-line">{past.map(row)}</ul>
        </details>
      )}

      <AddClosureSheet open={adding} onOpenChange={setAdding} takenWeekdays={takenWeekdays} reload={reload} />
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col">
      <h2 className="text-sm font-semibold text-ink-soft">{title}</h2>
      <ul aria-label={title} className="flex flex-col divide-y divide-line">
        {children}
      </ul>
    </section>
  );
}

function ClosureRow({ closure, disabled, onRemove }: { closure: Closure; disabled: boolean; onRemove: () => void }) {
  const text = closureText(closure);
  return (
    <li className="flex min-h-12 items-center justify-between gap-3 py-2">
      <span className="flex flex-col">
        <span className="text-base text-ink">{text}</span>
        {closure.kind !== 'weekly' && <span className="text-sm text-ink-soft">{KIND_TEXT[closure.kind]}</span>}
      </span>
      <ActionButton variant="ghost" size="small" disabled={disabled} onClick={onRemove} aria-label={`${text} 지우기`}>
        지우기
      </ActionButton>
    </li>
  );
}

const emptyDraft = (weekday: Weekday): ClosureDraft => ({ kind: 'vacation', weekday, startDate: '', endDate: '', note: '' });

function AddClosureSheet({
  open,
  onOpenChange,
  takenWeekdays,
  reload,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  takenWeekdays: Weekday[];
  reload: () => void;
}) {
  const api = useSettingsApi();
  const save = useSaveAction(reload);
  // ASSUMPTION: 이미 매주 휴무인 요일은 다시 고르지 않게 목록에서 뺀다(같은 휴무 두 줄 방지, 명세에 없음).
  const freeWeekdays = WEEKDAYS.filter((d) => !takenWeekdays.includes(d));
  const [kept, setDraft] = useState<ClosureDraft>(() => emptyDraft(freeWeekdays[0] ?? 1));
  // 고른 요일이 그사이 매주 휴무로 들어갔으면(방금 추가 등) 남은 첫 요일로 — 화면에 안 보이는 요일이 저장되지 않게.
  const draft = freeWeekdays.includes(kept.weekday) ? kept : { ...kept, weekday: freeWeekdays[0] ?? kept.weekday };

  function change(patch: Partial<ClosureDraft>) {
    setDraft((d) => ({ ...d, ...patch }));
    save.clear();
  }

  function close(next: boolean) {
    onOpenChange(next);
    if (!next) {
      setDraft(emptyDraft(freeWeekdays[0] ?? 1));
      save.clear();
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const created = await save.run((idempotencyKey) => api.addClosure(toClosureInput(draft), { idempotencyKey }));
    if (created !== undefined) {
      close(false);
      reload();
    }
  }

  const weeklyFull = draft.kind === 'weekly' && freeWeekdays.length === 0;

  return (
    <ResponsiveDialog.Root open={open} onOpenChange={close}>
      <ResponsiveDialog.Positioner>
        <ResponsiveDialog.Backdrop />
        <ResponsiveDialog.Content>
          <ResponsiveDialog.Header>
            <ResponsiveDialog.Title>휴무 추가</ResponsiveDialog.Title>
          </ResponsiveDialog.Header>
          <form id="add-closure" noValidate onSubmit={submit}>
            <ResponsiveDialog.Body>
              <fieldset disabled={save.saving} className="flex flex-col gap-4 pb-2">
                <SegmentedControl.Root aria-label="휴무 종류" value={draft.kind} onValueChange={(v) => change({ kind: v as ClosureKind })}>
                  <SegmentedControl.Indicator />
                  {(['weekly', 'holiday', 'vacation'] as const).map((k) => (
                    <SegmentedControl.Item key={k} value={k}>
                      <SegmentedControlItemHiddenInput />
                      {k === 'weekly' ? '매주' : KIND_TEXT[k]}
                    </SegmentedControl.Item>
                  ))}
                </SegmentedControl.Root>

                {draft.kind === 'weekly' ? (
                  <FieldBox label="쉬는 요일" help={weeklyFull ? '모든 요일이 이미 매주 휴무예요.' : WEEKLY_HELP_TEXT}>
                    <select value={draft.weekday} onChange={(e) => change({ weekday: Number(e.target.value) as Weekday })} className={INPUT}>
                      {freeWeekdays.map((d) => (
                        <option key={d} value={d}>
                          {WEEKDAY_TEXT[d]}요일
                        </option>
                      ))}
                    </select>
                  </FieldBox>
                ) : (
                  <div className="grid grid-cols-2 gap-3">
                    <FieldBox label="시작일">
                      <input type="date" value={draft.startDate} onChange={(e) => change({ startDate: e.target.value })} className={INPUT} />
                    </FieldBox>
                    <FieldBox label="끝나는 날" help="비우면 하루만">
                      <input type="date" value={draft.endDate} min={draft.startDate || undefined} onChange={(e) => change({ endDate: e.target.value })} className={INPUT} />
                    </FieldBox>
                  </div>
                )}
                <FieldBox label="메모 (선택)">
                  <input value={draft.note} onChange={(e) => change({ note: e.target.value })} placeholder="예: 연말 휴가" autoComplete="off" className={INPUT} />
                </FieldBox>

                {save.problem && 'message' in save.problem && (
                  <p role="alert" className="text-sm text-critical-text">
                    {save.problem.message}
                  </p>
                )}
              </fieldset>
            </ResponsiveDialog.Body>
          </form>
          <ResponsiveDialog.Footer>
            <ActionButton type="submit" form="add-closure" variant="brandSolid" size="large" loading={save.saving} disabled={weeklyFull} className="w-full">
              추가
            </ActionButton>
          </ResponsiveDialog.Footer>
        </ResponsiveDialog.Content>
      </ResponsiveDialog.Positioner>
    </ResponsiveDialog.Root>
  );
}

const INPUT = 'min-h-10 w-full rounded-md border border-control-line bg-surface px-3 text-base text-ink';

function FieldBox({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm font-medium text-ink">
      {label}
      {children}
      {help && <span className="font-normal text-ink-soft">{help}</span>}
    </label>
  );
}
