// 고객 등록·수정 (CUS-1·2, 분해표 C-03). 이름만 필수, 전화번호는 권장.
// 같은 이름 고객이 있으면 저장 전에 "같은 이름의 고객이 있어요"로 확인을 받는다. 자동으로 합치지 않는다(CUS-2).
import { validateNewCustomer, type CustomerErrorCode, type CustomerField, type FieldError } from '@bv/customers';
import type { Candidate } from '@bv/customers/duplicates';
import { useCallback, useRef, useState, type ReactElement, type SyntheticEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { EmptyState, ErrorState } from '@/components/states/DataState';
import { Button } from '@/components/ui/button';
import { CustomerConflictError, CustomerValidationError, useCustomerApi } from '@/features/customers/api';
import { formatPhone, shopToday, type Customer } from '@/features/customers/model';
import { NetworkError } from '@/lib/http';
import { useRetryKey } from '@/lib/retryKey';
import { useLoad } from '@/lib/useLoad';

const ERROR_TEXT: Record<CustomerErrorCode, string> = {
  NAME_REQUIRED: '이름을 입력해 주세요.',
  PHONE_INVALID_CHARACTERS: '전화번호에는 숫자와 - 만 쓸 수 있어요.',
  PHONE_INVALID_FORMAT: '전화번호 형식이 맞지 않아요. 예: 010-1234-5678',
  BIRTHDATE_INVALID: '생년월일은 실제 날짜로 적어 주세요. 예: 1990-01-31',
};

/** 달력 칸에 날짜를 덜 입력하면 브라우저가 값을 빈 문자열로 준다 — 지운 것과 구분해 저장을 막는다(#52 리뷰). */
const BIRTHDATE_INCOMPLETE_TEXT = '생년월일을 끝까지 입력하거나, 지우려면 칸을 비워 주세요.';

/** 저장 실패 문구(설계 05 오류와 문구). 응답을 못 받았으면 같은 내용으로 다시 시도 — 같은 키라 두 번 저장되지 않는다. */
const FAILED_TEXT = {
  failed: '저장 결과를 확인하지 못했어요. 같은 내용으로 다시 시도해 주세요.',
  conflict: '그사이 다른 곳에서 바뀌었어요. 다시 불러와 확인해 주세요.',
  rejected: '저장하지 못했어요. 다시 시도해 주세요.',
} as const;

const HINT_TEXT: Record<Candidate['hint'], string> = {
  same_phone: '전화번호도 같아요 — 이미 등록된 고객일 수 있어요',
  different_phone: '전화번호가 달라요',
  phone_missing: '전화번호로 구분할 수 없어요',
};

/** /customers/new 와 /customers/:id/edit 둘 다 이 화면. */
export function CustomerFormPage() {
  const { id } = useParams();
  const api = useCustomerApi();
  const load = useCallback(() => (id ? api.get(id) : Promise.resolve(null)), [api, id]);
  const { state, reload } = useLoad(load);

  if (state.status === 'loading') return <p className="py-8 text-center text-sm text-muted-foreground">불러오는 중…</p>;
  if (state.status === 'error') return <ErrorState onRetry={reload} />;
  if (id && !state.data) return <EmptyState title="없는 고객이에요" />;
  return <CustomerForm key={id ?? 'new'} initial={state.data} />;
}

const FIELD_LABEL = { name: '이름', phone: '전화번호', memo: '특이사항', birthdate: '생년월일', address: '거주지' } as const;

function CustomerForm({ initial: loaded }: { initial: Customer | null }) {
  // 충돌 뒤 다시 불러온 최신 행. 입력(초안)은 그대로 두고, 다음 저장은 이 행의 version으로 보낸다(설계 05 D4).
  const [latest, setLatest] = useState<Customer | null>(null);
  const initial = latest ?? loaded;
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
  const [failed, setFailed] = useState<keyof typeof FAILED_TEXT | null>(null);
  const retryKey = useRetryKey();
  async function reloadLatest() {
    if (!loaded) return;
    try {
      const fresh = await api.get(loaded.id);
      if (!fresh) return setFailed('rejected');
      setLatest(fresh);
      setFailed(null);
    } catch {
      setFailed('conflict');
    }
  }
  const draft = { name, phone: phone.replace(/\D/g, '') || null, memo: memo || null, birthdate: birthdate || null, address: address || null };
  const changedFields = latest
    ? (Object.keys(FIELD_LABEL) as (keyof typeof FIELD_LABEL)[]).filter((f) => (latest[f] ?? null) !== (draft[f] ?? null))
    : [];
  const errorOf = (field: CustomerField) => errors.find((e) => e.field === field);

  async function submit(e: SyntheticEvent, confirmedSameName = false) {
    e.preventDefault();
    setFailed(null);
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
      const values = { name, phone, memo, birthdate, address };
      const idempotencyKey = retryKey.keyFor(JSON.stringify([initial?.id ?? null, initial?.version ?? null, values]));
      const saved = initial
        ? await api.update(initial.id, values, { version: initial.version, idempotencyKey })
        : await api.create(values, { idempotencyKey });
      retryKey.settle();
      navigate(`/customers/${saved.id}`, { replace: !!initial });
    } catch (err) {
      // 응답을 못 받았을 때만 키를 남긴다 — 같은 내용으로 다시 보내면 서버가 처음 결과를 돌려준다.
      if (!(err instanceof NetworkError)) retryKey.settle();
      if (err instanceof CustomerValidationError) setErrors(err.errors);
      else if (err instanceof CustomerConflictError) setFailed('conflict');
      else setFailed(err instanceof NetworkError ? 'failed' : 'rejected');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form noValidate onSubmit={(e) => submit(e)} className="flex flex-col gap-4 px-4 pt-6 md:max-w-lg">
      <h1 className="text-xl font-semibold">{initial ? '고객 수정' : '고객 등록'}</h1>
      {/* 확인·저장 중에는 입력을 잠근다 — 조회한 값과 화면 값이 어긋나지 않게. */}
      <fieldset disabled={saving} className="flex flex-col gap-4">
        <Field label="이름 (필수)" error={errorOf('name')}>
          <input value={name} onChange={(e) => {
              setName(e.target.value);
              setSameName(null);
            }} autoComplete="off" />
        </Field>
        <Field label="전화번호" error={errorOf('phone')}>
          <input value={phone} onChange={(e) => {
              setPhone(e.target.value);
              setSameName(null);
            }} type="tel" inputMode="tel" autoComplete="off" />
        </Field>
        {/* ASSUMPTION(설계 메모 6단계): 생년월일은 달력으로 고르고 오늘(매장 날짜)까지만. 미래 날짜 금지는 명세에 없어 화면에서만 막는다. */}
        <Field label="생년월일" error={errorOf('birthdate')} message={birthdateIncomplete ? BIRTHDATE_INCOMPLETE_TEXT : undefined}>
          <input ref={birthdateInput} value={birthdate} onChange={(e) => setBirthdate(e.target.value)} type="date" max={shopToday()} />
        </Field>
        <Field label="거주지">
          <input value={address} onChange={(e) => setAddress(e.target.value)} autoComplete="off" placeholder="예: 동네 이름" />
        </Field>
        <Field label="특이사항">
          <textarea value={memo} onChange={(e) => setMemo(e.target.value)} rows={3} />
        </Field>
      </fieldset>

      {sameName && (
        <div role="alert" className="flex flex-col gap-2 rounded-md border border-amber-400 bg-amber-50 p-3 text-sm dark:bg-amber-950">
          <p className="font-semibold">같은 이름의 고객이 있어요</p>
          <ul className="list-disc pl-5">
            {sameName.candidates.map((c) => (
              <li key={c.customerId}>
                <Link to={`/customers/${c.customerId}`} className="underline">
                  {c.name} {c.phone ? formatPhone(c.phone) : '(전화번호 없음)'}
                </Link>{' '}
                — {HINT_TEXT[c.hint]}
              </li>
            ))}
          </ul>
          <Button type="button" variant="outline" disabled={saving} onClick={(e) => submit(e, true)}>
            다른 고객이에요, 저장
          </Button>
        </div>
      )}
      {failed && (
        <p role="alert" className="text-sm text-destructive">
          {FAILED_TEXT[failed]}
          {/* 충돌: 입력은 그대로 두고 최신 값을 다시 불러온다(설계 05 D4). 다음 저장은 최신 version으로 보낸다. */}
          {failed === 'conflict' && (
            <button type="button" className="ml-2 underline" onClick={reloadLatest}>
              다시 불러오기
            </button>
          )}
        </p>
      )}
      {latest && !failed && (
        <p role="status" className="text-sm text-muted-foreground">
          최신 값을 불러왔어요. 입력은 그대로 두었으니 확인한 뒤 다시 저장해 주세요.
          {changedFields.map((f) => ` ${FIELD_LABEL[f]}: ${(f === 'phone' && latest.phone ? formatPhone(latest.phone) : latest[f]) || '(비어 있음)'}.`)}
        </p>
      )}

      <div className="flex gap-2">
        <Button type="submit" disabled={saving}>
          저장
        </Button>
        <Button asChild variant="ghost">
          <Link to={initial ? `/customers/${initial.id}` : '/customers'}>취소</Link>
        </Button>
      </div>
    </form>
  );
}

function Field({ label, error, message, children }: { label: string; error?: FieldError; message?: string; children: ReactElement }) {
  const text = message ?? (error && ERROR_TEXT[error.code]);
  return (
    <div className="flex flex-col gap-1 text-sm">
      <label className="flex flex-col gap-1 font-medium [&>*]:rounded-md [&>*]:border [&>*]:px-3 [&>*]:py-2 [&>*]:text-base [&>*]:font-normal">
        {label}
        {children}
      </label>
      {text && <p className="text-destructive">{text}</p>}
    </div>
  );
}
