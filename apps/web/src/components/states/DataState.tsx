// 공통 "데이터 없음 / 불러오기 실패" 상태 (P2-01, 분해표 C-10).
// 두 상태는 원장이 바로 구분할 수 있어야 한다 — 없음은 안내, 실패는 경고와 다시 시도.
import { CircleAlert, Inbox } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';

interface EmptyStateProps {
  title: string;
  description?: string;
  /** 예: "고객 등록" 버튼 */
  action?: ReactNode;
}

export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <section
      data-state="empty"
      className="flex flex-col items-center gap-3 px-6 py-12 text-center"
    >
      <Inbox aria-hidden className="size-10 text-muted-foreground" />
      <h2 className="text-base font-semibold">{title}</h2>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
      {action}
    </section>
  );
}

interface ErrorStateProps {
  title?: string;
  description?: string;
  onRetry?: () => void;
}

export function ErrorState({
  title = '불러오지 못했어요',
  description = '인터넷 연결을 확인한 뒤 다시 시도해 주세요.',
  onRetry,
}: ErrorStateProps) {
  return (
    <section
      role="alert"
      data-state="error"
      className="flex flex-col items-center gap-3 px-6 py-12 text-center"
    >
      <CircleAlert aria-hidden className="size-10 text-destructive" />
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="text-sm text-muted-foreground">{description}</p>
      {onRetry && (
        <Button variant="outline" onClick={onRetry}>
          다시 시도
        </Button>
      )}
    </section>
  );
}
