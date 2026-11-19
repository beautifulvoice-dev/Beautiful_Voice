// 고객 카드: 개인 정보·지갑·방문 기록을 한 화면에서 본다(CUS-4). 노트북에서는 두 칸으로 펼친다.
import { ChevronLeft, Pencil } from 'lucide-react';
import { useCallback, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { EmptyState, ErrorState } from '@/components/states/DataState';
import { Button } from '@/components/ui/button';
import { useCustomerApi } from '@/features/customers/api';
import {
  formatDate,
  formatDateTime,
  formatPhone,
  formatWon,
  visitStatusText,
  walletBalance,
  WALLET_LABEL_TEXT,
  type CustomerDetail,
} from '@/features/customers/model';
import { useLoad } from '@/lib/useLoad';

export function CustomerDetailPage() {
  const { id = '' } = useParams();
  const api = useCustomerApi();
  const load = useCallback(() => api.get(id), [api, id]);
  const { state, reload } = useLoad(load);

  return (
    <div className="flex flex-col gap-4 px-4 pt-6">
      <Link to="/customers" className="flex items-center gap-1 text-sm text-muted-foreground">
        <ChevronLeft aria-hidden className="size-4" />
        고객 목록
      </Link>
      {state.status === 'loading' && <p className="py-8 text-center text-sm text-muted-foreground">불러오는 중…</p>}
      {state.status === 'error' && <ErrorState onRetry={reload} />}
      {state.status === 'ok' && !state.data && <EmptyState title="없는 고객이에요" />}
      {state.status === 'ok' && state.data && <CustomerCard customer={state.data} />}
    </div>
  );
}

function CustomerCard({ customer: c }: { customer: CustomerDetail }) {
  const now = new Date();
  const visits = [...c.visits].sort((a, b) => b.startsAt.localeCompare(a.startsAt));
  const wallet = [...c.wallet].sort((a, b) => b.at.localeCompare(a.at));

  return (
    <>
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{c.name}</h1>
        <Button asChild variant="outline" size="sm">
          <Link to={`/customers/${c.id}/edit`}>
            <Pencil aria-hidden />
            수정
          </Link>
        </Button>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Section title="개인 정보">
          <dl className="grid grid-cols-[6rem_1fr] gap-y-2 text-sm">
            <dt className="text-muted-foreground">전화번호</dt>
            <dd>{c.phone ? formatPhone(c.phone) : '없음'}</dd>
            <dt className="text-muted-foreground">특이사항</dt>
            <dd className="whitespace-pre-line">{c.memo ?? '없음'}</dd>
          </dl>
        </Section>

        <Section title="지갑" aside={<span aria-label="지갑 잔액">잔액 {formatWon(walletBalance(c.wallet))}</span>}>
          {wallet.length === 0 ? (
            <p className="text-sm text-muted-foreground">지갑 기록이 없어요</p>
          ) : (
            <ul aria-label="지갑 기록" className="divide-y text-sm">
              {wallet.map((e) => (
                <li key={e.id} className="flex justify-between gap-2 py-2">
                  <span>
                    {formatDate(e.at)} · {WALLET_LABEL_TEXT[e.label]}
                    {e.memo && <span className="text-muted-foreground"> · {e.memo}</span>}
                  </span>
                  <span className="shrink-0 tabular-nums">{formatWon(e.amount, true)}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="방문 기록" className="md:col-span-2">
          {visits.length === 0 ? (
            <p className="text-sm text-muted-foreground">방문 기록이 없어요</p>
          ) : (
            <ul aria-label="방문 기록" className="divide-y text-sm">
              {visits.map((v) => (
                <li key={v.id} className="flex justify-between gap-2 py-2">
                  <span>
                    {formatDateTime(v.startsAt)} · {v.menu}
                  </span>
                  <span className="shrink-0 font-medium">{visitStatusText(v, now)}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </>
  );
}

function Section({ title, aside, className, children }: { title: string; aside?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section aria-label={title} className={`rounded-md border p-4 ${className ?? ''}`}>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold">{title}</h2>
        {aside && <span className="text-sm font-medium">{aside}</span>}
      </div>
      {children}
    </section>
  );
}
