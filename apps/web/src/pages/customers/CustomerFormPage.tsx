// 고객 등록·수정 (CUS-1·2, BEA-172). 이름만 필수, 전화번호는 권장.
// 같은 이름 고객이 있으면 저장 전에 "같은 이름의 고객이 있어요"로 확인을 받는다. 자동으로 합치지 않는다(CUS-2).
// 디자인(W5 "+ 고객: 시트"): 등록은 고객 목록 위 시트(CustomersPage)에서 이 폼을 쓰고, 수정("정보 고치기")은 이 화면.
import { validateNewCustomer, type CustomerErrorCode, type CustomerField, type FieldError } from '@bv/customers';
import type { Candidate } from '@bv/customers/duplicates';
import { ActionButton, Callout } from '@seed-design/react';
import { useCallback, useId, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { EmptyState, ErrorState } from '@/components/states/DataState';
import { CustomerValidationError, useCustomerApi } from '@/features/customers/api';
import { formatPhone, shopToday, type Customer } from '@/features/customers/model';
import { useLoad } from '@/lib/useLoad';

const ERROR_TEXT: Record<CustomerErrorCode, string> = {
  NAME_REQUIRED: '이름을 입력해 주세요.',
  PHONE_INVALID_CHARACTERS: '전화번호에는 숫자와 - 만 쓸 수 있어요.',
  PHONE_INVALID_FORMAT: '전화번호 형식이 맞지 않아요. 예: 010-1234-5678',
  BIRTHDATE_INVALID: '생년월일은 실제 날짜로 적어 주세요. 예: 1990-01-31',
};

/** 달력 칸에 날짜를 덜 입력하면 브라우저가 값을 빈 문자열로 준다 — 지운 것과 구분해 저장을 막는다(#52 리뷰). */
const BIRTHDATE_INCOMPLETE_TEXT = '생년월일을 끝까지 입력하거나, 지우려면 칸을 비워 주세요.';

const HINT_TEXT: Record<Candidate['hint'], string> = {
  same_phone: '전화번호도 같아요 — 이미 등록된 고객일 수 있어요',
  different_phone: '전화번호가 달라요',
  phone_missing: '전화번호로 구분할 수 없어요',
};

/** /customers/:id/edit — 고객 정보 고치기 화면. */
export function CustomerFormPage() {
  const { id } = useParams();
  const api = useCustomerApi();
  const load = useCallback(() => (id ? api.get(id) : Promise.resolve(null)), [api, id]);
  const { state, reload } = useLoad(load);

  if (state.status === 'loading') return <p className="py-8 text-center text-sm text-ink-soft">불러오는 중…</p>;
  if (state.status === 'error') return <ErrorState onRetry={reload} />;
  if (id && !state.data) return <EmptyState title="없는 고객이에요" />;
  return (
    <div className="flex flex-col gap-4 px-4 pt-6 pb-8 md:max-w-lg">
      <Link to={id ? `/customers/${id}` : '/customers'} className="text-sm text-ink-soft">
        ‹ {id ? '고객 상세' : '고객 목록'}
      </Link>
      <h1 className="text-2xl font-bold text-ink">{state.data ? '정보 고치기' : '고객 등록'}</h1>
      <CustomerForm key={id ?? 'new'} initial={state.data} cancelTo={id ? `/customers/${id}` : '/customers'} />
    </div>
  );
}

/**
 * 고객 입력 폼. 화면(수정)과 시트(등록)가 같이 쓴다.
 * @param onCancel 시트에서 "취소"를 누르면 부른다. 없으면 cancelTo로 가는 링크.
 */
export function CustomerForm({ initial, onCancel, cancelTo = '/customers' }: { initial: Customer | null; onCancel?: () => void; cancelTo?: string }) {
  const api = useCustomerApi();
  const navigate = useNavigate();
  const [name, setName] = useState(initial?.name ?? '');
  const [phone, setPhone] = useState(initial?.phone ? formatPhone(initial.phone) : '');
  const [memo, setMemo] = useState(initial?.memo ?? '');
  const [birthdate, setBirthdate] = useState(initial?.birthdate ?? '');
  const [address, setAddress] = useState(initial?.address ?? '');
  const [errors, setErrors] = useState<FieldError[]>([]);
  const birthdateInput = useRef<HTMLInputElement>(null);
  const [birthdateIncomplete, setBirthdateIncomplete] = useState(false);
  // 동명이인 후보는 어떤 입력으로 조회했는지와 묶어 둔다 — 그 입력 그대로일 때만 "다른 고객이에요, 저장"이 통한다(#32 리뷰).
  const [sameName, setSameName] = useState<{ candidates: Candidate[]; name: string; phone: string | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const errorOf = (field: CustomerField) => errors.find((e) => e.field === field);
  const errorText = (field: CustomerField) => {
    const e = errorOf(field);
    return e && ERROR_TEXT[e.code];
  };

  async function submit(e: SyntheticEvent, confirmedSameName = false) {
    e.preventDefault();
    setFailed(false);
    const incomplete = birthdateInput.current?.validity.badInput ?? false;
    setBirthdateIncomplete(incomplete);
    const checked = validateNewCustomer({ name, phone, memo, birthdate, address });
    if (!checked.ok) return setErrors(checked.errors);
    if (incomplete) return setErrors([]);
    setErrors([]);
    setSaving(true);
    try {
      // 새 고객이거나 이름이 바뀔 때만 동명이인을 확인한다.
      const { name: checkedName, phone: checkedPhone } = checked.value;
      const confirmed = confirmedSameName && sameName?.name === checkedName && sameName.phone === checkedPhone;
      if (!confirmed && checkedName !== initial?.name) {
        const r = await api.checkSameName({ id: initial?.id, name: checkedName, phone: checkedPhone });
        if (r.needsReview) return setSameName({ candidates: r.candidates, name: checkedName, phone: checkedPhone });
      }
      const saved = initial ? await api.update(initial.id, { name, phone, memo, birthdate, address }) : await api.create({ name, phone, memo, birthdate, address });
      navigate(`/customers/${saved.id}`, { replace: !!initial });
    } catch (err) {
      if (err instanceof CustomerValidationError) setErrors(err.errors);
      else setFailed(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form noValidate onSubmit={(e) => submit(e)} className="flex flex-col gap-4">
      {/* 확인·저장 중에는 입력을 잠근다 — 조회한 값과 화면 값이 어긋나지 않게. */}
      <fieldset disabled={saving} className="flex flex-col gap-4">
        <Field label="이름 (필수)" error={errorText('name')}>
          {(p) => (
            <input
              {...p}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setSameName(null);
              }}
              autoComplete="off"
              className={INPUT}
            />
          )}
        </Field>
        <Field label="전화번호" error={errorText('phone')}>
          {(p) => (
            <input
              {...p}
              value={phone}
              onChange={(e) => {
                setPhone(e.target.value);
                setSameName(null);
              }}
              type="tel"
              inputMode="tel"
              autoComplete="off"
              placeholder="010-0000-0000"
              className={INPUT}
            />
          )}
        </Field>
        {/* ASSUMPTION(설계 메모 6단계): 생년월일은 달력으로 고르고 오늘(매장 날짜)까지만. 미래 날짜 금지는 명세에 없어 화면에서만 막는다. */}
        <Field label="생년월일" error={birthdateIncomplete ? BIRTHDATE_INCOMPLETE_TEXT : errorText('birthdate')}>
          {(p) => <input {...p} ref={birthdateInput} value={birthdate} onChange={(e) => setBirthdate(e.target.value)} type="date" max={shopToday()} className={INPUT} />}
        </Field>
        <Field label="거주지">
          {(p) => <input {...p} value={address} onChange={(e) => setAddress(e.target.value)} autoComplete="off" placeholder="예: 동네 이름" className={INPUT} />}
        </Field>
        <Field label="특이사항">
          {(p) => <textarea {...p} value={memo} onChange={(e) => setMemo(e.target.value)} rows={3} className={`${INPUT} py-2`} />}
        </Field>
      </fieldset>

      {sameName && (
        // 설계서 §9.3: 같은 이름 고객 = warning(원장이 골라 줘야 한다).
        <Callout.Root tone="warning" role="alert">
          <Callout.Content>
            <Callout.Title>같은 이름의 고객이 있어요</Callout.Title>
            <Callout.Description>
              <ul className="list-disc pt-1 pl-5">
                {sameName.candidates.map((c) => (
                  <li key={c.customerId}>
                    <Link to={`/customers/${c.customerId}`} className="underline">
                      {c.name} {c.phone ? formatPhone(c.phone) : '(전화번호 없음)'}
                    </Link>{' '}
                    — {HINT_TEXT[c.hint]}
                  </li>
                ))}
              </ul>
            </Callout.Description>
            <div className="pt-2">
              <ActionButton type="button" variant="neutralWeak" size="small" disabled={saving} onClick={(e) => submit(e, true)}>
                다른 고객이에요, 저장
              </ActionButton>
            </div>
          </Callout.Content>
        </Callout.Root>
      )}
      {failed && (
        <p role="alert" className="text-sm text-critical-text">
          저장하지 못했어요. 다시 시도해 주세요.
        </p>
      )}

      <div className="flex flex-col gap-2">
        <ActionButton type="submit" variant="brandSolid" size="large" loading={saving} className="w-full">
          저장
        </ActionButton>
        {onCancel ? (
          <ActionButton type="button" variant="ghost" onClick={onCancel} className="w-full">
            취소
          </ActionButton>
        ) : (
          <ActionButton asChild variant="ghost" className="w-full">
            <Link to={cancelTo}>취소</Link>
          </ActionButton>
        )}
      </div>
    </form>
  );
}

const INPUT = 'min-h-11 w-full rounded-lg border border-control-line bg-surface px-3 text-base text-ink';

/** label을 칸 밖에 두고 htmlFor로 잇는다. 오류는 aria-describedby로(#65 리뷰와 같은 틀). */
function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: (props: { id: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string }) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1 text-sm">
      <label htmlFor={id} className="font-semibold text-ink">
        {label}
      </label>
      {children({ id, 'aria-invalid': error ? true : undefined, 'aria-describedby': error ? `${id}-error` : undefined })}
      {error && (
        <p id={`${id}-error`} className="text-critical-text">
          {error}
        </p>
      )}
    </div>
  );
}
