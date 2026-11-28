import type { CompletionAction, CompletionDeduction, CompletionPreview } from '@bv/contracts';
import { ActionButton } from '@seed-design/react';
import { ChevronRight, Clock3 } from 'lucide-react';
import { useState } from 'react';
import { EmptyState } from '@/components/states/DataState';
import { cn } from '@/lib/utils';

const won = new Intl.NumberFormat('ko-KR');
const time = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false });

const SAMPLE_CARDS: CompletionAction[] = [
  {
    id: '00000000-0000-4000-8000-000000000001', kind: 'completion_cycle', status: 'pending',
    appointmentId: '00000000-0000-4000-8000-000000000011', customerId: '00000000-0000-4000-8000-000000000021',
    cardVersion: 1, customerVersion: 1, priorityRank: 100, appointmentStartAt: '2026-12-01T05:00:00Z',
    customerName: '김서연', menuName: '윤곽 관리', deduction: {
      rank: 1, instrument: 'pass', passId: '00000000-0000-4000-8000-000000000031', quantity: 1,
    },
    warnings: [],
  },
  {
    id: '00000000-0000-4000-8000-000000000002', kind: 'completion_cycle', status: 'pending',
    appointmentId: '00000000-0000-4000-8000-000000000012', customerId: '00000000-0000-4000-8000-000000000022',
    cardVersion: 1, customerVersion: 1, priorityRank: 100, appointmentStartAt: '2026-12-01T06:30:00Z',
    customerName: '박지민', menuName: '수분 관리', deduction: { rank: 2, instrument: 'prepaid', quantity: 30_000 },
    warnings: [],
  },
];

function deductionText(deduction: CompletionDeduction) {
  if (deduction.instrument === 'pass') return `횟수권 ${deduction.quantity}회 차감`;
  if (deduction.instrument === 'prepaid') return `선불금 ${won.format(deduction.quantity)}원 차감`;
  return '차감 없음';
}

function mockPreview(card: CompletionAction): CompletionPreview {
  const renderedPreview = `${card.customerName}님, 오늘 ${card.menuName}을 받으셨어요. ${deductionText(card.deduction)}이 반영될 예정이에요.`;
  const byteLength = [...renderedPreview].reduce((size, char) => size + (char.charCodeAt(0) > 127 ? 2 : 1), 0);
  return {
    renderedPreview, templateId: null,
    templateSlot: card.deduction.instrument === 'pass' ? 'post_session' : 'post_amount',
    byteLength, messageType: byteLength > 90 ? 'LMS' : 'SMS',
    valid: true, missingVariables: [], deduction: card.deduction, warnings: card.warnings,
    cardVersion: card.cardVersion, customerVersion: card.customerVersion,
  };
}

