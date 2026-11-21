// 설정 화면이 버튼을 막을지 판단하는 규칙. 서버 계약(#42)에는 아직 없는 화면 쪽 안전장치다.
import type { Staff } from '@bv/contracts';

/**
 * 담당자를 숨겨도 되는가. 예약에는 담당자가 꼭 있어야 하므로(BEA-155 ERD, 계약 staffId 필수)
 * 사용 중인 담당자가 이 사람 1명뿐이면 숨길 수 없다.
 * ASSUMPTION: 화면에서만 막는다. 서버도 같은 규칙을 둘지는 옵마에게 제안한다(계약에 오류 코드 없음).
 */
export function canHideStaff(staff: readonly Staff[], id: string): boolean {
  const target = staff.find((s) => s.id === id);
  if (!target?.active) return false;
  return staff.some((s) => s.active && s.id !== id);
}
