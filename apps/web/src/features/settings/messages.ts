// 설정 화면 문구. 오류 코드·저장 값 이름(weekly 등)을 원장에게 그대로 보이지 않는다(디자인 정책 원칙).
import type { Closure } from '@bv/contracts';
import type { SettingsErrorCode } from '@bv/scheduling/shop-settings';
import type { FormErrorCode, FormField } from './api';

export const WEEKDAY_TEXT = { 1: '월', 2: '화', 3: '수', 4: '목', 5: '금', 6: '토', 7: '일' } as const;
export type Weekday = keyof typeof WEEKDAY_TEXT;

export const SETTINGS_ERROR_TEXT: Record<SettingsErrorCode, string> = {
  INVALID_SHAPE: '입력 모양이 맞지 않아요. 다시 시도해 주세요.',
  INVALID_WEEKDAY: '요일을 다시 골라 주세요.',
  INVALID_TIME: '시각을 다시 골라 주세요.',
  OPEN_NOT_BEFORE_CLOSE: '여는 시각이 닫는 시각보다 빨라야 해요.',
  WINDOWS_OVERLAP: '같은 요일의 영업 시간이 겹쳐요.',
  INVALID_DATE: '날짜를 다시 골라 주세요.',
  START_AFTER_END: '시작일이 끝나는 날보다 늦어요.',
};

/** 칸마다 다른 문구. 메뉴·담당자·매장 안내 정보 공통. */
export function fieldErrorText(field: FormField, code: FormErrorCode): string {
  if (code === 'NAME_REQUIRED') return '이름을 입력해 주세요.';
  if (code === 'INVALID_URL') return '웹 주소로 적어 주세요. 예: https://naver.me/…';
  if (code === 'INVALID_TEXT') return '글을 다시 적어 주세요.';
  return field === 'defaultPrepMin' ? '준비 시간은 0분 이상 숫자로 입력해 주세요.' : '관리 시간은 1분 이상 숫자로 입력해 주세요.';
}

export const CONFLICT_TEXT = '다른 곳에서 먼저 고쳤어요. 다시 불러온 뒤 고쳐 주세요.';

/** 휴무 한 줄 설명. 예: "매주 월요일", "12월 24일 ~ 12월 26일 · 연말 휴가". */
export function closureText(c: Closure): string {
  const base =
    c.kind === 'weekly'
      ? `매주 ${WEEKDAY_TEXT[c.weekday]}요일`
      : c.startDate === c.endDate
        ? dateText(c.startDate)
        : `${dateText(c.startDate)} ~ ${dateText(c.endDate)}`;
  return c.note ? `${base} · ${c.note}` : base;
}

/** "2026-12-24" → "12월 24일". 날짜 문자열을 그대로 읽어 시간대에 흔들리지 않게 한다. */
function dateText(ymd: string): string {
  const [, m, d] = ymd.split('-').map(Number);
  return `${m}월 ${d}일`;
}

/** 마지막 담당자 숨기기 버튼 옆 안내. */
export const LAST_STAFF_TEXT = '예약에는 담당자가 꼭 필요해서, 마지막 담당자는 숨길 수 없어요.';

/** 메뉴 준비 시간 칸 아래 안내. 준비 시간은 관리 시작 전에 붙는다(BEA-155 ERD: 14:00 관리 + 준비 20분 → 13:40부터 점유). */
export const PREP_HELP_TEXT = '관리 시작 전에 비워 둘 시간이에요. 예) 14:00 관리, 준비 20분 → 13:40부터 다른 예약을 받지 않아요.';
