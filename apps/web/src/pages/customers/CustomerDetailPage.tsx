// 고객 상세 (W6, BEA-172·174). 디자인(11/20 인계 w5.png "W6 고객 상세"):
// 머리(큰 이름 · 전화) · 버튼 · 폰은 탭 [정보 · 예약 · 지갑 · 문자], 웹은 두 칸(왼쪽 정보·예약, 오른쪽 지갑·문자).
// 예약 칸: "다가오는 예약"(예정) 카드와 "지난 방문"(완료·노쇼·취소 배지). 되돌린(voided) 예약은 보이지 않는다(명세 1 §3.3).
// M1에서는 지갑·문자 칸이 "준비 중" 자리만 있다(설계서 W6, 2A-2-B3).
// 버튼(설계서 W6): 주 `예약 넣기`(캘린더의 예약 넣기 W3를 이 고객으로 채워 연다), `정보 고치기`, `문자 보내기`(M3라 꺼짐), ⋯(비활성으로 바꾸기·다시 활성으로).
// 비활성(BEA-173, 결정 R30·S4): 배지 "비활성". 바꿀 때 확인 창 — 예약·지갑 기록은 그대로, 예약은 취소되지 않는다. 비활성 고객은 새 예약에 고를 수 없어 `예약 넣기`를 끈다(04 D3).
// 날짜는 캘린더와 같은 `11/24(화) 16:00`(shortDate·shopTime).
// ASSUMPTION: "고객 된 날"은 계약 Customer에 필드가 없어 넣지 않는다.
import { ActionButton, AlertDialog, Badge, Icon, Popover, Tabs, useBreakpointValue } from '@seed-design/react';
import { Ellipsis, MessageSquare } from 'lucide-react';
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { HttpError, NetworkError } from '@/lib/http';
import { useRetryKey } from '@/lib/retryKey';
import { shortDate } from '@/features/calendar/bookingText';
import { shopDate, shopTime } from '@/features/calendar/model';
import { EmptyState, ErrorState } from '@/components/states/DataState';
import { CustomerConflictError, useCustomerApi } from '@/features/customers/api';
import { formatBirthdate, formatPhone, visitHistory, VISIT_STATUS_TEXT, type CustomerDetail } from '@/features/customers/model';
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
      {state.status === 'ok' && state.data && <CustomerView customer={state.data} onChanged={reload} />}
    </div>
  );
}

/** 예약 시각 — 캘린더와 같은 형식 "11/24(화) 16:00"(매장 시간대). */
const visitTime = (iso: string) => `${shortDate(shopDate(Date.parse(iso)))} ${shopTime(iso)}`;

