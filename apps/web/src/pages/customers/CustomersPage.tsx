// 고객 목록·검색 (P2-02, 분해표 C-03).
// 검색어(고객 이름·전화번호)는 주소에 넣지 않는다 — 복사·공유되는 URL에 개인정보가 남지 않게.
// 대신 라우터 기록 상태(location.state)에 둬서 고객 카드에서 뒤로 오면 검색이 유지된다.
import { Plus, Search } from 'lucide-react';
import { useCallback } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { EmptyState, ErrorState } from '@/components/states/DataState';
import { Button } from '@/components/ui/button';
import { useCustomerApi } from '@/features/customers/api';
import { formatPhone } from '@/features/customers/model';
import { useLoad } from '@/lib/useLoad';

export function CustomersPage() {
  const api = useCustomerApi();
  const location = useLocation();
  const navigate = useNavigate();
  const q = (location.state as { q?: string } | null)?.q ?? '';
  const load = useCallback(() => api.list(q), [api, q]);
  const { state, reload } = useLoad(load);

  const addButton = (
    <Button asChild>
      <Link to="/customers/new">
        <Plus aria-hidden />
        고객 등록
      </Link>
    </Button>
  );

  return (
    <div className="flex flex-col gap-4 px-4 pt-6 md:max-w-2xl">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">고객</h1>
        {addButton}
      </div>
      <label className="flex items-center gap-2 rounded-md border px-3 py-2">
        <Search aria-hidden className="size-4 text-muted-foreground" />
        <input
          type="search"
          aria-label="고객 검색"
          placeholder="이름 또는 전화번호"
          className="flex-1 bg-transparent text-base outline-none"
          value={q}
          onChange={(e) => navigate(location.pathname, { replace: true, state: e.target.value ? { q: e.target.value } : null })}
        />
      </label>

      {state.status === 'loading' && <p className="py-8 text-center text-sm text-muted-foreground">불러오는 중…</p>}
      {state.status === 'error' && <ErrorState onRetry={reload} />}
      {state.status === 'ok' && state.data.length === 0 && (
        q ? (
          <EmptyState title="검색 결과가 없어요" description={`"${q}"와 맞는 고객이 없어요.`} />
        ) : (
          <EmptyState title="아직 고객이 없어요" description="첫 고객을 등록해 보세요." action={addButton} />
        )
      )}
      {state.status === 'ok' && state.data.length > 0 && (
        <ul aria-label="고객 목록" className="divide-y rounded-md border">
          {state.data.map((c) => (
            <li key={c.id}>
              <Link to={`/customers/${c.id}`} className="flex flex-col gap-0.5 px-4 py-3 hover:bg-accent">
                <span className="font-medium">{c.name}</span>
                <span className="text-sm text-muted-foreground">{c.phone ? formatPhone(c.phone) : '전화번호 없음'}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
