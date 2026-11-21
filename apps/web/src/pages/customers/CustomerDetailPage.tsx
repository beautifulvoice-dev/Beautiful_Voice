// 고객 상세 (W6, BEA-172·174). 디자인(11/20 인계 w5.png "W6 고객 상세"):
// 머리(큰 이름 · 전화) · 버튼 · 폰은 탭 [정보 · 예약 · 지갑 · 문자], 웹은 두 칸(왼쪽 정보·예약, 오른쪽 지갑·문자).
// 예약 칸: "다가오는 예약"(예정) 카드와 "지난 방문"(완료·노쇼·취소 배지). 되돌린(voided) 예약은 보이지 않는다(명세 1 §3.3).
// M1에서는 지갑·문자 칸이 "준비 중" 자리만 있다(설계서 W6, 2A-2-B3).
// ASSUMPTION: 디자인의 "예약 넣기"·"문자 보내기"·"비활성으로 바꾸기"·"고객 된 날"은 아직 화면·데이터가 없어(W3 예약 넣기, M3 문자, BEA-173) 넣지 않는다.
import { ActionButton, Badge, Tabs, useBreakpointValue } from '@seed-design/react';
import { useCallback, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { EmptyState, ErrorState } from '@/components/states/DataState';
import { useCustomerApi } from '@/features/customers/api';
import { formatBirthdate, formatDateTime, formatPhone, visitHistory, VISIT_STATUS_TEXT, type CustomerDetail } from '@/features/customers/model';
import { useLoad } from '@/lib/useLoad';

type ShownStatus = keyof typeof VISIT_STATUS_TEXT;
/** 배지 톤 — 디자인 캡처(W6): 완료 초록, 노쇼 빨강, 예정·취소 회색. */
const STATUS_TONE: Record<ShownStatus, 'neutral' | 'positive' | 'critical'> = {
  scheduled: 'neutral',
  completed: 'positive',
  no_show: 'critical',
  cancelled: 'neutral',
};

export function CustomerDetailPage() {
  const { id = '' } = useParams();
  const api = useCustomerApi();
  const load = useCallback(() => api.get(id), [api, id]);
  const { state, reload } = useLoad(load);

  return (
    <div className="flex flex-col gap-4 px-4 pt-6 pb-8 md:max-w-5xl">
      <Link to="/customers" className="text-sm text-ink-soft">
        ‹ 고객 목록
      </Link>
      {state.status === 'loading' && <p className="py-8 text-center text-sm text-ink-soft">불러오는 중…</p>}
      {state.status === 'error' && <ErrorState onRetry={reload} />}
      {state.status === 'ok' && !state.data && <EmptyState title="없는 고객이에요" />}
      {state.status === 'ok' && state.data && <CustomerView customer={state.data} />}
    </div>
  );
}

function CustomerView({ customer: c }: { customer: CustomerDetail }) {
  const isWeb = useBreakpointValue({ base: false, md: true }) ?? false;
  const info = <InfoCard customer={c} />;
  const visits = <VisitsCard customer={c} />;
  const wallet = <ComingCard title="지갑" text="지갑은 다음 단계에서 열려요" />;
  const messages = <ComingCard title="문자" text="문자 발송 이력은 다음 단계에서 열려요" />;

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-0.5 md:flex-row md:items-baseline md:gap-3">
          <h1 className="text-2xl font-bold text-ink">{c.name}</h1>
          <p className="text-sm text-ink-soft">{c.phone ? formatPhone(c.phone) : '전화번호 없음'}</p>
        </div>
        <ActionButton asChild variant="neutralWeak" size="small">
          <Link to={`/customers/${c.id}/edit`}>정보 고치기</Link>
        </ActionButton>
      </div>

      {isWeb ? (
        <div className="grid grid-cols-2 items-start gap-4">
          <div className="flex flex-col gap-4">
            {info}
            {visits}
          </div>
          <div className="flex flex-col gap-4">
            {wallet}
            {messages}
          </div>
        </div>
      ) : (
        <Tabs.Root defaultValue="visits">
          <Tabs.List>
            <Tabs.Trigger value="info">정보</Tabs.Trigger>
            <Tabs.Trigger value="visits">예약</Tabs.Trigger>
            <Tabs.Trigger value="wallet">지갑</Tabs.Trigger>
            <Tabs.Trigger value="messages">문자</Tabs.Trigger>
            <Tabs.Indicator />
          </Tabs.List>
          <Tabs.Content value="info" className="pt-4">
            {info}
          </Tabs.Content>
          <Tabs.Content value="visits" className="pt-4">
            {visits}
          </Tabs.Content>
          <Tabs.Content value="wallet" className="pt-4">
            {wallet}
          </Tabs.Content>
          <Tabs.Content value="messages" className="pt-4">
            {messages}
          </Tabs.Content>
        </Tabs.Root>
      )}
    </>
  );
}