function CustomerView({ customer: c, onChanged }: { customer: CustomerDetail; onChanged: () => void }) {
  const isWeb = useBreakpointValue({ base: false, md: true }) ?? false;
  const api = useCustomerApi();
  const navigate = useNavigate();
  const inactive = c.active === false;
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const changingActive = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // 같은 바꾸기를 다시 보내면(응답 유실 뒤) 같은 Idempotency-Key — 서버가 첫 결과를 돌려준다(#81 리뷰, 설계 05 D5).
  const retryKey = useRetryKey();
  const setActive = async (active: boolean) => {
    if (changingActive.current) return;
    changingActive.current = true;
    setBusy(true);
    setError(null);
    try {
      const idempotencyKey = retryKey.keyFor(JSON.stringify([c.id, c.version ?? null, active]));
      await api.setActive(c.id, active, { version: c.version, idempotencyKey });
      retryKey.settle();
      setConfirming(false);
      onChanged();
    } catch (err) {
      // 연결이 끊기거나 5xx가 오면 서버에 반영됐을 수 있어 같은 키로 다시 보낸다.
      const resultUnknown = err instanceof NetworkError || (err instanceof HttpError && err.status >= 500);
      if (!resultUnknown) retryKey.settle();
      if (err instanceof CustomerConflictError) {
        // 그사이 다른 곳에서 고객을 바꿨다 — 최신 고객을 다시 읽어 상태를 보여 주고, 필요하면 다시 고르게 한다(#81 리뷰).
        setConfirming(false);
        setError('다른 곳에서 이 고객이 바뀌어 최신 상태를 다시 불러왔어요. 확인한 뒤 다시 해 주세요.');
        onChanged();
      } else {
        setError('바꾸지 못했어요. 잠시 뒤 다시 해 주세요.');
      }
    } finally {
      changingActive.current = false;
      setBusy(false);
    }
  };
  const copyPhone = async () => {
    if (!c.phone) return;
    try {
      await navigator.clipboard.writeText(formatPhone(c.phone));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 복사를 못 하는 브라우저 — 번호는 화면에 그대로 보인다.
    }
  };
  // 예약 넣기: 캘린더로 가서 W3를 이 고객으로 채워 연다(CalendarPage가 기록 상태 entryFor를 읽는다).
  const book = () => navigate('/calendar', { state: { entryFor: { id: c.id, name: c.name, phone: c.phone ?? null } } });
  const info = <InfoCard customer={c} />;
  const visits = <VisitsCard customer={c} />;
  // M1은 지갑·문자 자리만(설계서 W6 "준비 중", 2A-2-B3)
  const wallet = <ComingCard title="지갑" text="준비 중" />;
  const messages = <ComingCard title="문자" text="준비 중" />;

  return (
    <>
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="flex flex-col gap-0.5 md:flex-row md:items-baseline md:gap-3">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-ink">{c.name}</h1>
            {inactive && (
              <Badge.Root tone="neutral" variant="weak" size="large">
                <Badge.Label>비활성</Badge.Label>
              </Badge.Root>
            )}
          </div>
          {c.phone ? (
            <button
              type="button"
              onClick={copyPhone}
              className="w-fit text-left text-sm text-ink-soft tabular-nums"
              aria-label={`전화번호 ${formatPhone(c.phone)} 복사`}
            >
              {formatPhone(c.phone)}
              {copied && <span className="pl-2 text-brand-text">복사했어요</span>}
            </button>
          ) : (
            <p className="text-sm text-ink-soft">전화번호 없음</p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ActionButton variant="brandSolid" size="medium" disabled={inactive} onClick={book} className="max-md:flex-1">
            예약 넣기
          </ActionButton>
          <ActionButton asChild variant="neutralWeak" size="medium">
            <Link to={`/customers/${c.id}/edit`}>정보 고치기</Link>
          </ActionButton>
          {/* 문자 보내기는 M3(2D-2) — 자리만 */}
          <ActionButton variant="neutralWeak" size="medium" layout="iconOnly" aria-label="문자 보내기" disabled>
            <Icon svg={<MessageSquare />} />
          </ActionButton>
          <Popover.Root open={menuOpen} onOpenChange={setMenuOpen} placement="bottom-end">
            <Popover.Trigger asChild>
              <ActionButton variant="ghost" size="medium" layout="iconOnly" aria-label="더보기" disabled={busy}>
                <Icon svg={<Ellipsis />} />
              </ActionButton>
            </Popover.Trigger>
            <Popover.Positioner>
              <Popover.Content className="p-1">
                <ActionButton
                  variant="ghost"
                  size="medium"
                  className="w-full justify-start"
                  loading={busy}
                  onClick={() => {
                    setMenuOpen(false);
                    if (inactive) void setActive(true);
                    else setConfirming(true);
                  }}
                >
                  {inactive ? '다시 활성으로' : '비활성으로 바꾸기'}
                </ActionButton>
              </Popover.Content>
            </Popover.Positioner>
          </Popover.Root>
        </div>
        {inactive && <p className="text-sm text-ink-soft md:hidden">비활성 고객은 새 예약에 고를 수 없어요.</p>}
        {error && !confirming && (
          <p role="alert" className="text-sm text-critical-text">
            {error}
          </p>
        )}
      </div>

      <AlertDialog.Root open={confirming} onOpenChange={setConfirming}>
        <AlertDialog.Backdrop />
        <AlertDialog.Positioner>
          <AlertDialog.Content>
            <AlertDialog.Header>
              <AlertDialog.Title>{c.name} 님을 비활성으로 바꿀까요?</AlertDialog.Title>
              <AlertDialog.Description>비활성으로 바꿔도 예약과 지갑 기록은 그대로 남아요. 예약도 취소되지 않아요.</AlertDialog.Description>
              {error && (
                // 확인 창은 모달이라 창 안에 알린다(뒤 화면은 가려짐)
                <p role="alert" className="text-sm text-critical-text">
                  {error}
                </p>
              )}
            </AlertDialog.Header>
            <AlertDialog.Footer>
              <AlertDialog.Action asChild>
                <ActionButton variant="neutralWeak" size="large" flexGrow={1}>
                  그만두기
                </ActionButton>
              </AlertDialog.Action>
              <ActionButton variant="neutralSolid" size="large" flexGrow={1} loading={busy} onClick={() => setActive(false)}>
                비활성으로 바꾸기
              </ActionButton>
            </AlertDialog.Footer>
          </AlertDialog.Content>
        </AlertDialog.Positioner>
      </AlertDialog.Root>

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
      <span className="text-base font-semibold text-ink tabular-nums">{visitTime(startsAt)}</span>
      <span className="text-sm text-ink-soft">{menu}</span>
    </span>
  );
}

function StatusBadge({ status }: { status: ShownStatus }) {
  return (
    <Badge.Root tone={STATUS_TONE[status]} variant="weak" size="large" className="shrink-0">
      <Badge.Label>{VISIT_STATUS_TEXT[status]}</Badge.Label>
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