/** 개발 모드에서 시연용 카드 흐름을 확인한다. */
export function CompletionHomePreview() {
  const [cards, setCards] = useState(SAMPLE_CARDS);
  const [selectedId, setSelectedId] = useState(SAMPLE_CARDS[0]!.id);
  const [preview, setPreview] = useState<CompletionPreview | null>(null);
  const [notice, setNotice] = useState<{ text: string; conflict?: true } | null>(null);
  const selected = cards.find((card) => card.id === selectedId);

  function select(cardId: string) {
    setSelectedId(cardId);
    setPreview(null);
    setNotice(null);
  }

  function approve() {
    if (!selected || !preview?.valid) return;
    // 선불 카드의 첫 승인에는 차감액이 바뀐 409 상황을 재현한다.
    if (selected.deduction.instrument === 'prepaid' && selected.deduction.quantity === 30_000) {
      const refreshed = { ...selected, deduction: { ...selected.deduction, quantity: 40_000 } };
      setCards(cards.map((card) => card.id === selected.id ? refreshed : card));
      setPreview(null);
      setNotice({ text: '차감액이 바뀌었어요. 새 차감액과 문자를 다시 확인해 주세요.', conflict: true });
      return;
    }
    const remaining = cards.filter((card) => card.id !== selected.id);
    setCards(remaining);
    setSelectedId(remaining[0]?.id ?? '');
    setPreview(null);
    setNotice({ text: `${selected.customerName}님 예약을 완료하고 문자를 대기열에 등록했어요.` });
  }

  return (
    <div className="px-4 py-6 md:px-6 md:py-8">
      <p className="mb-3 text-sm text-ink-soft">목 데이터로 확인 중이에요. 승인해도 실제 예약·지갑·문자는 바뀌지 않아요.</p>
      {notice && (
        <p role={notice.conflict ? 'alert' : 'status'} className={cn(
          'mb-4 rounded-lg border px-4 py-3 text-sm',
          notice.conflict ? 'border-line bg-[var(--seed-color-bg-critical-weak)] text-critical-text' : 'border-line bg-neutral-weak text-ink',
        )}>{notice.text}</p>
      )}
      <div className="grid overflow-hidden rounded-xl border border-line md:grid-cols-[minmax(16rem,24rem)_minmax(0,1fr)]">
        <section aria-labelledby="completion-queue-heading" className="border-b border-line md:border-r md:border-b-0">
          <header className="flex items-baseline justify-between gap-2 px-4 py-4 md:px-5">
            <h1 id="completion-queue-heading" className="text-xl font-bold tracking-tight">내가 허가할 일</h1>
            <span aria-label="대기 카드 수" className="text-sm font-semibold text-ink-soft">{cards.length}건</span>
          </header>
          {cards.length === 0 ? <EmptyState title="대기 중인 완료 카드가 없어요" /> : (
            <ul className="divide-y divide-line border-t border-line">
              {cards.map((card) => (
                <li key={card.id}>
                  <button type="button" aria-current={card.id === selectedId ? 'true' : undefined}
                    onClick={() => select(card.id)}
                    className={cn('flex w-full items-center justify-between gap-3 px-4 py-4 text-left hover:bg-neutral-weak md:px-5',
                      card.id === selectedId && 'bg-cal-appt')}>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-brand-text">종료 5분 전 자동 준비</span>
                      <span className="mt-1 block text-base font-bold">{card.customerName} · {card.menuName}</span>
                      <span className="mt-1 block text-sm text-ink-soft">{deductionText(card.deduction)}</span>
                    </span>
                    <ChevronRight aria-hidden className="size-4 shrink-0 text-ink-soft" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {selected && (
          <section aria-labelledby="completion-detail-heading" className="min-w-0 px-4 py-5 md:px-7 md:py-6">
            <h2 id="completion-detail-heading" className="text-2xl font-bold tracking-tight">{selected.customerName}</h2>
            <p className="mt-1 flex items-center gap-2 text-sm text-ink-soft">
              <Clock3 aria-hidden className="size-4" />
              <time dateTime={selected.appointmentStartAt}>{time.format(new Date(selected.appointmentStartAt))}</time>
              <span>{selected.menuName}</span>
            </p>
            <div className="mt-6 border-t border-line py-4">
              <h3 className="text-sm font-bold">차감 내역</h3>
              <p className="mt-1 text-lg font-semibold">{deductionText(preview?.deduction ?? selected.deduction)}</p>
            </div>
            <div className="border-t border-line py-4">
              <h3 className="mb-3 text-sm font-bold">사후 문자</h3>
              {preview ? (
                <div className="rounded-lg bg-neutral-weak p-4">
                  <p className="break-words text-sm leading-relaxed">{preview.renderedPreview}</p>
                  <p className="mt-2 text-xs text-ink-soft">{preview.messageType} · {preview.byteLength}바이트</p>
                </div>
              ) : (
                <ActionButton variant="neutralWeak" size="medium" onClick={() => {
                  setPreview(mockPreview(selected));
                  setNotice(null);
                }}>문자 미리 보기</ActionButton>
              )}
            </div>
            <div className="flex justify-start border-t border-line pt-4 md:justify-end">
              <ActionButton variant="brandSolid" size="medium" disabled={!preview?.valid} onClick={approve}>
                허가하고 문자 보내기
              </ActionButton>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
