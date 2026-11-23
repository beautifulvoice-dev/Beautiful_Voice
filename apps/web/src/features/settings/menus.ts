// 메뉴 화면이 쓰는 문구·값 바꾸기(BEA-167). 메뉴는 이름·기본 관리 시간·기본 준비 시간만 있다(명세 3 2A-1.3, 가격 없음).
// 기본 시간은 예약을 넣을 때 미리 채우는 값이다(명세 1 §2.2, 결정 S3).
import type { Menu } from '@bv/contracts';

/** 시간 고르기(QuantityPicker) 범위. start = "정하기"를 눌렀을 때 처음 값. */
export interface MinutesRange {
  min: number;
  max: number;
  step: number;
  start: number;
}
/** ASSUMPTION: 명세에 없는 화면 값. 관리 5분~8시간, 준비 0~2시간, 5분 간격. 처음 값은 흔한 60분·10분. */
export const DURATION_RANGE: MinutesRange = { min: 5, max: 480, step: 5, start: 60 };
export const PREP_RANGE: MinutesRange = { min: 0, max: 120, step: 5, start: 10 };

/** 목록 한 줄의 시간 설명. 예: "관리 60분 · 준비 10분", "관리 50분", "시간 안 정함". */
export function menuTimeText(m: Pick<Menu, 'defaultDurationMin' | 'defaultPrepMin'>): string {
  const parts: string[] = [];
  if (m.defaultDurationMin !== null) parts.push(`관리 ${m.defaultDurationMin}분`);
  if (m.defaultPrepMin !== null) parts.push(`준비 ${m.defaultPrepMin}분`);
  return parts.length ? parts.join(' · ') : '시간 안 정함';
}