function Card({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="rounded-xl border border-line bg-surface p-4">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        {aside && <span className="text-sm text-ink-soft">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

function InfoCard({ customer: c }: { customer: CustomerDetail }) {
  return (
    <Card title="정보">
      <dl className="grid grid-cols-[5rem_1fr] gap-y-2 text-sm">
        <dt className="text-ink-soft">전화</dt>
        <dd className="text-ink">{c.phone ? formatPhone(c.phone) : '없음'}</dd>
        {/* 생년월일·거주지는 개인정보라 상세에서만 보인다(목록 카드에는 없음). */}
        <dt className="text-ink-soft">생년월일</dt>
        <dd className="text-ink">{c.birthdate ? formatBirthdate(c.birthdate) : '없음'}</dd>
        <dt className="text-ink-soft">거주지</dt>
        <dd className="text-ink">{c.address ?? '없음'}</dd>
        <dt className="text-ink-soft">특이사항</dt>
        <dd className="whitespace-pre-line text-ink">{c.memo ?? '없음'}</dd>
      </dl>
    </Card>
  );
}

function VisitsCard({ customer: c }: { customer: CustomerDetail }) {
  const all = visitHistory(c.visits);
  // 다가오는 예약은 가까운 것부터, 지난 방문은 최근 것부터(visitHistory가 최근순).
  const upcoming = all.filter((v) => v.status === 'scheduled').reverse();
  const past = all.filter((v) => v.status !== 'scheduled');

  return (
    <Card title="예약" aside={`다가오는 ${upcoming.length} · 지난 ${past.length}`}>
      {all.length === 0 ? (
        <p className="text-sm text-ink-soft">예약·방문 이력이 없어요</p>
      ) : (
        <div className="flex flex-col gap-4">
          {upcoming.length > 0 && (
            <ul aria-label="다가오는 예약" className="flex flex-col gap-2">
              {upcoming.map((v) => (
                <li key={v.id} className="flex items-center justify-between gap-2 rounded-lg border border-line p-3">
                  <VisitText startsAt={v.startsAt} menu={v.menu} />
                  <StatusBadge status={v.status} />
                </li>
              ))}
            </ul>
          )}
          {past.length > 0 && (
            <div className="flex flex-col gap-1">
              <h3 className="text-sm font-semibold text-ink-soft">지난 방문</h3>
              <ul aria-label="지난 방문" className="flex flex-col divide-y divide-line">
                {past.map((v) => (
                  <li key={v.id} className="flex items-center justify-between gap-2 py-2">
                    <VisitText startsAt={v.startsAt} menu={v.menu} />
                    <StatusBadge status={v.status} />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function VisitText({ startsAt, menu }: { startsAt: string; menu: string }) {
  return (
    <span className="flex flex-col">
      <span className="text-base font-semibold text-ink">{formatDateTime(startsAt)}</span>
      <span className="text-sm text-ink-soft">{menu}</span>
    </span>
  );
}

function StatusBadge({ status }: { status: ShownStatus }) {
  return (
    // 설계서 §9.3: Badge size large, 글자 14px.
    <Badge.Root tone={STATUS_TONE[status]} variant="weak" size="large" className="shrink-0">
      <Badge.Label className="text-sm">{VISIT_STATUS_TEXT[status]}</Badge.Label>
    </Badge.Root>
  );
}

function ComingCard({ title, text }: { title: string; text: string }) {
  return (
    <Card title={title}>
      <p className="text-sm text-ink-soft">{text}</p>
    </Card>
  );
}
