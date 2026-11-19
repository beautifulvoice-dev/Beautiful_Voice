// 고객 등록·수정 (CUS-1·2, 분해표 C-03). 이름만 필수, 전화번호는 권장.
// 같은 이름 고객이 있으면 저장 전에 "같은 이름의 고객이 있어요"로 확인을 받는다. 자동으로 합치지 않는다(CUS-2).
import { validateNewCustomer, type CustomerErrorCode, type CustomerField, type FieldError } from '@bv/customers';
import type { Candidate } from '@bv/customers/duplicates';
import { useCallback, useState, type ReactElement, type SyntheticEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { EmptyState, ErrorState } from '@/components/states/DataState';
import { Button } from '@/components/ui/button';
import { CustomerValidationError, useCustomerApi } from '@/features/customers/api';
import { formatPhone, type Customer } from '@/features/customers/model';
import { useLoad } from '@/lib/useLoad';

const ERROR_TEXT: Record<CustomerErrorCode, string> = {
  NAME_REQUIRED: '이름을 입력해 주세요.',
  PHONE_INVALID_CHARACTERS: '전화번호에는 숫자와 - 만 쓸 수 있어요.',
  PHONE_INVALID_FORMAT: '전화번호 형식이 맞지 않아요. 예: 010-1234-5678',
  BIRTHDATE_INVALID: '생년월일은 실제 날짜로 적어 주세요. 예: 1990-01-31',
};

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

function CustomerForm({ initial }: { initial: Customer | null }) {
  const api = useCustomerApi();
  const navigate = useNavigate();
  const [name, setName] = useState(initial?.name ?? '');
  const [phone, setPhone] = useState(initial?.phone ? formatPhone(initial.phone) : '');
  const [memo, setMemo] = useState(initial?.memo ?? '');
  const [errors, setErrors] = useState<FieldError[]>([]);
  // 동명이인 후보는 어떤 입력으로 조회했는지와 묶어 둔다 — 그 입력 그대로일 때만 "다른 고객이에요, 저장"이 통한다(#32 리뷰).
  const [sameName, setSameName] = useState<{ candidates: Candidate[]; name: string; phone: string | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const errorOf = (field: CustomerField) => errors.find((e) => e.field === field);

  async function submit(e: SyntheticEvent, confirmedSameName = false) {
    e.preventDefault();
    setFailed(false);
    const checked = validateNewCustomer({ name, phone, memo });
    if (!checked.ok) return setErrors(checked.errors);
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
      const saved = initial ? await api.update(initial.id, { name, phone, memo }) : await api.create({ name, phone, memo });
      navigate(`/customers/${saved.id}`, { replace: !!initial });
    } catch (err) {
      if (err instanceof CustomerValidationError) setErrors(err.errors);
      else setFailed(true);
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
      {failed && <p role="alert" className="text-sm text-destructive">저장하지 못했어요. 다시 시도해 주세요.</p>}

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

function Field({ label, error, children }: { label: string; error?: FieldError; children: ReactElement }) {
  return (
    <div className="flex flex-col gap-1 text-sm">
      <label className="flex flex-col gap-1 font-medium [&>*]:rounded-md [&>*]:border [&>*]:px-3 [&>*]:py-2 [&>*]:text-base [&>*]:font-normal">
        {label}
        {children}
      </label>
      {error && <p className="text-destructive">{ERROR_TEXT[error.code]}</p>}
    </div>
  );
}
