// 매장 정보(W13, BEA-166): 매장 이름(읽기)·영업시간 요약(누르면 영업시간 화면)·위치·링크 3개·환불 정책.
// 서버 #45 GET/PUT settings/shop-info(version 없음, 통째로 저장). 링크는 계약상 http(s)만 — `naver.me/abc`·`@아이디`는
// 화면에서 https 주소로 보완해 보낸다(11/22 옵마 결정). 저장 중 두 번 누름 막기·재시도 키는 다른 설정 화면과 같은 useSaveAction.
// 이 값들은 문자 변수 "매장 위치·링크"의 출처다(명세 W13).
import type { ShopInfo } from '@bv/contracts';
import { ActionButton, Field, TextField } from '@seed-design/react';
import { useCallback, useState } from 'react';
import { Link } from 'react-router';
import { useShopName } from '@/components/layout/AppShell';
import { ErrorState } from '@/components/states/DataState';
import { FieldsInvalidError, useSettingsApi } from '@/features/settings/api';
import { hoursSummary, weeklyDaysOf } from '@/features/settings/hours';
import { completeLink, SHOP_INFO_ERROR, SHOP_INFO_LABEL, type LinkField } from '@/features/settings/shopInfo';
import { useSaveAction } from '@/features/settings/useSaveAction';
import { useIsPhone } from '@/lib/useLayout';
import { useLoad } from '@/lib/useLoad';

export const SHOP_INFO_SAVED_TEXT = '매장 정보를 저장했어요.';

export function ShopInfoPage() {
  const api = useSettingsApi();
  const shopName = useShopName();
  const load = useCallback(() => Promise.all([api.getShopInfo(), api.getBusinessHours(), api.listClosures()]), [api]);
  const { state, reload } = useLoad(load);

  return (
    <div className="flex flex-col gap-4 px-4 pt-6 md:px-0 md:pt-0">
      <Link to="/settings" className="text-sm text-ink-soft md:hidden">
        ‹ 설정
      </Link>
      {state.status === 'loading' && <p className="py-8 text-center text-sm text-ink-soft">불러오는 중…</p>}
      {state.status === 'error' && <ErrorState onRetry={reload} />}
      {state.status === 'ok' && (
        <ShopInfoForm
          shopName={shopName}
          initial={state.data[0]}
          hours={hoursSummary(state.data[1], weeklyDaysOf(state.data[2]))}
          reload={reload}
        />
      )}
    </div>
  );
}

const LINKS: { field: LinkField; placeholder: string }[] = [
  { field: 'naverPlaceUrl', placeholder: 'naver.me/…' },
  { field: 'instagramUrl', placeholder: '@아이디' },
  { field: 'landingUrl', placeholder: '홈페이지 주소' },
];

type Draft = Record<keyof ShopInfo, string>;
const toDraft = (i: ShopInfo): Draft => ({
  locationText: i.locationText ?? '',
  naverPlaceUrl: i.naverPlaceUrl ?? '',
  instagramUrl: i.instagramUrl ?? '',
  landingUrl: i.landingUrl ?? '',
  refundPolicy: i.refundPolicy ?? '',
});

