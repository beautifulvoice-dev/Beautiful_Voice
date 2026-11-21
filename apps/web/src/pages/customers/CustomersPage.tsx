// 고객 목록·검색 (W5, BEA-172). 디자인(11/20 인계 w5.png): 제목 + 고객 수, "+ 고객"(등록 시트), SEED 검색 칸,
// 줄마다 이름 첫 글자 동그라미 · 이름(같은 이름이면 "동명 n") · 전화.
// 검색어(고객 이름·전화번호)는 주소에 넣지 않는다 — 복사·공유되는 URL에 개인정보가 남지 않게.
// 대신 라우터 기록 상태(location.state)에 둬서 고객 카드에서 뒤로 오면 검색이 유지된다.
// ASSUMPTION: 디자인의 "마지막 방문"·잔액·활성/비활성 칩·장부 옮기기 카드는 아직 데이터(계약 목록에 마지막 방문 없음, 지갑 M2,
// 비활성화 화면 BEA-173, 장부 M4)가 없어 넣지 않는다. 생기면 줄에 더한다.
import type { Customer } from '@/features/customers/model';
import { ActionButton, ResponsiveDialog, SearchInput } from '@seed-design/react';
import { useCallback } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { EmptyState, ErrorState } from '@/components/states/DataState';
import { useCustomerApi } from '@/features/customers/api';
import { formatPhone } from '@/features/customers/model';
import { useLoad } from '@/lib/useLoad';
import { CustomerForm } from './CustomerFormPage';

export function CustomersPage() {
  const api = useCustomerApi();
  const location = useLocation();
  const navigate = useNavigate();
  const q = (location.state as { q?: string } | null)?.q ?? '';
  const load = useCallback(() => api.list(q), [api, q]);
  const { state, reload } = useLoad(load);
  const setQ = (v: string) => navigate(location.pathname, { replace: true, state: v ? { q: v } : null });
  // 디자인(W5 "+ 고객: 시트"): /customers/new 는 목록 위에 등록 시트를 연다. 닫으면 목록(검색어 유지).
  const adding = location.pathname === '/customers/new';
  const closeAdd = () => navigate('/customers', { replace: true, state: location.state });

  const addButton = (
    <ActionButton asChild variant="brandSolid" size="small">
      {/* 검색어(기록 상태)를 들고 가서, 시트를 닫으면 같은 검색 결과로 돌아온다. */}
      <Link to="/customers/new" state={location.state}>
        + 고객
      </Link>
    </ActionButton>
  );

  return (
    <div className="flex flex-col gap-4 px-4 pt-6 md:max-w-2xl">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col">
          <h1 className="text-2xl font-bold text-ink">고객</h1>
          {state.status === 'ok' && (
            <p className="text-sm text-ink-soft">{q ? `찾은 고객 ${state.data.length}명` : `고객 ${state.data.length}명`}</p>
          )}
        </div>
        {addButton}
      </div>

      <SearchInput.Root value={q} onValueChange={setQ}>
        <SearchInput.Input type="search" aria-label="고객 검색" placeholder="이름이나 전화번호" />
        <SearchInput.ClearButton aria-label="검색어 지우기" />
      </SearchInput.Root>

      {state.status === 'loading' && <p className="py-8 text-center text-sm text-ink-soft">불러오는 중…</p>}
      {state.status === 'error' && <ErrorState onRetry={reload} />}
      {state.status === 'ok' &&
        state.data.length === 0 &&
        (q ? (
          <EmptyState title="검색 결과가 없어요" description={`"${q}"와 맞는 고객이 없어요.`} />
        ) : (
          <EmptyState title="아직 고객이 없어요" description="직접 넣어 첫 고객을 등록해 보세요." action={addButton} />
        ))}
      {state.status === 'ok' && state.data.length > 0 && <CustomerRows customers={state.data} />}

      <ResponsiveDialog.Root open={adding} onOpenChange={(open) => !open && closeAdd()}>
        <ResponsiveDialog.Positioner>
          <ResponsiveDialog.Backdrop />
          <ResponsiveDialog.Content>
            <ResponsiveDialog.Header>
              <ResponsiveDialog.Title>고객 등록</ResponsiveDialog.Title>
            </ResponsiveDialog.Header>
            <ResponsiveDialog.Body>
              {/* 열 때마다 새로 만든다 — 지난번 입력이 남지 않게(#61 리뷰). 저장하면 그 고객 상세로 간다. */}
              {adding && <CustomerForm initial={null} onCancel={closeAdd} />}
            </ResponsiveDialog.Body>
          </ResponsiveDialog.Content>
        </ResponsiveDialog.Positioner>
      </ResponsiveDialog.Root>
    </div>
  );
}

function CustomerRows({ customers }: { customers: Customer[] }) {
  // 같은 이름 구별(결정 R22): 이름 옆 작은 글자 "동명 n" — 화면에 보이는 목록 안에서 센다.
  const sameName = new Map<string, number>();
  for (const c of customers) sameName.set(c.name, (sameName.get(c.name) ?? 0) + 1);

  return (
    <ul aria-label="고객 목록" className="flex flex-col divide-y divide-line">
      {customers.map((c) => (
        <li key={c.id}>
          <Link to={`/customers/${c.id}`} className="flex items-center gap-3 py-3 hover:bg-neutral-weak">
            <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand-weak text-base font-semibold text-brand-text">
              {c.name.slice(0, 1)}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="text-base font-semibold text-ink">
                {c.name}
                {(sameName.get(c.name) ?? 0) > 1 && <span className="pl-1.5 text-sm font-normal text-ink-soft">동명 {sameName.get(c.name)}</span>}
              </span>
              <span className="text-sm text-ink-soft">{c.phone ? formatPhone(c.phone) : '전화번호 없음'}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
