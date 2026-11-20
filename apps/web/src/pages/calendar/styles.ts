// 캘린더 조각 모양. 색만으로 구분하지 않도록 관리는 진한 면, 준비·차단은 서로 다른 빗금을 쓴다.
/** 관리 = 진한 색, 준비 = 옅은 빗금, 차단 = 회색 빗금. */
export const KIND_CLASS = {
  care: 'bg-sky-600 text-white',
  prep: 'bg-sky-100 bg-[repeating-linear-gradient(135deg,transparent_0_4px,rgb(2_132_199/0.25)_4px_6px)]',
  block: 'bg-zinc-200 bg-[repeating-linear-gradient(45deg,transparent_0_6px,rgb(0_0_0/0.12)_6px_8px)] text-zinc-700',
} as const;