function ShopInfoForm({ shopName, initial, hours, reload }: { shopName: string; initial: ShopInfo; hours: string; reload: () => void }) {
  const api = useSettingsApi();
  const [draft, setDraft] = useState<Draft>(() => toDraft(initial));
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof ShopInfo, string>>>({});
  const [saved, setSaved] = useState(false);
  const save = useSaveAction(reload);

  const change = (field: keyof ShopInfo, value: string) => {
    setDraft((d) => ({ ...d, [field]: value }));
    setFieldErrors((e) => ({ ...e, [field]: undefined }));
    setSaved(false);
    save.clear();
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const info: ShopInfo = {
      locationText: draft.locationText.trim() || null,
      naverPlaceUrl: completeLink('naverPlaceUrl', draft.naverPlaceUrl),
      instagramUrl: completeLink('instagramUrl', draft.instagramUrl),
      landingUrl: completeLink('landingUrl', draft.landingUrl),
      refundPolicy: draft.refundPolicy.trim() || null,
    };
    const result = await save.run(async (key) => {
      try {
        return await api.putShopInfo(info, { idempotencyKey: key });
      } catch (err) {
        if (err instanceof FieldsInvalidError) {
          const next: Partial<Record<keyof ShopInfo, string>> = {};
          for (const f of err.errors as unknown as { field: keyof ShopInfo; code: string }[]) {
            next[f.field] ??= SHOP_INFO_ERROR[f.code] ?? SHOP_INFO_ERROR.INVALID_TEXT;
          }
          setFieldErrors(next);
        }
        throw err;
      }
    });
    if (result !== undefined) {
      // 보완한 주소(https://…)를 칸에 그대로 보여 준다 — 무엇이 저장됐는지 원장이 볼 수 있게.
      setDraft(toDraft(result));
      setSaved(true);
    }
  }

  const problem = save.problem && save.problem.kind !== 'fields' && 'message' in save.problem ? save.problem.message : null;
  // 저장 버튼은 하나만: 웹은 제목 오른쪽(W13 디자인), 폰은 맨 아래.
  const phone = useIsPhone();
  const saveButton = (
    <ActionButton type="submit" variant="brandSolid" size={phone ? 'large' : 'medium'} loading={save.saving}>
      저장
    </ActionButton>
  );

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          {/* 폰: 제목 위 매장 이름(디자인 .p-shop) */}
          <p className="text-sm font-bold text-ink-soft md:hidden">{shopName}</p>
          <h1 className="text-xl font-semibold text-ink md:text-2xl">매장 정보</h1>
        </div>
        {/* 웹: 제목 오른쪽 저장(W13 디자인) */}
        {!phone && saveButton}
      </div>

      <fieldset disabled={save.saving} className="flex flex-col gap-4">
        <dl className="m-0 grid gap-3 rounded-xl border border-line p-4 text-[15px]">
          <div className="flex justify-between gap-3">
            <dt className="text-ink-soft">매장 이름</dt>
            <dd className="m-0 font-semibold">{shopName}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-ink-soft">영업시간</dt>
            <dd className="m-0">
              <Link to="/settings/hours" className="font-semibold text-ink">
                {hours} ›
              </Link>
            </dd>
          </div>
        </dl>

        <TextRow label={SHOP_INFO_LABEL.locationText} value={draft.locationText} error={fieldErrors.locationText} onChange={(v) => change('locationText', v)} />
        {LINKS.map(({ field, placeholder }) => (
          <TextRow
            key={field}
            label={SHOP_INFO_LABEL[field]}
            value={draft[field]}
            placeholder={placeholder}
            error={fieldErrors[field]}
            onChange={(v) => change(field, v)}
          />
        ))}
        <Field.Root invalid={!!fieldErrors.refundPolicy}>
          <Field.Header>
            <Field.Label>{SHOP_INFO_LABEL.refundPolicy}</Field.Label>
          </Field.Header>
          <TextField.Root size="large">
            <TextField.Textarea autoresize className="min-h-20" value={draft.refundPolicy} onChange={(e) => change('refundPolicy', e.target.value)} />
          </TextField.Root>
          {fieldErrors.refundPolicy && (
            <Field.Footer>
              <Field.ErrorMessage>{fieldErrors.refundPolicy}</Field.ErrorMessage>
            </Field.Footer>
          )}
        </Field.Root>
      </fieldset>
      <p className="text-sm text-ink-soft">링크는 주소 앞부분 없이 적어도 돼요. 저장할 때 https:// 주소로 바꿔 둬요.</p>

      {problem && (
        <p role="alert" className="text-sm text-critical-text">
          {problem}
        </p>
      )}
      {saved && (
        <p role="status" className="text-sm text-ink-soft">
          {SHOP_INFO_SAVED_TEXT}
        </p>
      )}
      {phone && saveButton}
    </form>
  );
}

function TextRow({
  label,
  value,
  placeholder,
  error,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  error?: string;
  onChange: (v: string) => void;
}) {
  return (
    <Field.Root invalid={!!error}>
      <Field.Header>
        <Field.Label>{label}</Field.Label>
      </Field.Header>
      <TextField.Root size="large">
        <TextField.Input value={value} placeholder={placeholder} autoComplete="off" onChange={(e) => onChange(e.target.value)} />
      </TextField.Root>
      {error && (
        <Field.Footer>
          <Field.ErrorMessage>{error}</Field.ErrorMessage>
        </Field.Footer>
      )}
    </Field.Root>
  );
}
