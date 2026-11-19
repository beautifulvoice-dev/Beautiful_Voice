export interface HealthResponse {
  status: 'ok';
}

// 공통 API 규약 (F-05, 02-architecture §4 "공통 규약"). 모든 오류 응답 본문은 이 형태다.
export type CommonErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INTERNAL_ERROR'
  | 'INVALID_IDEMPOTENCY_KEY'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'INVALID_CURSOR'
  | 'INVALID_LIMIT';

export interface ErrorResponse<Code extends string = CommonErrorCode> {
  code: Code;
  // 사람이 읽는 설명. 개인정보(이름·전화번호·전사문)를 넣지 않는다.
  message: string;
  // 기계가 읽는 부가 정보(예: 잘못된 필드 목록). 없으면 빈 객체.
  details: Record<string, unknown>;
}

// 목록 응답. nextCursor가 null이면 마지막 페이지다.
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}


export interface OwnerSessionResponse {
  shopId: string;
}

export interface OwnerShopResponse {
  id: string;
  name: string;
}
