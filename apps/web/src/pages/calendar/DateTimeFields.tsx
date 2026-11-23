// 예약 넣기(W3)의 날짜·시작 칸(설계서 W3 "SEED 날짜·시각 고르기, 15분 간격", 11/22 옵마 결정): 키보드로 치지 않고 누르기만.
// 날짜 = 달력 팝업(SEED DatePicker). 시작 = 영업시간 안 15분 목록 — 폰은 SEED WheelPicker, 웹은 펼치는 목록(SEED Select).
import { ActionButton, DatePicker, Popover, Select, WheelPicker } from '@seed-design/react';
import { CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, Clock } from 'lucide-react';
import { useRef, useState, type RefObject } from 'react';
import { shortDate } from '@/features/calendar/bookingText';
import { cn } from '@/lib/utils';

/** 입력 칸처럼 보이는 누르는 칸(SEED TextField large와 같은 높이·테두리). */
const fieldButton =
  'flex h-[52px] w-full items-center justify-between gap-2 rounded-[10px] border border-control-line bg-surface px-4 text-left text-base tabular-nums';

const toPicker = (iso: string) => ({ year: Number(iso.slice(0, 4)), month: Number(iso.slice(5, 7)), day: Number(iso.slice(8, 10)) });
const fromPicker = (d: { year: number; month: number; day: number }) =>
  `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;

export function DateField({
  id,
  value,
  onChange,
  popoverContainer,
}: {
  id: string;
  value: string;
  onChange: (date: string) => void;
  popoverContainer?: RefObject<HTMLDivElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const headerRef = useRef<HTMLDivElement>(null);
  const selectedDate = toPicker(value);
  const dateLabel = `${selectedDate.year}년 ${shortDate(value)}`;
  return (
    <Popover.Root open={open} onOpenChange={setOpen} placement="bottom-start" flip={false}>
      <Popover.Trigger asChild>
        <button id={id} type="button" className={fieldButton} aria-label={`날짜 ${dateLabel} · 달력 열기`}>
          <span className="grid min-w-0 leading-tight">
            <span className="text-sm text-ink-soft">{selectedDate.year}년</span>
            <span>{shortDate(value)}</span>
          </span>
          <CalendarDays aria-hidden size={20} className="shrink-0 text-ink-soft" />
        </button>
      </Popover.Trigger>
      {open && (
        <Popover.Positioner container={popoverContainer}>
          <Popover.Content className="w-[320px] max-w-[calc(100vw-32px)] overflow-y-auto overscroll-contain p-3">
            <DatePicker.Root
              value={selectedDate}
              defaultViewDate={selectedDate}
              onValueChange={(d) => {
                onChange(fromPicker(d));
                setOpen(false);
              }}
              locale="ko-KR"
              weekStartsOn={1}
              visibleRange="month"
              className="shrink-0 [&>[data-wheel-open]]:hidden [&>[class*='wheelContainer']]:static"
            >
              <DatePicker.Header ref={headerRef} leftIcon={<ChevronLeft />} rightIcon={<ChevronRight />} headerIcon={<ChevronDown />} />
              <DatePicker.Calendar leftIcon={<ChevronLeft />} rightIcon={<ChevronRight />} />
              <DatePicker.Wheel>
                {({ rootProps, columns }) => (
                  <div className="grid w-full gap-2">
                    <WheelPicker.Root {...rootProps} itemSize={40} visibleItemCount={5} scrollFogSize={56}>
                      {columns.map(({ id, ...column }) => <WheelPicker.Column key={id} {...column} />)}
                    </WheelPicker.Root>
                    <ActionButton
                      variant="brandSolid"
                      size="medium"
                      onClick={() => {
                        // SEED는 제목 버튼을 닫을 때 휠의 연·월을 달력에 반영한다.
                        const heading = headerRef.current?.querySelector<HTMLButtonElement>('button[aria-expanded="true"]');
                        heading?.click();
                        heading?.focus();
                      }}
                    >
                      완료
                    </ActionButton>
                  </div>
                )}
              </DatePicker.Wheel>
            </DatePicker.Root>
          </Popover.Content>
        </Popover.Positioner>
      )}
    </Popover.Root>
  );
}

export function TimeField({
  id,
  value,
  options,
  onChange,
  phone,
}: {
  id: string;
  value: string;
  options: readonly string[];
  onChange: (time: string) => void;
  phone: boolean;
}) {
  const [open, setOpen] = useState(false);
  // 빈 칸 누르기로 들어온 시각이 목록에 없으면(영업시간 밖 등) 그대로 보이도록 끼워 넣는다 — 저장 때 거부 문구가 나온다.
  const list = value === '' || options.includes(value) ? options : [...options, value].sort();
  // 빈 값 = `+ 예약`으로 열어 아직 시각을 안 고름(설계 06 D1). 자리 글자를 보이고, 목록에서 골라야 채워진다.
  const shown = value || '시각 고르기';
  if (phone) {
    return (
      <Popover.Root
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          // 휠은 늘 한 칸을 가리키므로, 빈 값에서 열면 처음 보이는 시각을 고른 것으로 한다.
          if (next && !value && list[0]) onChange(list[0]);
        }}
        placement="bottom-end"
      >
        <Popover.Trigger asChild>
          <button id={id} type="button" className={fieldButton} aria-label={value ? `시작 ${value} · 시각 고르기` : '시작 · 시각 고르기'}>
            <span className={cn(!value && 'text-ink-soft')}>{shown}</span>
            <Clock aria-hidden size={20} className="shrink-0 text-ink-soft" />
          </button>
        </Popover.Trigger>
        <Popover.Positioner>
          <Popover.Content className="w-[180px] p-2">
            <WheelPicker.Root aria-label="시작 시각">
              <WheelPicker.Column options={list.map((t) => ({ value: t, label: t }))} value={value} onValueChange={(v) => onChange(v)} />
            </WheelPicker.Root>
          </Popover.Content>
        </Popover.Positioner>
      </Popover.Root>
    );
  }
  return (
    <Select.Root value={value ? [value] : []} onValueChange={(v) => v[0] && onChange(v[0])}>
      <Select.Trigger id={id} aria-label={value ? `시작 ${value}` : '시작 · 시각 고르기'} className={cn(fieldButton, 'justify-between')}>
        {value ? <Select.Value>{value}</Select.Value> : <Select.Placeholder className="text-ink-soft">{shown}</Select.Placeholder>}
        <ChevronDown aria-hidden size={20} className="shrink-0 text-ink-soft" />
      </Select.Trigger>
      <Select.Positioner>
        <Select.Content className="max-h-[280px] overflow-y-auto">
          {list.map((t) => (
            <Select.Item key={t} value={t}>
              <Select.ItemLabel>{t}</Select.ItemLabel>
              <Select.ItemIndicator selected={<Check />} />
            </Select.Item>
          ))}
        </Select.Content>
      </Select.Positioner>
    </Select.Root>
  );
}
