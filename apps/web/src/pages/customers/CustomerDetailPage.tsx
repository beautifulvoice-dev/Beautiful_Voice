// 고객 상세: 정보와 예약·방문 이력을 본다. 지갑·발송 이력은 M1에서 자리만 둔다(명세 3 2A-2.4).
// 노트북에서는 두 칸으로 펼친다.
import { ChevronLeft, Pencil } from 'lucide-react';
import { useCallback, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { EmptyState, ErrorState } from '@/components/states/DataState';
import { Button } from '@/components/ui/button';
import { useCustomerApi } from '@/features/customers/api';
import { formatBirthdate, formatDateTime, formatPhone, visitHistory, VISIT_STATUS_TEXT, type CustomerDetail } from '@/features/customers/model';
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
  const visits = c.visits && visitHistory(c.visits);

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
            {/* 생년월일·거주지는 개인정보라 상세에서만 보인다(목록 카드에는 없음). */}
            <dt className="text-muted-foreground">생년월일</dt>
            <dd>{c.birthdate ? formatBirthdate(c.birthdate) : '없음'}</dd>
            <dt className="text-muted-foreground">거주지</dt>
            <dd>{c.address ?? '없음'}</dd>
            <dt className="text-muted-foreground">특이사항</dt>
            <dd className="whitespace-pre-line">{c.memo ?? '없음'}</dd>
          </dl>
        </Section>

        <Section title="지갑">
          <p className="text-sm text-muted-foreground">지갑은 다음 단계에서 열려요</p>
        </Section>

        <Section title="예약·방문 이력" className="md:col-span-2">
          {visits === null ? (
            <p className="text-sm text-muted-foreground">예약·방문 이력은 준비 중이에요</p>
          ) : visits.length === 0 ? (
            <p className="text-sm text-muted-foreground">예약·방문 이력이 없어요</p>
          ) : (
            <ul aria-label="예약·방문 이력" className="divide-y text-sm">
              {visits.map((v) => (
                <li key={v.id} className="flex justify-between gap-2 py-2">
                  <span>
                    {formatDateTime(v.startsAt)} · {v.menu}
                  </span>
                  <span className="shrink-0 font-medium">{VISIT_STATUS_TEXT[v.status]}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="발송 이력" className="md:col-span-2">
          <p className="text-sm text-muted-foreground">문자 발송 이력은 다음 단계에서 열려요</p>
        </Section>
      </div>
    </>
  );
}

function Section({ title, className, children }: { title: string; className?: string; children: ReactNode }) {
  return (
    <section aria-label={title} className={`rounded-md border p-4 ${className ?? ''}`}>
      <h2 className="mb-3 font-semibold">{title}</h2>
      {children}
    </section>
  );
}
