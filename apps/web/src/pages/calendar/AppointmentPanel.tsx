// 예약 보기 W2 (화면 설계서 §5 W2): 폰은 아래 시트, 웹은 오른쪽 패널 — SEED ResponsiveSidePanel이 md(768px)에서 바꾼다.
// 웹 패널은 격자를 가리지 않도록 모달이 아니게 열고, 캘린더 화면이 패널만큼 오른쪽을 비운다(CalendarPage).
// 상태 버튼(완료·노쇼·문자·더보기·상태 고치기)은 자리만 두고 꺼 둔다 — 동작은 예약 상태 API(BEA-178) PR에서(설계 D3).
import { ActionButton, Badge, Callout, ResponsiveSidePanel } from '@seed-design/react';
import { useIsPhone } from '@/lib/useLayout';
import {
  appointmentPanelTime,
  overlappingBlocks,
  shopTime,
  STATUS_TEXT,
  type CalendarAppointment,
  type CalendarBlock,
} from '@/features/calendar/model';
import { STATUS_TONE } from './styles';

/** 웹 패널 폭. 캘린더 화면이 이만큼 오른쪽을 비운다. */
export const PANEL_WIDTH = 400;

interface Props {
  appointment: CalendarAppointment | null;
  staffName: string;
  blocks: readonly CalendarBlock[];
  onClose: () => void;
}

export function AppointmentPanel({ appointment: a, staffName, blocks, onClose }: Props) {
  const phone = useIsPhone();
  return (
    <ResponsiveSidePanel.Root
      open={a !== null}
      onOpenChange={(open) => !open && onClose()}
      sidePanelRootProps={{ modal: false, closeOnInteractOutside: false }}
    >
      {/* 웹 패널은 머리줄 아래부터 시작한다 — index.css의 .seed-side-panel__positioner(Positioner는 className을 받지 않음) */}
      {/* 폰 시트만 뒤를 어둡게 — 웹 패널은 격자를 보며 쓰므로 배경막 없음 */}
      {phone && <ResponsiveSidePanel.Backdrop />}
      <ResponsiveSidePanel.Positioner>
        <ResponsiveSidePanel.Content width={`${PANEL_WIDTH}px`} maxWidth="full">
          {a && <Body a={a} staffName={staffName} blocks={blocks} />}
        </ResponsiveSidePanel.Content>
      </ResponsiveSidePanel.Positioner>
    </ResponsiveSidePanel.Root>
  );
}

function Body({ a, staffName, blocks }: { a: CalendarAppointment; staffName: string; blocks: readonly CalendarBlock[] }) {
  const [time, prep] = appointmentPanelTime(a);
  const overlaps = overlappingBlocks(a, blocks);
  const scheduled = a.status === 'scheduled';
  return (
    <>
      <ResponsiveSidePanel.Header>
        <div className="flex flex-col items-start gap-2 pt-2">
          {/* 제목은 SEED가 좌우 여백을 주므로 배지만 같은 여백(16px)을 준다 */}
          <span className="px-4">
            <Badge.Root tone={STATUS_TONE[a.status] ?? 'neutral'} variant="weak" size="large">
              <Badge.Label>{STATUS_TEXT[a.status]}</Badge.Label>
            </Badge.Root>
          </span>
          {/* ASSUMPTION: 고객 상세(W6)로 가는 연결은 캘린더 API가 customerId를 주면 붙인다(지금 가짜 데이터엔 없음). */}
          <ResponsiveSidePanel.Title>{a.customerName}</ResponsiveSidePanel.Title>
        </div>
        <ResponsiveSidePanel.CloseButton aria-label="닫기">×</ResponsiveSidePanel.CloseButton>
      </ResponsiveSidePanel.Header>
      <ResponsiveSidePanel.Body>
        <div className="flex flex-col gap-4 pb-4">
          <div>
            <p className="text-lg font-semibold">{time}</p>
            {prep && <p className="text-sm text-ink-soft">{prep}</p>}
          </div>
          <dl className="grid grid-cols-[4rem_1fr] gap-y-2 text-sm">
            <dt className="text-ink-soft">메뉴</dt>
            <dd>{a.menuName ?? '메뉴 없음'}</dd>
            <dt className="text-ink-soft">담당자</dt>
            <dd>{staffName}</dd>
            <dt className="text-ink-soft">메모</dt>
            <dd className="whitespace-pre-wrap">{a.memo ?? '메모 없음'}</dd>
          </dl>
          {overlaps.map((b) => (
            // 결정 R50: 관리 불가와 겹쳐도 예약은 그대로 두고 알린다.
            <Callout.Root key={b.id} tone="critical">
              <Callout.Content>
                <Callout.Description>
                  관리 불가 시간({shopTime(b.startAt)}–{shopTime(b.endAt)}
                  {b.memo ? ` ${b.memo}` : ''})과 겹쳐요. 예약은 그대로 있어요.
                </Callout.Description>
              </Callout.Content>
            </Callout.Root>
          ))}
        </div>
      </ResponsiveSidePanel.Body>
      <ResponsiveSidePanel.Footer>
        <div className="flex w-full flex-col gap-2">
          <div className="flex gap-2" aria-describedby="appointment-actions-note">
            {scheduled ? (
              <>
                <ActionButton variant="brandSolid" size="large" disabled flexGrow={1}>
                  완료
                </ActionButton>
                <ActionButton variant="neutralWeak" size="large" disabled>
                  노쇼
                </ActionButton>
                <ActionButton variant="neutralWeak" size="large" disabled>
                  문자 보내기
                </ActionButton>
                {/* 더보기(바꾸기·예약 취소)도 상태 API와 함께 연다 */}
                <ActionButton variant="ghost" size="large" disabled aria-label="더보기">
                  ⋯
                </ActionButton>
              </>
            ) : (
              <ActionButton variant="neutralWeak" size="large" disabled flexGrow={1}>
                상태 고치기
              </ActionButton>
            )}
          </div>
          <p id="appointment-actions-note" className="text-sm text-ink-soft">
            예약 상태 바꾸기는 예약 저장 기능과 함께 열려요.
          </p>
        </div>
      </ResponsiveSidePanel.Footer>
    </>
  );
}
