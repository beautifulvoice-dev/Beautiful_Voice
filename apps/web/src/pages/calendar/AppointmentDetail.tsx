// 예약 카드를 누르면 뜨는 상세: 고객·시간·메뉴·담당자·상태·메모(BEA-175 "누르면 메모가 보인다").
// 수정·상태 정정 버튼은 예약 쓰기(BEA-160·178) 때 붙인다.
import { Dialog } from 'radix-ui';
import { Button } from '@/components/ui/button';
import { appointmentTimeText, shopDate, STATUS_TEXT, type CalendarAppointment } from '@/features/calendar/model';

interface Props {
  appointment: CalendarAppointment | null;
  staffName: string;
  onClose: () => void;
}

export function AppointmentDetail({ appointment: a, staffName, onClose }: Props) {
  return (
    <Dialog.Root open={a !== null} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-20 bg-black/40" />
        <Dialog.Content className="fixed inset-x-4 top-1/4 z-30 mx-auto flex max-w-sm flex-col gap-3 rounded-lg bg-background p-5 shadow-lg">
          {a && (
            <>
              <Dialog.Title className="text-lg font-semibold">{a.customerName}</Dialog.Title>
              <Dialog.Description className="text-sm text-muted-foreground">
                {shopDate(Date.parse(a.startAt))} {appointmentTimeText(a)}
              </Dialog.Description>
              <dl className="grid grid-cols-[4rem_1fr] gap-y-1 text-sm">
                <dt className="text-muted-foreground">메뉴</dt>
                <dd>{a.menuName ?? '메뉴 없음'}</dd>
                <dt className="text-muted-foreground">담당자</dt>
                <dd>{staffName}</dd>
                <dt className="text-muted-foreground">상태</dt>
                <dd>{STATUS_TEXT[a.status]}</dd>
                <dt className="text-muted-foreground">메모</dt>
                <dd className="whitespace-pre-wrap">{a.memo ?? '메모 없음'}</dd>
              </dl>
              <Dialog.Close asChild>
                <Button variant="outline">닫기</Button>
              </Dialog.Close>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
